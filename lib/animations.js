// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// animations.js — animações reutilizáveis: quique (bounce) e "fumacinha".
//
// Usamos actor.ease(): a API do GNOME Shell (sobre as transições implícitas
// do Clutter) para animar propriedades de um ator. O Clutter interpola o
// valor a cada quadro na placa de vídeo, sem trabalho do JavaScript. É bem
// mais eficiente que mudar o valor "na mão" num timer.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {animationsEnabled} from './utils.js';

/**
 * Faz `actor` quicar para longe da borda da tela `times` vezes.
 * Retorna uma função que interrompe a animação.
 *
 * @param {Clutter.Actor} actor - o que vai quicar
 * @param {import('./utils.js').Axis} axis - eixos da dock
 * @param {object} params - altura (px), duração de cada quique (ms) e repetições
 * @returns {Function} função para cancelar
 */
export function bounce(actor, axis, {height, duration = 520, times = 1, onComplete = null}) {
    const prop = axis.crossTranslation;
    let cancelled = false;
    let remaining = times;

    const finish = () => {
        actor[prop] = 0;
        onComplete?.();
    };

    if (!animationsEnabled()) {
        finish();
        return () => {};
    }

    const once = () => {
        if (cancelled)
            return;
        if (remaining-- <= 0) {
            finish();
            return;
        }
        // Subida desacelerando (EASE_OUT) e descida acelerando (EASE_IN):
        // é o que dá a sensação de gravidade.
        actor.ease({
            [prop]: axis.awaySign * height,
            duration: duration * 0.5,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (cancelled)
                    return;
                actor.ease({
                    [prop]: 0,
                    duration: duration * 0.5,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: once,
                });
            },
        });
    };
    once();

    return () => {
        if (cancelled)
            return;
        cancelled = true;
        actor.remove_transition(prop);
        actor[prop] = 0;
    };
}

/**
 * A "fumacinha" do macOS ao remover um ícone da dock: algumas bolinhas que
 * crescem e somem. Desenhada com Cairo (biblioteca de desenho 2D) dentro de
 * um St.DrawingArea.
 *
 * @param {number} x - centro, em coordenadas da tela
 * @param {number} y - centro, em coordenadas da tela
 * @param {number} size - tamanho de referência (tamanho do ícone)
 */
export function poof(x, y, size) {
    if (!animationsEnabled())
        return;

    const area = new St.DrawingArea({
        width: size * 2,
        height: size * 2,
        x: Math.round(x - size),
        y: Math.round(y - size),
        reactive: false,
    });
    Main.uiGroup.add_child(area);

    // Bolinhas: [ângulo, distância relativa, raio relativo]
    const puffs = [
        [0, 0, 0.42], [0.6, 0.45, 0.3], [1.9, 0.5, 0.32], [3.1, 0.42, 0.28],
        [4.2, 0.5, 0.3], [5.3, 0.45, 0.26],
    ];
    let progress = 0;

    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const cx = w / 2, cy = h / 2;
        const unit = Math.min(w, h) / 2;
        const t = progress;
        const alpha = 1 - t;
        for (const [angle, dist, radius] of puffs) {
            const d = unit * dist * (0.6 + t * 0.9);
            const r = unit * radius * (0.5 + t * 0.7);
            cr.arc(cx + Math.cos(angle) * d, cy + Math.sin(angle) * d, r, 0, 2 * Math.PI);
            cr.setSourceRGBA(0.92, 0.92, 0.94, 0.85 * alpha);
            cr.fillPreserve();
            cr.setSourceRGBA(0.55, 0.55, 0.6, 0.6 * alpha);
            cr.setLineWidth(1.5);
            cr.stroke();
        }
        cr.$dispose();
    });

    // Usamos um Clutter.Timeline: um relógio que emite 'new-frame' a cada
    // quadro durante `duration` ms. Aqui redesenhamos a cada quadro.
    const timeline = new Clutter.Timeline({actor: area, duration: 380});
    timeline.connect('new-frame', () => {
        progress = timeline.get_progress();
        area.queue_repaint();
    });
    timeline.connect('completed', () => area.destroy());
    timeline.start();
}
