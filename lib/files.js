// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// files.js — leitura de arquivos e pastas SEM travar o Shell.
//
// As funções "_async" do Gio recebem um callback e terminam com uma
// função "_finish". Aqui cada uma vira uma Promise, para usar com await.
// (Não mexemos no Gio global com Gio._promisify: isso mudaria o Gio de
// todo o Shell e continuaria valendo depois do disable().)

import GLib from 'gi://GLib';

/** Conteúdo inteiro do arquivo (Uint8Array). */
export function readBytes(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (f, result) => {
            try {
                resolve(f.load_contents_finish(result)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Informações do arquivo (os atributos pedidos em `attributes`). */
export function readInfo(file, attributes, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.query_info_async(attributes, 0, GLib.PRIORITY_DEFAULT, cancellable, (f, result) => {
            try {
                resolve(f.query_info_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Lista o conteúdo de uma pasta, aos poucos (de `batch` em `batch`), e
 * devolve todos os Gio.FileInfo. A pasta é fechada no fim.
 */
export async function listDir(dir, attributes, {batch = 64, cancellable = null} = {}) {
    const enumerator = await new Promise((resolve, reject) => {
        dir.enumerate_children_async(attributes, 0, GLib.PRIORITY_LOW, cancellable, (d, result) => {
            try {
                resolve(d.enumerate_children_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    const all = [];
    try {
        for (;;) {
            const infos = await new Promise((resolve, reject) => {
                enumerator.next_files_async(batch, GLib.PRIORITY_LOW, cancellable, (en, result) => {
                    try {
                        resolve(en.next_files_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (!infos.length)
                break;
            all.push(...infos);
        }
    } finally {
        enumerator.close_async(GLib.PRIORITY_LOW, null, null);
    }
    return all;
}
