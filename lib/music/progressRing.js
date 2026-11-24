// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/progressRing.js — o contorno de progresso em volta da pílula.
//
//            ●━━━━━━━━━━━━━━━━━━┓      o traço nasce no topo, no meio,
//          ╭─┴──────────────────╮┃     e dá a volta no sentido horário
//          │  capa  título   ⏯  │┃     até voltar ao mesmo ponto quando a
//          ╰────────────────────╯┛     música termina
//
// Um trilho bem sutil mostra o caminho todo; por cima, o traço (pontas
// arredondadas) e um brilho discreto do mesmo tom. Desenhado com Cairo
// num St.DrawingArea: só é redesenhado quando o progresso anda ~1 px, a
// cor muda ou o tamanho muda.
//
// Animações (Clutter.Timeline presa ao ator: anda no ritmo da tela e para
// sozinha fora dela):
//   setProgress(p, {animate})  pulo (seek, troca de faixa): desliza até p
//   setColor(rgb)              troca de cor interpolada (~650 ms)

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const SEEK_MS = 280;
const COLOR_MS = 650;

const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

/**
 * Traça o pedaço [0, fraction] do contorno de um retângulo arredondado
 * (x, y, w, h, raio r), começando no topo-centro, no sentido horário.
 */
function tracePartial(cr, x, y, w, h, r, fraction) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const top = w - 2 * r, side = h - 2 * r, arc = Math.PI * r / 2;
    // Os trechos em ordem, a partir do topo-centro.
    const segments = [
        ['line', top / 2, [x + w / 2, y], [x + w - r, y]],
        ['arc', arc, [x + w - r, y + r], -Math.PI / 2, 0],
        ['line', side, [x + w, y + r], [x + w, y + h - r]],
        ['arc', arc, [x + w - r, y + h - r], 0, Math.PI / 2],
        ['line', top, [x + w - r, y + h], [x + r, y + h]],
        ['arc', arc, [x + r, y + h - r], Math.PI / 2, Math.PI],
        ['line', side, [x, y + h - r], [x, y + r]],
        ['arc', arc, [x + r, y + r], Math.PI, 1.5 * Math.PI],
        ['line', top / 2, [x + r, y], [x + w / 2, y]],
    ];
    const total = segments.reduce((sum, s) => sum + s[1], 0);
    let left = Math.max(0, Math.min(1, fraction)) * total;
    cr.moveTo(x + w / 2, y);
    for (const [kind, length, a, b, c] of segments) {
        if (left <= 0)
            break;
        const part = length > 0 ? Math.min(1, left / length) : 1;
        if (kind === 'line')
            cr.lineTo(lerp(a[0], b[0], part), lerp(a[1], b[1], part));
        else
            cr.arc(a[0], a[1], r, b, lerp(b, c, part));
        left -= length;
    }
    return total;
}

export const ProgressRing = GObject.registerClass({
    Signals: {'color-changed': {}},
}, class OrlaMusicProgressRing extends St.DrawingArea {
    _init() {
        super._init({style_class: 'wavebar-music-pill-ring', reactive: false});
        this._progress = 0;        // o que está desenhado
        this._target = 0;
        this._from = 0;
        this._color = [0.4, 0.6, 1];
        this._colorFrom = this._color;
        this._colorTo = this._color;
        this._dark = true;
        this._lineWidth = 2;
        this._pad = 4;
        this._radius = 10;
        this._lastLength = 0;
        this._drawnPx = -1;

        this._seek = new Clutter.Timeline({actor: this, duration: SEEK_MS});
        this._seek.connect('new-frame', () => this._onSeekFrame());
        this._seek.connect('completed', () => this._onSeekFrame(1));
        this._fade = new Clutter.Timeline({actor: this, duration: COLOR_MS});
        this._fade.connect('new-frame', () => this._onColorFrame());
        this._fade.connect('completed', () => this._onColorFrame(1));
        this.connect('destroy', () => {
            this._seek.stop();
            this._fade.stop();
        });
    }

    /** Espessura do traço e a folga (para o brilho) em volta do contorno. */
    setStyle({lineWidth, radius, dark}) {
        this._lineWidth = lineWidth;
        this._pad = Math.ceil(lineWidth * 2 + 1);
        this._radius = radius;
        this._dark = dark;
        this.queue_repaint();
    }

    /** A folga que o desenho precisa em volta do retângulo da pílula. */
    get pad() {
        return this._pad;
    }

    set radius(r) {
        if (Math.abs(r - this._radius) < 0.25)
            return;
        this._radius = r;
        this.queue_repaint();
    }

    get progress() {
        return this._target;
    }

    /** 0–1. Com `animate`, desliza até lá (pulo na música, troca de faixa). */
    setProgress(progress, {animate = false} = {}) {
        progress = Math.max(0, Math.min(1, Number(progress) || 0));
        this._target = progress;
        if (animate && this.mapped && St.Settings.get().enable_animations &&
            Math.abs(progress - this._progress) > 0.002) {
            this._from = this._progress;
            this._seek.stop();
            this._seek.rewind();
            this._seek.start();
            return;
        }
        if (this._seek.is_playing())
            return;   // o deslize termina no alvo novo
        this._setDrawn(progress);
    }

    _onSeekFrame(t = null) {
        const p = easeOutCubic(t ?? this._seek.get_progress());
        this._setDrawn(lerp(this._from, this._target, p));
    }

    /** Só redesenha se o traço andou pelo menos meio pixel. */
    _setDrawn(progress) {
        this._progress = progress;
        const px = Math.round(progress * this._lastLength * 2);
        if (px === this._drawnPx && this._lastLength > 0)
            return;
        this._drawnPx = px;
        this.queue_repaint();
    }

    /** Comprimento do contorno (px), para o dono decidir de quanto em quanto tempo atualizar. */
    get pathLength() {
        return this._lastLength;
    }

    /** Cor nova (RGB 0–1), com transição suave. */
    setColor(rgb, {animate = true} = {}) {
        const same = rgb.every((v, i) => Math.abs(v - this._colorTo[i]) < 0.004);
        if (same)
            return;
        this._colorTo = rgb;
        if (!animate || !this.mapped || !St.Settings.get().enable_animations) {
            this._fade.stop();
            this._color = rgb;
            this.queue_repaint();
            return;
        }
        this._colorFrom = this._color;
        this._fade.stop();
        this._fade.rewind();
        this._fade.start();
    }

    get color() {
        return this._color;
    }

    _onColorFrame(t = null) {
        const p = easeOutCubic(t ?? this._fade.get_progress());
        this._color = this._colorFrom.map((v, i) => lerp(v, this._colorTo[i], p));
        this.queue_repaint();
        this.emit('color-changed');
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const lw = this._lineWidth;
            // O traço fica na borda da pílula (centro do traço meia
            // espessura para dentro).
            const x = this._pad + lw / 2, y = this._pad + lw / 2;
            const w = width - 2 * this._pad - lw, h = height - 2 * this._pad - lw;
            if (w <= 0 || h <= 0)
                return;
            const r = Math.max(0, this._radius - lw / 2);
            const [cr0, cg0, cb0] = this._color;
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);

            // Trilho: o caminho completo, bem sutil.
            this._lastLength = tracePartial(cr, x, y, w, h, r, 1);
            cr.closePath();
            if (this._dark)
                cr.setSourceRGBA(1, 1, 1, 0.1);
            else
                cr.setSourceRGBA(0, 0, 0, 0.1);
            cr.setLineWidth(lw);
            cr.stroke();

            if (this._progress <= 0.0005)
                return;
            // Brilho discreto: o mesmo trecho, mais largo e bem transparente.
            tracePartial(cr, x, y, w, h, r, this._progress);
            cr.setSourceRGBA(cr0, cg0, cb0, 0.22);
            cr.setLineWidth(lw * 2.6);
            cr.strokePreserve();
            // O traço.
            cr.setSourceRGBA(cr0, cg0, cb0, 1);
            cr.setLineWidth(lw);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }
});
