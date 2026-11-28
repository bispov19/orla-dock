// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// panel/dateMenu.js — o relógio do GNOME dentro da barra de tarefas.
//
// No monitor principal, o botão do relógio do GNOME (o que abre o
// calendário e as notificações) é levado para o fim da barra. O botão é o
// mesmo, então o calendário continua abrindo preso a ele; só trocamos o
// texto dele pelo nosso relógio de duas linhas (hora e data) e viramos a
// "setinha" do menu para o lado da barra.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelClock} from './clock.js';
import {PanelSlot} from './panelSlot.js';

export class DateMenuSlot {
    /** @param {Gio.Settings} settings - as configurações da Orla */
    constructor(settings) {
        this._settings = settings;
        this._slot = null;
        this._clock = null;
        this._menu = null;
        this._originalArrow = null;
    }

    /**
     * Leva o relógio do GNOME para `box`.
     *
     * @param {Clutter.Actor} box - onde ele passa a morar
     * @param {St.Side} side - de que lado da tela fica a barra
     * @param {boolean} vertical - barra na esquerda/direita
     * @returns {Clutter.Actor|null} o ator que foi para a barra
     */
    take(box, side, vertical) {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return null;
        const slot = this._slot = new PanelSlot();

        // O texto do GNOME some; o nosso relógio entra ao lado dele.
        const display = dateMenu._clockDisplay;
        slot.set(display, {visible: false});
        this._clock = new PanelClock(this._settings);
        this._clock.setVertical(vertical);
        display.get_parent().insert_child_above(this._clock, display);

        // A bolinha de "notificação nova" do GNOME fica escondida na barra.
        const dot = dateMenu._indicator;
        if (dot) {
            slot.set(dot, {visible: false});
            slot.connect(dot, 'notify::visible', () => {
                if (dot.visible)
                    dot.visible = false;
            });
        }

        slot.set(dateMenu, {
            style: vertical
                ? 'padding: 6px 4px; border-radius: 8px;'
                : 'padding: 0 8px; border-radius: 8px;',
        });
        slot.move(dateMenu.container, box);

        // O calendário abre em direção à barra (a setinha aponta para ela).
        this._menu = dateMenu.menu;
        const pointer = this._menu._boxPointer;
        this._originalArrow = pointer._arrowSide;
        pointer.updateArrowSide(side);
        return dateMenu.container;
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
        this._clock?.destroy();
        this._clock = null;
        this._slot.restore();
        this._slot = null;
        this._menu = null;
        this._originalArrow = null;
        // A bolinha volta a seguir as notificações.
        Main.panel.statusArea.dateMenu?._indicator?._sync?.();
    }
}

/** Botão de relógio dos monitores secundários: abre o mesmo calendário. */
export function secondaryClockButton(settings, vertical) {
    const clock = new PanelClock(settings);
    clock.setVertical(vertical);
    const button = new St.Button({
        style_class: 'panel-button orla-panel-clock-button',
        child: clock,
        can_focus: false,
        track_hover: true,
        style: vertical ? 'padding: 6px 4px; border-radius: 8px;' : 'padding: 0 8px; border-radius: 8px;',
    });
    button.connect('clicked', () => Main.panel.statusArea.dateMenu?.menu.toggle());
    return button;
}
