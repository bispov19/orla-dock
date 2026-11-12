// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// autohide.js — ocultar/exibir automaticamente e "struts".
//
// Struts: um pedido ao gerenciador de janelas (Mutter) para reservar uma
// faixa da tela. Com a dock fixa, janelas maximizadas param acima dela.
// No GNOME Shell basta adicionar um ator com `affectsStruts: true` — o
// layoutManager calcula a faixa a partir da posição e tamanho dele.
//
// Auto-ocultar (estilo Mac): a dock desliza para fora da tela quando o
// cursor não está nela; encostar o cursor na borda faz ela voltar. A
// "zona quente" é um ator invisível de 1px na borda que detecta o cursor.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Position, Timeout} from './utils.js';

const SHOW_MS = 220;
const HIDE_MS = 260;
const CHECK_INTERVAL_MS = 250;
const HIDE_AFTER_CHECKS = 2;

export class Autohide {
    constructor(dock) {
        this._dock = dock;
        this._settings = dock.settings;
        this._shown = true;
        this._strutAdded = false;
        this._idleChecks = 0;
        this._check = new Timeout();

        this._hotZone = new Clutter.Actor({name: 'orlaHotZone', reactive: true, visible: false});
        Main.layoutManager.addChrome(this._hotZone, {trackFullscreen: true});
        this._hotZone.connect('enter-event', () => this.show());

        this._strut = new Clutter.Actor({name: 'orlaStrut', reactive: false});

        this._settings.connectObject('changed::autohide', () => this.sync(), this);
        Main.overview.connectObject(
            'showing', () => this.sync(),
            'hidden', () => this.sync(),
            this);
    }

    destroy() {
        this._check.cancel();
        this._settings.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._dock.root.remove_transition(this._dock.axis.crossTranslation);
        this._hotZone.destroy();
        if (this._strutAdded)
            Main.layoutManager.removeChrome(this._strut);
        this._strut.destroy();
    }

    get enabled() {
        return this._settings.get_boolean('autohide');
    }

    get shown() {
        return this._shown;
    }

    /** Reavalia tudo. Chamado sempre que algo relevante muda. */
    sync() {
        const geometry = this._dock.geometry;
        if (!geometry)
            return;
        this._syncStrut();
        this._placeHotZone();

        if (!this.enabled) {
            this._check.cancel();
            this.show();
            return;
        }
        if (this._mustStayVisible()) {
            this._idleChecks = 0;
            this.show();
        }
        this._startChecks();
    }

    _mustStayVisible() {
        return this._dock.hovered || this._dock.busy || Main.overview.visible ||
            this._pointerInDock();
    }

    /** O cursor está na faixa da dock (incluindo a margem até a borda)? */
    _pointerInDock() {
        const [px, py] = global.get_pointer();
        const {x, y, width, height} = this._dock.dockRect;
        return px >= x && px < x + width && py >= y && py < y + height;
    }

    // Enquanto visível no modo auto-ocultar, conferimos a cada 250 ms se
    // ainda deve ficar. É mais robusto do que depender só de eventos de
    // entrada/saída (que não chegam, por exemplo, quando um menu fecha).
    _startChecks() {
        if (this._check.active || !this._shown)
            return;
        this._check.startRepeating(CHECK_INTERVAL_MS, () => {
            if (!this.enabled || !this._shown)
                return false;
            if (this._mustStayVisible()) {
                this._idleChecks = 0;
                return true;
            }
            if (++this._idleChecks >= HIDE_AFTER_CHECKS) {
                this.hide();
                return false;
            }
            return true;
        });
    }

    show() {
        if (this._shown)
            return;
        this._shown = true;
        this._idleChecks = 0;
        this._hotZone.hide();
        this._dock.root.ease({
            [this._dock.axis.crossTranslation]: 0,
            duration: SHOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        if (this.enabled)
            this._startChecks();
    }

    hide() {
        if (!this._shown || !this.enabled)
            return;
        const g = this._dock.geometry;
        this._shown = false;
        this._check.cancel();
        this._dock.hidePreviews();
        // Desliza para fora: a distância é a espessura + margem.
        const distance = -this._dock.axis.awaySign * (g.thickness + g.margin + 4);
        this._dock.root.ease({
            [this._dock.axis.crossTranslation]: distance,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                if (!this._shown)
                    this._hotZone.show();
            },
        });
    }

    /** Alterna o auto-ocultar (atalho de teclado). */
    static toggle(settings) {
        settings.set_boolean('autohide', !settings.get_boolean('autohide'));
    }

    _placeHotZone() {
        const {x, y, width, height} = this._dock.dockRect;
        const axis = this._dock.axis;
        const [w, h] = axis.toXY(axis.vertical ? height : width, 1);
        let hx = x, hy = y;
        if (axis.position === Position.BOTTOM)
            hy = y + height - 1;
        else if (axis.position === Position.RIGHT)
            hx = x + width - 1;
        this._hotZone.set_position(hx, hy);
        this._hotZone.set_size(w, h);
    }

    _syncStrut() {
        const wanted = !this.enabled;
        if (wanted) {
            const {x, y, width, height} = this._dock.dockRect;
            this._strut.set_position(x, y);
            this._strut.set_size(width, height);
            if (!this._strutAdded) {
                Main.layoutManager.addChrome(this._strut, {affectsStruts: true});
                this._strutAdded = true;
            }
        } else if (this._strutAdded) {
            Main.layoutManager.removeChrome(this._strut);
            this._strutAdded = false;
        }
    }
}
