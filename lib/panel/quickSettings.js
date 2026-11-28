// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// panel/quickSettings.js — as configurações rápidas do GNOME (Wi-Fi, som,
// bateria…) dentro da barra de tarefas.
//
// Como o relógio, o botão do GNOME é MOVIDO para a barra: o menu dele
// continua o mesmo. O visual dos ícones dentro da barra vem do
// stylesheet.css (classe orla-panel-box), e não de estilos aplicados ícone
// por ícone: assim os ícones que o GNOME acrescentar depois (ex.: ao ligar
// o Bluetooth) já entram com o tamanho certo.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelSlot} from './panelSlot.js';

export class QuickSettingsSlot {
    constructor() {
        this._slot = null;
        this._menu = null;
        this._originalArrow = null;
    }

    /**
     * @param {Clutter.Actor} box - onde o botão passa a morar
     * @param {St.Side} side - de que lado da tela fica a barra
     * @param {boolean} vertical - barra na esquerda/direita
     * @param {object} options
     * @param {boolean} options.hideSession - esconder bloquear/desligar (o
     *   Menu Iniciar já tem esses botões)
     * @param {Function} options.onResize - avisa a barra que o tamanho mudou
     */
    take(box, side, vertical, {hideSession = false, onResize = () => {}} = {}) {
        const quick = Main.panel.statusArea.quickSettings;
        if (!quick)
            return null;
        const slot = this._slot = new PanelSlot();

        slot.set(quick, {
            style: vertical ? 'padding: 6px 4px; border-radius: 8px;' : 'padding: 0 8px; border-radius: 8px;',
        });
        // Os ícones ficam lado a lado (ou um embaixo do outro na lateral).
        const icons = quick._indicators;
        if (icons) {
            slot.set(icons, {
                orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            });
        }
        if (hideSession)
            this._hideSessionButtons(quick);

        slot.move(quick.container, box);
        // Ícones que aparecem ou somem mudam a largura: a barra se reorganiza.
        slot.connect(quick.container, 'notify::width', onResize, 'notify::height', onResize);

        this._menu = quick.menu;
        const pointer = this._menu._boxPointer;
        this._originalArrow = pointer._arrowSide;
        pointer.updateArrowSide(side);
        return quick.container;
    }

    /** Bloquear e desligar ficam só no Menu Iniciar. */
    _hideSessionButtons(quick) {
        const item = quick._system?.quickSettingsItems?.[0];
        for (const button of [item?._lockItem, item?._shutdownItem]) {
            if (!button)
                continue;
            this._slot.set(button, {visible: false});
            this._slot.connect(button, 'notify::visible', () => {
                if (button.visible)
                    button.visible = false;
            });
        }
    }

    get isOpen() {
        return Boolean(this._menu?.isOpen);
    }

    release() {
        if (!this._slot)
            return;
        if (this._menu?.isOpen)
            this._menu.close();
        if (this._originalArrow !== null)
            this._menu?._boxPointer?.updateArrowSide(this._originalArrow);
        this._slot.restore();
        this._slot = null;
        this._menu = null;
        this._originalArrow = null;
    }
}
