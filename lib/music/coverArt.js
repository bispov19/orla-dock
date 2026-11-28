// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// music/coverArt.js — capas de álbum (mpris:artUrl). Devolve sempre um
// arquivo LOCAL, que o CSS desenha com cantos arredondados:
//   file://   → o próprio arquivo (se existir)
//   data:     → decodificado e guardado em ~/.cache/orla-dock/music/covers/
//   http(s):// → baixado (Soup 3, assíncrono) e guardado no mesmo lugar
// A mesma capa não é baixada de novo: memória (url → caminho) e disco.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {readInfo} from '../files.js';
import {DiskCache, LruMap, isCancelled, musicCacheDir} from './cache.js';

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DISK_FILES = 300;
const MAX_MEMORY = 200;

async function exists(file) {
    try {
        await readInfo(file, 'standard::type');
        return true;
    } catch {
        return false;
    }
}

function sendAndRead(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_LOW, cancellable, (s, result) => {
            try {
                resolve(s.send_and_read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class CoverArtLoader {
    /** @param {Function} session - devolve a Soup.Session (criada só quando precisa) */
    constructor(session) {
        this._session = session;
        this._disk = new DiskCache(musicCacheDir('covers'), MAX_DISK_FILES);
        this._memory = new LruMap(MAX_MEMORY);
    }

    /** O caminho local da capa, ou null (sem capa / erro). */
    async load(url, cancellable) {
        if (!url)
            return null;
        if (this._memory.has(url))
            return this._memory.get(url);
        let path = null;
        try {
            if (url.startsWith('file://')) {
                const file = Gio.File.new_for_uri(url);
                path = await exists(file) ? file.get_path() : null;
            } else if (url.startsWith('data:')) {
                path = await this._fromData(url, cancellable);
            } else if (/^https?:\/\//i.test(url)) {
                path = await this._fromHttp(url, cancellable);
            }
        } catch (e) {
            if (isCancelled(e))
                throw e;
            console.log(`[Orla Dock] Capa indisponível (${url.slice(0, 60)}): ${e.message}`);
        }
        // Arquivo local pode mudar; falha de rede pode passar: não memoriza.
        if (path && !url.startsWith('file://'))
            this._memory.set(url, path);
        return path;
    }

    async _fromData(url, cancellable) {
        const file = this._disk.fileFor(url);
        if (await exists(file))
            return file.get_path();
        const comma = url.indexOf(',');
        if (comma < 0)
            throw new Error('URI data: malformada');
        const header = url.slice(5, comma);
        const payload = url.slice(comma + 1);
        const bytes = header.endsWith(';base64')
            ? GLib.base64_decode(decodeURIComponent(payload))
            : new TextEncoder().encode(decodeURIComponent(payload));
        return this._disk.write(file, new GLib.Bytes(bytes), cancellable);
    }

    async _fromHttp(url, cancellable) {
        const file = this._disk.fileFor(url);
        if (await exists(file))
            return file.get_path();
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error('URL inválida');
        const bytes = await sendAndRead(this._session(), message, cancellable);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()}`);
        const type = message.get_response_headers().get_content_type()[0] ?? '';
        if (!type.startsWith('image/'))
            throw new Error(`tipo inesperado: ${type}`);
        if (bytes.get_size() > MAX_DOWNLOAD_BYTES)
            throw new Error('imagem grande demais');
        return this._disk.write(file, bytes, cancellable);
    }

    destroy() {
        this._memory.clear();
        this._session = () => null;
    }
}
