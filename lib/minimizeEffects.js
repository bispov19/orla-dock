// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
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
//   2. "fatiamos" a janela em ~60 faixas. Cada faixa é um Clutter.Clone da
//      janela com um recorte (set_clip) mostrando só aquela faixa;
//   3. a cada quadro calculamos para onde cada faixa vai e quão larga ela
//      fica — juntas, as faixas formam o "funil" do gênio;
//   4. no fim, avisamos o Mutter com completed_minimize().
//
// Por que faixas e não Clutter.DeformEffect (a API "certa" para deformar)?
// Nos testes com o GNOME 51 a DeformEffect não desenha nada (nem a
// PageTurnEffect, que é nativa). Clones com recorte usam só o básico do
// Clutter e são leves: a placa de vídeo desenha a mesma textura várias
// vezes, cada vez só um pedacinho.
//
// Observação: Main.wm._minimizing é interno do Shell. Se um dia mudar, o
// código detecta (`?.has`) e simplesmente deixa a animação nativa rodar.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Position, animationsEnabled, clamp} from './utils.js';

const GENIE_MS = 520;
const GENIE = 0;
const STRIP_PX = 10;       // altura aproximada de cada faixa
const MAX_STRIPS = 72;

const smoothstep = t => t * t * (3 - 2 * t);
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Trabalhamos num sistema de coordenadas próprio para a fórmula servir nas
 * 4 posições:
 *   a = eixo que aponta PARA a dock (ex.: para baixo, na dock inferior)
 *   c = eixo paralelo à borda da dock
 */
function toGenieSpace(rect, position) {
    const {x, y, width: w, height: h} = rect;
    switch (position) {
    case Position.TOP: return {c0: x, c1: x + w, a0: -(y + h), a1: -y};
    case Position.LEFT: return {c0: y, c1: y + h, a0: -(x + w), a1: -x};
    case Position.RIGHT: return {c0: y, c1: y + h, a0: x, a1: x + w};
    default: return {c0: x, c1: x + w, a0: y, a1: y + h};
    }
}

/** Converte um retângulo (c0..c1, a0..a1) de volta para a tela. */
function fromGenieSpace(c0, c1, a0, a1, position) {
    switch (position) {
    case Position.TOP: return [c0, -a1, c1 - c0, a1 - a0];
    case Position.LEFT: return [-a1, c0, a1 - a0, c1 - c0];
    case Position.RIGHT: return [a0, c0, a1 - a0, c1 - c0];
    default: return [c0, a0, c1 - c0, a1 - a0];
    }
}

/**
 * Faixa `v0..v1` (0 = lado longe da dock, 1 = lado perto) em coordenadas
 * locais da janela: [x, y, largura, altura].
 */
function bandRect(v0, v1, w, h, position) {
    switch (position) {
    case Position.TOP: return [0, (1 - v1) * h, w, (v1 - v0) * h];
    case Position.LEFT: return [(1 - v1) * w, 0, (v1 - v0) * w, h];
    case Position.RIGHT: return [v0 * w, 0, (v1 - v0) * w, h];
    default: return [0, v0 * h, w, (v1 - v0) * h];
    }
}

class GenieAnimation {
    constructor(actor, iconRect, position, reverse, onDone) {
        this._actor = actor;
        this._position = position;
        this._reverse = reverse;
        this._onDone = onDone;

        const [x, y] = actor.get_position();
        const [w, h] = actor.get_size();
        this._w = w;
        this._h = h;
        this._win = toGenieSpace({x, y, width: w, height: h}, position);
        this._icon = toGenieSpace(iconRect, position);

        const along = position === Position.LEFT || position === Position.RIGHT ? w : h;
        const count = clamp(Math.ceil(along / STRIP_PX), 8, MAX_STRIPS);

        this._group = new Clutter.Actor({reactive: false});
        this._strips = [];
        for (let j = 0; j < count; j++) {
            const v0 = j / count;
            const v1 = (j + 1) / count;
            const clone = new Clutter.Clone({source: actor, width: w, height: h});
            const [bx, by, bw, bh] = bandRect(v0, v1, w, h, position);
            // +0,5px de sobra evita "riscos" finos entre as faixas.
            clone.set_clip(bx, by, bw + 0.5, bh + 0.5);
            clone.set_pivot_point(0, 0);
            this._group.add_child(clone);
            this._strips.push({clone, v0, v1, bx, by, bw, bh});
        }
        Main.uiGroup.add_child(this._group);

        // A janela real fica invisível; quem aparece são as faixas.
        actor.opacity = 0;

        // slow_down_factor: o "câmera lenta" de depuração do GNOME; actor.ease()
        // já respeita, mas um Timeline criado à mão precisa multiplicar.
        const duration = GENIE_MS * St.Settings.get().slow_down_factor;
        this._timeline = new Clutter.Timeline({actor: this._group, duration});
        this._timeline.connect('new-frame', () => this._update(this._timeline.get_progress()));
        this._timeline.connect('completed', () => this.finish());
        this._update(0);
        this._timeline.start();
    }

    /** Posição (eixo a) do ponto `v` da janela no instante atual. */
    _along(v, slide) {
        const aWin = this._win.a0 + v * (this._win.a1 - this._win.a0);
        const aIcon = this._icon.a0 + v * (this._icon.a1 - this._icon.a0);
        return aWin + (aIcon - aWin) * slide;
    }

    _update(progress) {
        const t = this._reverse ? 1 - progress : progress;
        // Fase 1: o "funil" se forma; fase 2: a janela escorre para o ícone.
        const curve = smoothstep(clamp(t / 0.45, 0, 1));
        const slide = easeInOut(clamp((t - 0.18) / 0.82, 0, 1));
        const win = this._win;
        const icon = this._icon;
        const span = icon.a0 - win.a0;

        for (const strip of this._strips) {
            const a0 = this._along(strip.v0, slide);
            const a1 = this._along(strip.v1, slide);
            // Quanto mais perto do ícone, mais estreita a faixa.
            const f = span > 1 ? clamp(((a0 + a1) / 2 - win.a0) / span, 0, 1) : 1;
            const k = smoothstep(f) * curve;
            const c0 = win.c0 + (icon.c0 - win.c0) * k;
            const c1 = win.c1 + (icon.c1 - win.c1) * k;

            // Escala e posição que levam a faixa original até o destino.
            const [rx, ry, rw, rh] = fromGenieSpace(c0, c1, a0, Math.max(a1, a0 + 0.01), this._position);
            const sx = rw / strip.bw;
            const sy = rh / strip.bh;
            strip.clone.set_scale(sx, sy);
            strip.clone.set_position(rx - sx * strip.bx, ry - sy * strip.by);
        }
    }

    finish() {
        if (!this._timeline)
            return;
        this._timeline.stop();
        this._timeline = null;
        this._group.destroy();
        if (this._reverse) {
            this._actor.opacity = 255;
            this._onDone();
        } else {
            // Primeiro o Mutter esconde a janela; depois devolvemos a opacidade.
            this._onDone();
            this._actor.opacity = 255;
        }
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
        const icon = {x: iconRect.x, y: iconRect.y, width: iconRect.width, height: iconRect.height};
        const position = this._settings.get_enum('position');
        this._running.set(actor, new GenieAnimation(actor, icon, position, reverse, () => {
            this._running.delete(actor);
            done();
        }));
    }

    _finish(actor) {
        this._running.get(actor)?.finish();
    }
}
