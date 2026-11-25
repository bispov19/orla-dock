// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/volumeBar.js — a barra deslizante de volume do card.
//
//   ━━━━━━━━━━●──────────      (também sabe ficar em pé: o valor cresce
//                               de baixo para cima)
//
// Desenhada com Cairo: trilho sutil, parte cheia na cor da música e o
// puxador. Arrastar (PanGesture, o mesmo jeito dos controles do GNOME 51),
// a roda do mouse e as setas mudam o valor. Animações leves:
//   - "emphasis" (0→1): o trilho engrossa e o puxador cresce com o mouse
//     em cima ou arrastando;
//   - "shown": o valor DESENHADO desliza até o valor novo quando ele muda
//     por fora (outro app, teclas de volume), em vez de pular.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const STEP = 0.05;
const EMPHASIS_MS = 180;
const FOLLOW_MS = 200;
const COLOR_MS = 400;

export const VolumeBar = GObject.registerClass({
    Properties: {
        'emphasis': GObject.ParamSpec.double('emphasis', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
        'shown': GObject.ParamSpec.double('shown', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
    Signals: {
        // O usuário mexeu (arrastando, rolando ou pelas setas).
        'value-changed': {param_types: [GObject.TYPE_DOUBLE]},
        'drag-begin': {},
        'drag-end': {},
    },
}, class OrlaMusicVolumeBar extends St.DrawingArea {
    _init({vertical = false, ...params} = {}) {
        super._init({
            style_class: 'wavebar-music-pill-volume-bar',
            reactive: true,
            track_hover: true,
            can_focus: true,
            ...params,
        });
        this._vertical = vertical;
        this._value = 0;
        this._emphasis = 0;
        this._shown = 0;
        this._color = [0.4, 0.6, 1];
        this._dark = true;
        this._dragging = false;
        this._grab = null;

        this._pan = new Clutter.PanGesture();
        this._pan.set_begin_threshold(0);
        this._pan.connect('recognize', () => this._onPanBegin());
        this._pan.connect('pan-update', () => this._userSet(this._valueAt()));
        this._pan.connect('end', () => this._onPanEnd());
        this._pan.connect('cancel', () => this._onPanEnd());
        this.add_action(this._pan);
        this.connect('notify::hover', () => this._syncEmphasis());
        this.connect('destroy', () => {
            this._release();
            this._colorFade?.stop();
        });
    }

    get emphasis() {
        return this._emphasis;
    }

    set emphasis(v) {
        if (v === this._emphasis)
            return;
        this._emphasis = v;
        this.notify('emphasis');
        this.queue_repaint();
    }

    get shown() {
        return this._shown;
    }

    set shown(v) {
        if (v === this._shown)
            return;
        this._shown = v;
        this.notify('shown');
        this.queue_repaint();
    }

    get value() {
        return this._value;
    }

    get dragging() {
        return this._dragging;
    }

    set vertical(vertical) {
        this._vertical = vertical;
        this.queue_repaint();
    }

    /** Valor vindo de fora (o player mudou): o desenho desliza até ele. */
    setValue(value) {
        value = Math.max(0, Math.min(1, value));
        if (this._dragging)
            return;   // durante o arraste, o mouse manda
        this._value = value;
        if (this.mapped && St.Settings.get().enable_animations && Math.abs(value - this._shown) > 0.004)
            this.ease_property('shown', value, {duration: FOLLOW_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this.shown = value;
    }

    /** Cor nova: troca suave (~400 ms), como o resto do card. */
    setColor(rgb, dark) {
        this._dark = dark;
        if (!this.mapped || !St.Settings.get().enable_animations) {
            this._color = rgb;
            this.queue_repaint();
            return;
        }
        const from = this._color;
        this._colorFade ??= new Clutter.Timeline({actor: this, duration: COLOR_MS});
        this._colorFade.stop();
        this._colorFade.disconnectObject(this);
        this._colorFade.connectObject('new-frame', () => {
            const t = 1 - Math.pow(1 - this._colorFade.get_progress(), 3);
            this._color = from.map((v, i) => v + (rgb[i] - v) * t);
            this.queue_repaint();
        }, 'completed', () => {
            this._color = rgb;
            this.queue_repaint();
        }, this);
        this._colorFade.rewind();
        this._colorFade.start();
    }

    _userSet(value) {
        value = Math.max(0, Math.min(1, value));
        this._value = value;
        this.remove_transition('shown');
        this.shown = value;
        this.emit('value-changed', value);
    }

    _syncEmphasis() {
        const target = this.hover || this._dragging ? 1 : 0;
        if (this.mapped && St.Settings.get().enable_animations)
            this.ease_property('emphasis', target, {duration: EMPHASIS_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this.emphasis = target;
    }

    _valueAt() {
        const {x, y} = this._pan.get_centroid();
        const pad = this._pad;
        if (this._vertical) {
            const length = Math.max(1, this.height - 2 * pad);
            return 1 - (y - pad) / length;
        }
        const length = Math.max(1, this.width - 2 * pad);
        let v = (x - pad) / length;
        if (this.get_text_direction() === Clutter.TextDirection.RTL)
            v = 1 - v;
        return v;
    }

    _onPanBegin() {
        this._dragging = true;
        this._grab = global.stage.grab(this);
        this._syncEmphasis();
        this.emit('drag-begin');
        this._userSet(this._valueAt());
    }

    _onPanEnd() {
        if (!this._dragging)
            return;
        this._dragging = false;
        this._release();
        this._syncEmphasis();
        this.emit('drag-end');
    }

    _release() {
        this._grab?.dismiss();
        this._grab = null;
    }

    vfunc_scroll_event(event) {
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.RIGHT:
            delta = STEP;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.LEFT:
            delta = -STEP;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = -(dy || -dx) * STEP;
            break;
        }
        }
        if (delta)
            this._userSet(this._value + delta);
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        const up = [Clutter.KEY_Right, Clutter.KEY_Up].includes(key);
        const down = [Clutter.KEY_Left, Clutter.KEY_Down].includes(key);
        if (!up && !down)
            return Clutter.EVENT_PROPAGATE;
        this._userSet(this._value + (up ? STEP : -STEP));
        return Clutter.EVENT_STOP;
    }

    /** Folga nas pontas: o puxador cabe inteiro (no tamanho maior). */
    get _pad() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return 8 * scale;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const e = this._emphasis;
            const thick = (4 + 2 * e) * scale;
            const knob = (5 + 2.5 * e) * scale;
            const pad = this._pad;
            const vertical = this._vertical;
            const length = (vertical ? height : width) - 2 * pad;
            if (length <= 0)
                return;
            const across = (vertical ? width : height) / 2;
            const at = t => (vertical ? [across, pad + length * (1 - t)] : [pad + length * t, across]);
            const [sx, sy] = at(0);
            const [ex, ey] = at(1);
            const [vx, vy] = at(this._shown);
            const [r, g, b] = this._color;
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(thick);

            // Trilho inteiro, sutil.
            cr.moveTo(sx, sy);
            cr.lineTo(ex, ey);
            if (this._dark)
                cr.setSourceRGBA(1, 1, 1, 0.16 + 0.06 * e);
            else
                cr.setSourceRGBA(0, 0, 0, 0.12 + 0.05 * e);
            cr.stroke();

            // Parte cheia, na cor da música.
            if (this._shown > 0.001) {
                cr.moveTo(sx, sy);
                cr.lineTo(vx, vy);
                cr.setSourceRGBA(r, g, b, 1);
                cr.stroke();
            }

            // Puxador: claro, com a borda na cor.
            cr.arc(vx, vy, knob, 0, 2 * Math.PI);
            cr.setSourceRGBA(1, 1, 1, this.reactive ? 1 : 0.5);
            cr.fillPreserve();
            cr.setLineWidth(1.5 * scale);
            cr.setSourceRGBA(r, g, b, 1);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }
});

const ICONS = ['audio-volume-muted-symbolic', 'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic', 'audio-volume-high-symbolic'];
const PERCENT_HIDE_MS = 1000;
const PERCENT_FADE_MS = 150;

/** O ícone de alto-falante para o nível (mudo, baixo, médio, alto). */
export function volumeIcon(level, muted) {
    if (muted || level <= 0.001)
        return ICONS[0];
    return ICONS[Math.min(3, Math.max(1, Math.ceil(level * 3)))];
}

/**
 * [🔊] ━━━━━━●──── [42%]: ligada ao PlayerVolume (lib/music/volume.js).
 * Clicar no alto-falante silencia e volta ao volume de antes. Sem volume
 * disponível, tudo fica esmaecido (e não reage).
 */
export const VolumeControl = GObject.registerClass(
class OrlaMusicVolumeControl extends St.BoxLayout {
    _init(model, {vertical = false, percent = true} = {}) {
        super._init({
            style_class: 'wavebar-music-pill-volume',
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            x_expand: !vertical,
            y_expand: vertical,
        });
        this._model = model;
        this._mute = new St.Button({
            style_class: 'wavebar-music-pill-button wavebar-music-pill-volume-icon',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: ICONS[3]}),
        });
        this._mute.connect('clicked', () => this._model?.toggleMute());
        this.bar = new VolumeBar({vertical, x_expand: !vertical, y_expand: vertical});
        this.bar.connect('value-changed', (_b, value) => {
            this._model?.set(value);
            this._showPercent(value);
        });
        this.bar.connect('drag-end', () => this._hidePercentSoon());
        this._percent = new St.Label({style_class: 'wavebar-music-pill-volume-percent',
            y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER, opacity: 0,
            visible: percent});
        this._hideId = 0;
        if (vertical) {
            // Em pé: o valor cresce para cima, o alto-falante fica embaixo.
            this.add_child(this._percent);
            this.add_child(this.bar);
            this.add_child(this._mute);
        } else {
            this.add_child(this._mute);
            this.add_child(this.bar);
            this.add_child(this._percent);
        }
        model.connectObject('changed', () => this.sync(), this);
        this.connect('destroy', () => {
            this._clearHide();
            this._model?.disconnectObject(this);
            this._model = null;
        });
        this.sync();
    }

    set vertical(vertical) {
        this.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        this.bar.vertical = vertical;
    }

    get muteButton() {
        return this._mute;
    }

    setColor(rgb, dark) {
        this.bar.setColor(rgb, dark);
    }

    /** Modelo → interface (o volume mudou aqui ou fora da Orla). */
    sync() {
        const model = this._model;
        if (!model)
            return;
        const available = model.available;
        const level = model.level;
        this.bar.reactive = this.bar.can_focus = available;
        this._mute.reactive = this._mute.can_focus = available;
        for (const actor of [this.bar, this._mute]) {
            if (available)
                actor.remove_style_pseudo_class('insensitive');
            else
                actor.add_style_pseudo_class('insensitive');
        }
        this.bar.setValue(level);
        this._mute.child.icon_name = volumeIcon(level, model.muted);
        this._mute.accessible_name = model.muted ? _('Unmute') : _('Mute');
        if (!this.bar.dragging)
            this._percent.text = `${Math.round(level * 100)}%`;
    }

    _showPercent(value) {
        this._percent.text = `${Math.round(value * 100)}%`;
        this._clearHide();
        this._percent.ease({opacity: 255, duration: PERCENT_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        if (!this.bar.dragging)
            this._hidePercentSoon();
    }

    _hidePercentSoon() {
        this._clearHide();
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PERCENT_HIDE_MS, () => {
            this._hideId = 0;
            this._percent.ease({opacity: 0, duration: PERCENT_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHide() {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
    }
});
