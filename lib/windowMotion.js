// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// windowMotion.js — avisa a cada quadro enquanto alguma janela se mexe.
//
// Para que serve: o vidro DINÂMICO lê a tela atrás da dock, mas o GNOME só
// redesenha o pedaço da tela que mudou. Quando uma janela passa por trás da
// dock, só o retângulo dela é refeito; no resto da dock, "atrás" ainda está
// o quadro ANTERIOR — com o vidro já desenhado —, e o vidro desfoca o próprio
// vidro. Resultado: um rastro de vidro no caminho da janela, que só some
// quando algo pede a dock inteira de novo (ao soltar a janela).
//
// A solução é a mesma do Dock.queueGlassRedraw(): enquanto houver janela
// sendo arrastada, balançando (qualquer Clutter.DeformEffect — o nosso
// wobbly ou o do Compiz) ou animando (abrir, fechar, minimizar,
// maximizar), pedimos o vidro inteiro a cada quadro. Assim a área atrás da
// dock é sempre refeita do zero.
//
// Custa só enquanto há movimento: parada a tela, a Timeline para também.

import Clutter from 'gi://Clutter';

// Propriedades que as animações de janela do GNOME (e as nossas) animam.
const ANIMATED_PROPS = [
    'x', 'y', 'scale-x', 'scale-y', 'opacity', 'translation-x', 'translation-y',
];

// Quadros extras depois que tudo para, para desenhar a posição final.
const SETTLE_FRAMES = 3;

export class WindowMotionWatcher {
    /** @param {() => void} onFrame chamado a cada quadro com movimento */
    constructor(onFrame) {
        this._onFrame = onFrame;
        this._grabbing = false;
        this._timeline = null;
        this._idleFrames = 0;
        this._lastSignature = '';

        global.display.connectObject(
            'grab-op-begin', () => {
                this._grabbing = true;
                this._wake();
            },
            'grab-op-end', () => {
                this._grabbing = false;
                this._wake();
            },
            this);
        global.window_manager.connectObject(
            'map', () => this._wake(),
            'destroy', () => this._wake(),
            'minimize', () => this._wake(),
            'unminimize', () => this._wake(),
            'size-change', () => this._wake(),
            'size-changed', () => this._wake(),
            this);
    }

    /** Alguma janela está balançando ou animando agora? */
    _animating() {
        for (const actor of global.get_window_actors()) {
            if (actor.get_effects().some(e => e instanceof Clutter.DeformEffect))
                return true;
            if (ANIMATED_PROPS.some(prop => actor.get_transition(prop)))
                return true;
        }
        return false;
    }

    /** Posição/tamanho das janelas: muda quando alguma é arrastada. */
    _signature() {
        return global.get_window_actors()
            .map(a => `${a.x},${a.y},${a.width},${a.height}`).join(';');
    }

    _wake() {
        this._idleFrames = 0;
        this._onFrame();
        if (this._timeline)
            return;
        // Timeline "infinita" no palco: roda no ritmo da tela só enquanto há
        // movimento. O 'new-frame' acontece ANTES do desenho do quadro, então
        // o pedido de redesenho já vale para o próprio quadro.
        this._timeline = new Clutter.Timeline({
            actor: global.stage,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    _tick() {
        const signature = this._signature();
        const moved = signature !== this._lastSignature;
        this._lastSignature = signature;

        if (moved || this._animating()) {
            this._idleFrames = 0;
            this._onFrame();
            return;
        }
        // Segurando a janela parada: não redesenha nada, mas continua de olho.
        if (this._grabbing)
            return;
        if (++this._idleFrames <= SETTLE_FRAMES) {
            this._onFrame();
            return;
        }
        this._stop();
    }

    _stop() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
    }

    destroy() {
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        this._stop();
    }
}
