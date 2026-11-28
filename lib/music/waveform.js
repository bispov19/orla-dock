// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// music/waveform.js — barra de progresso em forma de onda (decorativa, a
// mesma da Wavebar), desenhada com Cairo.
// Parte tocada na cor de destaque; o resto esmaecido. Clicar/arrastar = seek.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';



const BAR_WIDTH = 3;

/** Hash FNV-1a de 32 bits: mesma string → mesmo número. */
function hashString(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** Pseudoaleatório determinístico (mulberry32). */
function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Alturas (0,12–1) das barras. O MPRIS não entrega o áudio: inventamos
 * uma forma estável por música (três senoides + ruído, pontas suaves).
 */
function generateWaveform(seedText, count) {
    const rand = seededRandom(hashString(seedText));
    const waves = [1, 3, 8].map(base => ({freq: base + rand() * base, phase: rand() * Math.PI * 2}));
    const heights = [];
    for (let i = 0; i < count; i++) {
        const x = count > 1 ? i / (count - 1) : 0;
        const shape = 0.5 +
            0.22 * Math.sin(waves[0].freq * x * Math.PI * 2 + waves[0].phase) +
            0.14 * Math.sin(waves[1].freq * x * Math.PI * 2 + waves[1].phase) +
            0.08 * Math.sin(waves[2].freq * x * Math.PI * 2 + waves[2].phase);
        let h = shape * 0.75 + rand() * 0.4;
        const edge = Math.min(x, 1 - x);
        if (edge < 0.06)
            h *= 0.45 + 0.55 * (edge / 0.06);
        heights.push(Math.min(1, Math.max(0.12, h)));
    }
    return heights;
}

/** Microssegundos → "m:ss" (ou "h:mm:ss"). */
export function formatTime(us) {
    const total = Math.max(0, Math.floor((Number(us) || 0) / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
const BAR_GAP = 2;

export const WaveformBar = GObject.registerClass({
    GTypeName: 'OrlaMusicWaveform',
    Signals: {
        // Durante o arraste (só visual) e ao soltar (seek de verdade).
        'scrub': {param_types: [GObject.TYPE_DOUBLE]},
        'seek': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class WaveformBar extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'wavebar-music-pill-waveform',
            reactive: true,
            track_hover: true,
            can_focus: false,
            x_expand: true,
        });

        this._seed = '';
        this._heights = [];
        this._heightsKey = '';
        this._progress = 0;
        this._dragProgress = null; // != null enquanto o usuário arrasta
        this._seekable = true;
        this._grab = null;

        // PanGesture com limiar 0: reconhece já no clique (igual ao Slider do
        // GNOME 51). Clutter.ClickAction/PanAction não existem mais.
        this._pan = new Clutter.PanGesture();
        this._pan.set_begin_threshold(0);
        this._pan.connect('recognize', () => this._onPanBegin());
        this._pan.connect('pan-update', () => this._onPanUpdate());
        this._pan.connect('end', () => this._onPanEnd(true));
        this._pan.connect('cancel', () => this._onPanEnd(false));
        this.add_action(this._pan);

        this.connect('destroy', () => this._releaseGrab());
    }

    /** Muda a "música": a onda é gerada a partir deste texto. */
    setSeed(seed) {
        if (seed === this._seed)
            return;
        this._seed = seed;
        this._heightsKey = '';
        this.queue_repaint();
    }

    setProgress(progress) {
        progress = Math.min(1, Math.max(0, Number(progress) || 0));
        // Evita repintar por mudanças invisíveis (< meio pixel).
        if (Math.abs(progress - this._progress) * this.width < 0.5)
            return;
        this._progress = progress;
        if (this._dragProgress === null)
            this.queue_repaint();
    }

    setSeekable(seekable) {
        this._seekable = seekable;
        this._pan.enabled = seekable;
        if (seekable)
            this.remove_style_pseudo_class('insensitive');
        else
            this.add_style_pseudo_class('insensitive');
    }

    get isDragging() {
        return this._dragProgress !== null;
    }

    _progressAt() {
        const {x} = this._pan.get_centroid(); // coordenadas locais do ator
        const width = this.width;
        let p = width > 0 ? x / width : 0;
        if (this.get_text_direction() === Clutter.TextDirection.RTL)
            p = 1 - p;
        return Math.min(1, Math.max(0, p));
    }

    _onPanBegin() {
        // O grab mantém os eventos aqui mesmo se o ponteiro sair da barra.
        this._grab = global.stage.grab(this);
        this._dragProgress = this._progressAt();
        this.emit('scrub', this._dragProgress);
        this.queue_repaint();
    }

    _onPanUpdate() {
        this._dragProgress = this._progressAt();
        this.emit('scrub', this._dragProgress);
        this.queue_repaint();
    }

    _onPanEnd(commit) {
        const target = this._dragProgress;
        this._releaseGrab();
        this._dragProgress = null;
        if (commit && target !== null) {
            this._progress = target;
            this.emit('seek', target);
        }
        this.queue_repaint();
    }

    _releaseGrab() {
        this._grab?.dismiss();
        this._grab = null;
    }

    _ensureHeights(count) {
        const key = `${this._seed}|${count}`;
        if (key !== this._heightsKey) {
            this._heights = generateWaveform(this._seed, count);
            this._heightsKey = key;
        }
        return this._heights;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const node = this.get_theme_node();
            const playedColor = node.get_foreground_color();
            const [hasRest, restColor] = node.lookup_color('-wavebar-music-pill-rest-color', false);

            const count = Math.max(1, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
            const heights = this._ensureHeights(count);
            // Distribui a sobra de pixels para a onda ocupar a largura toda.
            const step = count > 1 ? (width - BAR_WIDTH) / (count - 1) : 0;
            const progress = this._dragProgress ?? this._progress;
            const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;

            const drawBars = () => {
                for (let i = 0; i < count; i++) {
                    const x = BAR_WIDTH / 2 + i * step;
                    const h = Math.max(BAR_WIDTH, heights[i] * height);
                    cr.moveTo(x, (height - h) / 2 + BAR_WIDTH / 2);
                    cr.lineTo(x, (height + h) / 2 - BAR_WIDTH / 2);
                }
                cr.stroke();
            };

            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(BAR_WIDTH);

            // 1) Onda inteira esmaecida.
            if (hasRest)
                cr.setSourceColor(restColor);
            else
                cr.setSourceRGBA(1, 1, 1, 0.25);
            drawBars();

            // 2) Mesma onda na cor de destaque, recortada até o progresso:
            //    a barra da fronteira fica "meio pintada", o que suaviza o avanço.
            const playedWidth = progress * width;
            cr.save();
            cr.rectangle(rtl ? width - playedWidth : 0, 0, playedWidth, height);
            cr.clip();
            cr.setSourceColor(playedColor);
            drawBars();
            cr.restore();
        } catch (e) {
            console.error('[Orla Dock] Erro ao desenhar a onda:', e);
        } finally {
            cr.$dispose();
        }
    }
});
