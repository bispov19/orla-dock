// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/glass.js — o vidro OPCIONAL do Menu Iniciar (desligado por padrão).
//
// Por que não o vidro "ao vivo" da dock: o desfoque ao vivo relê a tela
// atrás do menu. Quando só um pedacinho do menu é redesenhado (o destaque
// de um ícone sob o mouse), a tela em volta ainda é a do quadro anterior —
// com o próprio menu —, e o desfoque espalha esse menu velho: era o
// "rastro" embaixo dos ícones. Além disso, desfocar a cada quadro pesa em
// GPU integrada.
//
// Aqui o vidro desfoca o PAPEL DE PAREDE do monitor (o mesmo que o GNOME
// desenha, via BackgroundManager). Como o papel de parede não muda, o
// desfoque é calculado uma vez e reaproveitado (modo ACTOR do
// Shell.BlurEffect guarda o resultado); só é refeito quando o menu muda de
// lugar ou o papel de parede muda. Sem realimentação, sem rastro.
//
// O conteúdo do menu NÃO passa pelo efeito: o vidro é uma camada atrás
// dele (antes, o efeito na caixa inteira desbotava ícones e textos).

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

import {RoundedBlurEffect} from '../blur.js';

const BLUR_RADIUS = 48;

export class MenuGlass {
    constructor() {
        // A janela que mostra o pedaço do papel de parede atrás do menu.
        this.actor = new St.Widget({
            style_class: 'orla-start-glass',
            clip_to_allocation: true,
            x_expand: true, y_expand: true,
            visible: false,
        });
        this._wall = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.actor.add_child(this._wall);
        this._blur = new RoundedBlurEffect({radius: BLUR_RADIUS, cornerRadius: 16, mode: Shell.BlurMode.ACTOR});
        this.actor.add_effect(this._blur);
        this._manager = null;
        this._monitorIndex = -1;
        this._offset = [0, 0];
    }

    set cornerRadius(value) {
        this._blur.cornerRadius = value;
    }

    /** Liga/desliga; ligado, mostra o papel de parede de `monitor` atrás de (x, y). */
    sync(enabled, monitor, x, y, dark) {
        this.actor.visible = enabled;
        if (!enabled) {
            this._release();
            return;
        }
        if (this._monitorIndex !== monitor.index) {
            this._release();
            this._monitorIndex = monitor.index;
            this._manager = new Background.BackgroundManager({
                container: this._wall,
                monitorIndex: monitor.index,
                vignette: false,
                controlPosition: false,
            });
            // O papel de parede mudou: o GNOME troca o ator; reposicionamos.
            this._manager.connect('changed', () => this._place());
        }
        this._offset = [monitor.x - x, monitor.y - y];
        this._monitor = monitor;
        this._blur.brightness = dark ? 0.75 : 1.05;
        this._place();
    }

    _place() {
        const actor = this._manager?.backgroundActor;
        if (!actor)
            return;
        actor.set_position(...this._offset);
        actor.set_size(this._monitor.width, this._monitor.height);
    }

    _release() {
        this._manager?.destroy();
        this._manager = null;
        this._monitorIndex = -1;
    }

    destroy() {
        this._release();
        this.actor.destroy();
    }
}
