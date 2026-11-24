// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/cache.js — caches do wavebar-music-pill: um mapa em memória com
// limite (o usado há mais tempo sai primeiro) e uma pasta em disco com
// limite de arquivos (os mais antigos são apagados). Tudo assíncrono: o
// Shell nunca espera o disco.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {listDir, readBytes} from '../files.js';

/** A pasta de cache da Orla: ~/.cache/orla-dock/music/<nome>. */
export function musicCacheDir(name) {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'orla-dock', 'music', name]);
}

export const isCancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;

function makeDir(dir) {
    return new Promise((resolve, reject) => {
        dir.make_directory_async(GLib.PRIORITY_LOW, null, (d, result) => {
            try {
                d.make_directory_finish(result);
                resolve();
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    resolve();
                else
                    reject(e);
            }
        });
    });
}

function writeBytes(file, bytes, cancellable) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable, (f, result) => {
                try {
                    f.replace_contents_finish(result);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function deleteFile(file) {
    return new Promise(resolve => {
        file.delete_async(GLib.PRIORITY_LOW, null, (f, result) => {
            try {
                f.delete_finish(result);
            } catch {}
            resolve();
        });
    });
}

/** Map com tamanho máximo: passando do limite, sai o usado há mais tempo. */
export class LruMap {
    constructor(limit) {
        this._limit = limit;
        this._map = new Map();
    }

    has(key) {
        return this._map.has(key);
    }

    get(key) {
        if (!this._map.has(key))
            return undefined;
        const value = this._map.get(key);
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }

    set(key, value) {
        this._map.delete(key);
        this._map.set(key, value);
        if (this._map.size > this._limit)
            this._map.delete(this._map.keys().next().value);
    }

    clear() {
        this._map.clear();
    }
}

/** Pasta de cache: criada quando precisa, com no máximo `maxFiles` arquivos. */
export class DiskCache {
    constructor(path, maxFiles) {
        this._dir = Gio.File.new_for_path(path);
        this._maxFiles = maxFiles;
        this._ready = null;
    }

    /** O arquivo de uma chave (nome = SHA-256 da chave). */
    fileFor(key, extension = '') {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1);
        return this._dir.get_child(`${hash}${extension}`);
    }

    async read(file, cancellable = null) {
        try {
            return await readBytes(file, cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return null;
        }
    }

    async write(file, bytes, cancellable = null) {
        await this._ensure();
        await writeBytes(file, bytes, cancellable);
        return file.get_path();
    }

    /** Cria a pasta (e as de cima); na primeira vez, apaga o excesso. */
    _ensure() {
        this._ready ??= (async () => {
            const chain = [];
            for (let dir = this._dir; dir && !dir.equal(Gio.File.new_for_path(GLib.get_user_cache_dir())); dir = dir.get_parent())
                chain.unshift(dir);
            for (const dir of chain)
                await makeDir(dir);
            await this._prune().catch(e => console.log(`[Orla Dock] Limpeza do cache de música falhou: ${e.message}`));
        })();
        return this._ready;
    }

    async _prune() {
        const infos = await listDir(this._dir, 'standard::name,time::modified');
        if (infos.length <= this._maxFiles)
            return;
        const mtime = info => info.get_modification_date_time()?.to_unix() ?? 0;
        infos.sort((a, b) => mtime(b) - mtime(a));
        for (const info of infos.slice(this._maxFiles))
            await deleteFile(this._dir.get_child(info.get_name()));
    }

    /** Apaga tudo (botão "Limpar cache de letras"). */
    async clear() {
        let infos = [];
        try {
            infos = await listDir(this._dir, 'standard::name');
        } catch {
            return;
        }
        for (const info of infos)
            await deleteFile(this._dir.get_child(info.get_name()));
    }
}
