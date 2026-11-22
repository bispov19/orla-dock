// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// fileClipboard.js — copia ARQUIVOS para a área de transferência.
//
// No Wayland o Shell não consegue entregar um arquivo ARRASTADO para a
// janela de outro app (só apps iniciam esse tipo de arraste). Então, ao
// soltar um arquivo do leque sobre uma janela, copiamos o arquivo e a
// pessoa cola com Ctrl+V.
//
// Cada app procura o arquivo copiado num "tipo" (mimetype) diferente:
//   - x-special/gnome-copied-files → gerenciadores de arquivos (Nautilus…);
//     testado: o Nautilus SÓ cola arquivo neste formato;
//   - text/uri-list → o formato padrão de lista de arquivos, que os demais
//     apps (navegadores, Electron) leem.
//
// O ideal seria oferecer os dois de uma vez, mas a área de transferência
// do Shell (St.Clipboard) guarda um tipo por vez, e o GJS não permite
// implementar em JavaScript a fonte do Mutter que ofereceria vários (ela
// usa funções assíncronas em C). Por isso escolhemos pelo app de destino.

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

const FILE_MANAGERS = /nautilus|nemo|thunar|dolphin|pcmanfm|caja|org\.gnome\.files/i;

/** A janela é de um gerenciador de arquivos? */
export function isFileManager(win) {
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    return FILE_MANAGERS.test(`${app?.get_id() ?? ''} ${win.get_wm_class() ?? ''}`);
}

/**
 * Põe os arquivos na área de transferência (o mesmo que Ctrl+C).
 *
 * @param {Gio.File[]} files
 * @param {object} [options]
 * @param {boolean} [options.fileManager] - formato do Nautilus (colar
 *   como arquivo numa pasta) em vez de text/uri-list
 */
export function copyFiles(files, {fileManager = true} = {}) {
    const uris = files.map(f => f.get_uri());
    const [mimetype, text] = fileManager
        ? ['x-special/gnome-copied-files', `copy\n${uris.join('\n')}`]
        // text/uri-list pede uma URI por linha, terminada em CRLF.
        : ['text/uri-list', `${uris.join('\r\n')}\r\n`];
    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mimetype,
        new GLib.Bytes(new TextEncoder().encode(text)));
}
