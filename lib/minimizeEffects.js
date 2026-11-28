// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// minimizeEffects.js — efeitos de minimizar: Gênio e Escala.
//
// Como o GNOME anima o minimizar: quando uma janela é minimizada, o Mutter
// emite o sinal 'minimize' em global.window_manager e o windowManager.js do
// Shell anima a janela (escala + movimento) até o retângulo devolvido por
// `metaWindow.get_icon_geometry()`. Se nós informarmos esse retângulo com
// `set_icon_geometry()` (o DockManager faz isso), o efeito Escala nativo já
// "entra" no ícone da dock. Ou seja: Escala = animação nativa + geometria.
//
// Gênio: assumimos a animação. Como nosso handler do sinal roda DEPOIS do
// handler do Shell, nós:
//   1. tiramos a janela do conjunto Main.wm._minimizing (assim o Shell não
//      finaliza nada) e cancelamos a animação dele;
//   2. aplicamos na PRÓPRIA janela um Clutter.DeformEffect (a matemática
//      fica em genieMath.js): ele desenha a
//      janela numa textura e depois a "cola" numa malha de 4 × 64 ladrilhos.
//      Para cada vértice da malha, vfunc_deform_vertex() diz para onde ele
//      vai. Entre os vértices, a placa de vídeo interpola a imagem, então as
//      bordas do funil ficam curvas e lisas (sem serrilhado);
//   3. no fim, avisamos o Mutter com completed_minimize().
//
// Observação: Main.wm._minimizing é interno do Shell. Se um dia mudar, o
// código detecta (`?.has`) e simplesmente deixa a animação nativa rodar.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {genieSetup, genieVertex} from './genieMath.js';
import {Position, animationsEnabled} from './utils.js';

const GENIE = 0;
const ALONG_TILES = 64;     // ladrilhos na direção da dock (onde há curva)
const ACROSS_TILES = 4;     // na outra direção a deformação é reta

const GenieDeform = GObject.registerClass(
class OrlaGenieDeform extends Clutter.DeformEffect {
    /** @param {object} setup - resultado de genieSetup() */
    _init(setup) {
        super._init();
        this.progress = 0;
        this._s = setup;
        const vertical = setup.position === Position.LEFT || setup.position === Position.RIGHT;
        if (vertical)
            this.set_n_tiles(ALONG_TILES, ACROSS_TILES);
        else
            this.set_n_tiles(ACROSS_TILES, ALONG_TILES);
    }

    retarget(setup) {
        this._s = setup;
    }

    vfunc_deform_vertex(width, height, v) {
        if (this.progress <= 0)
            return;
        const [x, y] = genieVertex(this._s, v.tx, v.ty, this.progress);
        // A textura pode ter tamanho diferente do ator (sombras da janela).
        v.x = x * width / this._s.w;
        v.y = y * height / this._s.h;
    }

    // A janela deformada sai dos próprios limites; devolver false diz ao
    // Clutter "não sei calcular a área", e ele redesenha o que for preciso.
    vfunc_modify_paint_volume(_volume) {
        return false;
    }
});

class GenieAnimation {
    constructor(actor, iconRect, position, reverse, duration, onDone, tracker = null) {
        this._actor = actor;
        this._reverse = reverse;
        this._onDone = onDone;

        const [x, y] = actor.get_position();
        const [w, h] = actor.get_size();
        // O funil é calculado em relação à janela (que fica parada).
        const setupFor = rect => genieSetup(position, w, h, {
            x: rect.x - x, y: rect.y - y,
            width: rect.width, height: rect.height,
        });
        this._effect = new GenieDeform(setupFor(iconRect));
        this._effect.progress = reverse ? 1 : 0;
        actor.add_effect_with_name('orla-genie', this._effect);

        // slow_down_factor: o "câmera lenta" de depuração do GNOME; actor.ease()
        // já respeita, mas um Timeline criado à mão precisa multiplicar.
        this._timeline = new Clutter.Timeline({
            actor,
            duration: duration * St.Settings.get().slow_down_factor,
        });
        this._timeline.connect('new-frame', () => {
            // O ícone pode estar se mexendo (o espaço da
            // miniatura abrindo, a dock se recentralizando, a ampliação),
            // então o funil mira na posição dele AGORA.
            const rect = tracker?.();
            if (rect)
                this._effect.retarget(setupFor(rect));
            const t = this._timeline.get_progress();
            this._effect.progress = reverse ? 1 - t : t;
            this._effect.invalidate();
            actor.get_parent()?.queue_redraw();
        });
        this._timeline.connect('completed', () => this.finish());
        this._timeline.start();
    }

    finish() {
        if (!this._timeline)
            return;
        this._timeline.stop();
        this._timeline = null;
        this._actor.remove_effect(this._effect);
        this._effect = null;
        this._onDone();
    }
}

export class MinimizeEffects {
    constructor(settings) {
        this._settings = settings;
        this._running = new Map();   // ator da janela → GenieAnimation

        global.window_manager.connectObject(
            'minimize', (_wm, actor) => this._onMinimize(actor),
            'unminimize', (_wm, actor) => this._onUnminimize(actor),
            'kill-window-effects', (_wm, actor) => this._finish(actor),
            this);
    }

    destroy() {
        global.window_manager.disconnectObject(this);
        for (const actor of [...this._running.keys()])
            this._finish(actor);
    }

    /** A janela está no meio do Gênio? (a miniatura espera ele terminar) */
    isAnimating(metaWindow) {
        return this._running.has(metaWindow.get_compositor_private());
    }

    _useGenie() {
        return this._settings.get_enum('minimize-effect') === GENIE && animationsEnabled();
    }

    _onMinimize(actor) {
        if (!this._useGenie() || !Main.wm._minimizing?.has(actor))
            return;
        const [ok, iconRect] = actor.meta_window.get_icon_geometry();
        if (!ok)
            return;
        Main.wm._minimizing.delete(actor);
        this._resetActor(actor);
        this._start(actor, iconRect, false,
            () => global.window_manager.completed_minimize(actor));
    }

    _onUnminimize(actor) {
        if (!this._useGenie() || !Main.wm._unminimizing?.has(actor))
            return;
        const [ok, iconRect] = actor.meta_window.get_icon_geometry();
        if (!ok)
            return;
        Main.wm._unminimizing.delete(actor);
        this._resetActor(actor);
        this._start(actor, iconRect, true,
            () => global.window_manager.completed_unminimize(actor));
    }

    /** Desfaz o que a animação nativa já tinha começado. */
    _resetActor(actor) {
        actor.remove_all_transitions();
        actor.set_scale(1, 1);
        actor.set_pivot_point(0, 0);
        actor.opacity = 255;
        const rect = actor.meta_window.get_buffer_rect();
        actor.set_position(rect.x, rect.y);
    }

    _start(actor, iconRect, reverse, done) {
        const tracker = this._iconTracker?.(actor.meta_window) ?? null;
        const icon = tracker?.() ??
            {x: iconRect.x, y: iconRect.y, width: iconRect.width, height: iconRect.height};
        const position = this._settings.get_enum('position');
        const duration = this._settings.get_int('minimize-duration');
        this._running.set(actor, new GenieAnimation(actor, icon, position, reverse, duration, () => {
            this._running.delete(actor);
            done();
            this._onFinished?.(actor);
        }, tracker));
    }

    /**
     * O DockManager informa como achar o ícone de destino de uma janela:
     * `iconTracker(win)` devolve uma função que diz o retângulo atual.
     */
    set iconTracker(factory) {
        this._iconTracker = factory;
    }

    /** O DockManager usa isto para revelar a miniatura no fim do Gênio. */
    set onFinished(callback) {
        this._onFinished = callback;
    }

    _finish(actor) {
        this._running.get(actor)?.finish();
    }
}
