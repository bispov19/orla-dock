// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// extension.js — ponto de entrada da Orla Dock.
//
// O GNOME Shell importa este arquivo como um módulo ES e procura o
// "export default": uma classe que estende Extension. Depois disso ele chama:
//   - enable():  quando a extensão é ativada (login, desbloqueio de tela,
//                ou quando você liga a extensão);
//   - disable(): quando é desativada (logout, BLOQUEIO DE TELA, ou quando
//                você desliga a extensão).
//
// Regra de ouro (exigida na revisão do extensions.gnome.org):
//   tudo que o enable() cria, o disable() destrói. Atores, sinais, timeouts…
//   Como o disable() roda toda vez que a tela é bloqueada, qualquer vazamento
//   se acumula ao longo do dia.
//
// Este arquivo é propositalmente pequeno: todo o trabalho fica no
// DockManager (lib/dockManager.js), que por sua vez destrói em cascata
// tudo o que criou. Repare também que nada é feito "solto" no topo do
// módulo — só imports.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DockManager} from './lib/dockManager.js';
import {WobblyWindows} from './lib/wobbly.js';

export default class OrlaDockExtension extends Extension {
    enable() {
        this._manager = new DockManager(this);
        // Janelas balançando: independente da dock (nem sabe que ela existe).
        this._wobbly = new WobblyWindows(this.getSettings());
    }

    disable() {
        this._wobbly?.destroy();
        this._wobbly = null;
        this._manager?.destroy();
        this._manager = null;
    }
}
