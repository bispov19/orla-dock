// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// extension.js — ponto de entrada da Orla Dock.
//
// O GNOME Shell importa este arquivo como um módulo ES e procura o
// "export default": uma classe que estende Extension. Depois disso ele chama:
//   - enable():  quando a extensão é ativada (login ou quando você a liga);
//   - disable(): quando é desativada (logout ou quando você a desliga).
//
// Regra de ouro (exigida na revisão do extensions.gnome.org):
//   tudo que o enable() cria, o disable() destrói. Atores, sinais, timeouts…
//
// Tela bloqueada ("session-modes": ["user", "unlock-dialog"]):
//   a Orla NÃO é desligada ao bloquear. Ao entrar no modo de bloqueio, o
//   DockManager destrói as docks e devolve a barra superior; nada da Orla
//   aparece nem recebe teclado/mouse na tela de bloqueio. Ao desbloquear,
//   as docks voltam. Motivo: se a extensão fosse desligada, o Dash nativo
//   do GNOME voltaria e piscaria na tela a cada desbloqueio.
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

    // Note for reviewers — why "unlock-dialog" is in session-modes:
    // on lock, the DockManager destroys every dock (and the taskbar's Panel
    // mode, Start Menu and tray) and gives the top bar back, so nothing from
    // Orla Dock is shown or reactive on the lock screen; its keybinding is
    // registered for NORMAL and OVERVIEW only, and the wobbly-windows effect
    // only reacts to window moves, which cannot happen while locked. The
    // mode is kept so that unlocking does not flash GNOME's native Dash
    // before the extension is enabled again. disable() still destroys all.
    disable() {
        this._wobbly?.destroy();
        this._wobbly = null;
        this._manager?.destroy();
        this._manager = null;
    }
}
