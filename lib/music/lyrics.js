// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/lyrics.js — letras sincronizadas do LRCLIB (https://lrclib.net), o
// mesmo provedor da Wavebar. Não precisa de chave; mandamos só título,
// artista, álbum e duração (e um User-Agent que identifica a extensão).
//
// Ordem da busca: /api/get (exata) → /api/search (título + artista) →
// /api/search?q= (texto livre) → "Artista - Música" à força (vídeos).
//
// Cache: memória + disco (~/.cache/orla-dock/music/lyrics/), por faixa,
// INCLUSIVE "não encontrada" (que vale 7 dias: a letra pode ser cadastrada
// depois). Erro de rede não é guardado: tenta de novo na próxima vez.
// Só pedimos à rede com o usuário tendo ligado a opção de letras.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {DiskCache, LruMap, isCancelled, musicCacheDir} from './cache.js';
import {cleanArtist, cleanTitle, forceSplitArtistTitle, pickBestResult, splitArtistTitle, toLyrics} from './lrc.js';

const API = 'https://lrclib.net/api';
const MAX_MEMORY = 100;
const MAX_DISK_FILES = 800;           // ~3 KB cada
const NOT_FOUND_TTL_S = 3 * 24 * 3600;   // "não achei" e "sem tempos" valem 3 dias:
                                         // a versão sincronizada pode ser cadastrada
// Mudou a forma de buscar: os resultados guardados antes desta versão
// (alguns da versão errada da música) são ignorados.
const CACHE_VERSION = 'v2';

/** Erro de rede/servidor (diferente de "não encontrada"). */
export class LyricsNetworkError extends Error {}

function sendAndRead(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
            try {
                resolve(s.send_and_read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class LyricsClient {
    /** @param {Function} session - devolve a Soup.Session (criada só quando precisa) */
    constructor(session) {
        this._session = session;
        this._disk = new DiskCache(musicCacheDir('lyrics'), MAX_DISK_FILES);
        this._memory = new LruMap(MAX_MEMORY);
    }

    /** Chave do cache: título + artista + álbum + duração (por faixa). */
    static keyFor({title, artists, album, length}) {
        const seconds = Math.round((length ?? 0) / 1e6);
        return [CACHE_VERSION, title, (artists ?? []).join(', '), album, seconds].join('␟').toLowerCase();
    }

    /**
     * @returns {Promise<object>} {kind: 'synced', lines} | {kind: 'plain'} |
     *   {kind: 'instrumental'} | {kind: 'not-found'}
     * @throws {LyricsNetworkError} sem rede/servidor fora; CANCELLED se cancelado
     */
    async fetch(track, cancellable) {
        if (!track.title)
            return {kind: 'not-found'};
        const key = LyricsClient.keyFor(track);
        if (this._memory.has(key))
            return this._memory.get(key);

        const file = this._disk.fileFor(key, '.json');
        let result = await this._readDisk(file, cancellable);
        if (!result) {
            const found = await this._lookup(track, cancellable);
            result = toLyrics(found?.record, {allowSynced: found?.durationMatch}) ?? {kind: 'not-found'};
            this._writeDisk(file, {...result, time: Math.floor(Date.now() / 1000)});
        }
        this._memory.set(key, result);
        return result;
    }

    async _lookup({title, artists, album, length}, cancellable) {
        const artist = artists?.[0] ?? '';
        const durationS = Math.round((length ?? 0) / 1e6);

        // 1) Busca exata (o LRCLIB confere a duração, ±2 s): primeiro como o
        //    player mandou, depois com o título limpo ("(with …)", "feat.",
        //    "- Remastered" fora) — sem o álbum, que costuma variar.
        if (artist) {
            const tries = [{title, album}];
            const clean = cleanTitle(title);
            const cleanArt = cleanArtist(artist);
            if (clean !== title || cleanArt !== artist)
                tries.push({title: clean, album: '', artist: cleanArt});
            for (const t of tries) {
                const params = {track_name: t.title, artist_name: t.artist ?? artist};
                if (t.album)
                    params.album_name = t.album;
                if (durationS > 0)
                    params.duration = String(durationS);
                const exact = await this._request('/get', params, cancellable);
                if (exact && toLyrics(exact))
                    return {record: exact, durationMatch: durationS > 0};
            }
        }

        const guess = splitArtistTitle(title, artist);
        const want = {...guess, durationS};
        const params = {track_name: guess.title};
        if (guess.artist)
            params.artist_name = guess.artist;
        const byFields = pickBestResult(await this._request('/search', params, cancellable), want);
        if (byFields?.durationMatch)
            return byFields;

        const byText = pickBestResult(await this._request('/search',
            {q: `${guess.artist} ${guess.title}`.trim()}, cancellable), want);
        if (byText?.durationMatch)
            return byText;

        const forced = forceSplitArtistTitle(title);
        let byForced = null;
        if (forced && (forced.artist !== guess.artist || forced.title !== guess.title)) {
            byForced = pickBestResult(await this._request('/search',
                {q: `${forced.artist} ${forced.title}`}, cancellable), {...forced, durationS});
            if (byForced?.durationMatch)
                return byForced;
        }
        // Só versões com outra duração: a sincronia estaria errada.
        return byFields ?? byText ?? byForced;
    }

    // O JSON, ou null em 404. Lança LyricsNetworkError nos outros erros.
    async _request(path, params, cancellable) {
        const message = Soup.Message.new_from_encoded_form('GET', `${API}${path}`, Soup.form_encode_hash(params));
        let bytes;
        try {
            bytes = await sendAndRead(this._session(), message, cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            throw new LyricsNetworkError(e.message);
        }
        const status = message.get_status();
        if (status === Soup.Status.NOT_FOUND)
            return null;
        if (status !== Soup.Status.OK)
            throw new LyricsNetworkError(`HTTP ${status}`);
        try {
            return JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            throw new LyricsNetworkError('resposta inválida');
        }
    }

    async _readDisk(file, cancellable) {
        const bytes = await this._disk.read(file, cancellable);
        if (!bytes)
            return null;
        try {
            const data = JSON.parse(new TextDecoder().decode(bytes));
            const age = Math.floor(Date.now() / 1000) - (data?.time ?? 0);
            if (data?.kind === 'not-found')
                return age < NOT_FOUND_TTL_S ? {kind: 'not-found'} : null;
            if (data?.kind === 'synced' && Array.isArray(data.lines))
                return {kind: 'synced', lines: data.lines};
            if (data?.kind === 'plain' && typeof data.text === 'string')
                return age < NOT_FOUND_TTL_S ? {kind: 'plain', text: data.text} : null;
            if (data?.kind === 'instrumental')
                return {kind: 'instrumental'};
        } catch {}
        return null;   // corrompido: busca de novo
    }

    async _writeDisk(file, result) {
        try {
            await this._disk.write(file, new GLib.Bytes(new TextEncoder().encode(JSON.stringify(result))));
        } catch (e) {
            console.log(`[Orla Dock] Não consegui salvar a letra no cache: ${e.message}`);
        }
    }

    /** Esquece tudo (memória e disco). */
    async clear() {
        this._memory.clear();
        await this._disk.clear();
    }

    destroy() {
        this._memory.clear();
        this._session = () => null;
    }
}

export {isCancelled};
