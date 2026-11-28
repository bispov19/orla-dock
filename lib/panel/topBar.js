// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// panel/topBar.js — esconde a barra de cima do GNOME no modo Painel.
//
// Os itens dela (relógio, configurações rápidas, bandeja) passam a morar
// na barra de tarefas; a barra de cima em si só ocuparia espaço. Esconder
// o panelBox (a "caixa" que segura a barra) também libera o espaço que ela
// reservava: as janelas maximizadas sobem até o topo da tela.
//
// O próprio GNOME mostra o panelBox de novo em algumas situações (ex.: ao
// sair da tela cheia). Por isso vigiamos a visibilidade e escondemos de
// novo enquanto o modo Painel estiver ligado.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelSlot} from './panelSlot.js';

export class TopBar {
    constructor() {
        this._slot = null;
    }

    hide() {
        if (this._slot)
            return;
        const box = Main.layoutManager.panelBox;
        this._slot = new PanelSlot();
        this._slot.set(box, {visible: false});
        this._slot.connect(box, 'notify::visible', () => {
            if (box.visible)
                box.visible = false;
        });
    }

    show() {
        this._slot?.restore();
        this._slot = null;
    }
}
