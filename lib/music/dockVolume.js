// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/dockVolume.js — o volume do player no canto da dock (opção "Canto
// da dock" em Música › Volume). É o último item da dock, como os outros:
// respeita o estilo, o lado, a margem e a dock encostada, e nunca fica por
// cima de um ícone.
//
//   compacto   [🔊]                    só o alto-falante (clicar = mudo)
//   aberto     [🔊 ━━━━━●───── 42%]    com o mouse em cima ou rolando a
//                                     roda; volta a fechar sozinho
//
// Na dock lateral a barra fica em pé. Abrir/fechar anima o comprimento
// do item (a dock reposiciona os vizinhos a cada quadro, sem pulos).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {DockItem} from '../dockItem.js';
import {accentHex, hexToRgb} from '../themes.js';
import {Timeout} from '../utils.js';
import {isCancelled} from './cache.js';
import {coverColor, readableColor} from './coverColor.js';
import {VolumeControl} from './volumeBar.js';

const KEY = 'wavebar-music-pill-';
const OPEN_MS = 260;
const CLOSE_DELAY_MS = 700;
const STEP = 0.05;

export const DockVolumeItem = GObject.registerClass(
class OrlaDockVolumeItem extends DockItem {
    _init(dock, service) {
        super._init(dock, {button_mask: 0});
        this.add_style_class_name('wavebar-music-pill-dockvol-item');
        this._service = service;
        this._model = service.volume;
        this._model.acquire();
        this._extra = 0;
        this._extraFrom = 0;
        this._extraTo = 0;
        this._open = false;
        this._close = new Timeout();
        this._relayoutSoon = new Timeout();
        this._artUrl = null;
        this._cancellable = null;

        this._box = new St.Widget({style_class: 'wavebar-music-pill-dockvol', clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout()});
        this._content.add_child(this._box);
        this._control = new VolumeControl(this._model);
        this._box.add_child(this._control);

        this.connect('notify::hover', () => {
            if (this.hover)
                this._setOpen(true);
            else
                this._close.start(CLOSE_DELAY_MS, () => this._setOpen(false));
        });
        service.connectObject(
            'changed', () => this._syncColor(),
            'stopping', () => this._detach(),
            this);
        service.settings.connectObject(`changed::${KEY}dynamic-color`, () => {
            this._artUrl = null;
            this._syncColor();
        }, this);
        this._syncColor();
    }

    get labelText() {
        return null;
    }

    /** O controle não amplia com a onda (ver Dock._onMotion). */
    get magnifies() {
        return false;
    }

    cellLength(geometry) {
        return geometry.cellLength + this._extra;
    }

    applyGeometry(geometry) {
        super.applyGeometry(geometry);
        const vertical = geometry.axis.vertical;
        this._control.vertical = vertical;
        const s = geometry.iconSize;
        const icon = this._control.muteButton;
        icon.set_size(s, s);
        icon.child.icon_size = Math.max(14, Math.round(s * 0.42));
        // O controle tem sempre o tamanho de "aberto"; a caixa recorta e,
        // fechada, deixa à mostra só o alto-falante (na ponta de dentro).
        this._openExtra = Math.round(s * 2.8);
        this._control.set_size(...geometry.axis.toXY(s + this._openExtra, s));
        this._layoutBox();
        this._syncColor();
    }

    _layoutBox() {
        const g = this._geometry;
        if (!g)
            return;
        const {axis} = g;
        const length = Math.max(g.iconSize, this.cellLength(g) - 2 * g.gap);
        this._box.set_position(...axis.toXY(g.gap, g.iconCross));
        this._box.set_size(...axis.toXY(Math.round(length), g.iconSize));
        // Em pé, o alto-falante fica embaixo: o controle "sobe" ao abrir.
        const full = g.iconSize + (this._openExtra ?? 0);
        this._control.set_position(0, axis.vertical ? Math.round(length - full) : 0);
    }

    setWave(_scale, offset) {
        if (this._geometry)
            this[this._geometry.axis.mainTranslation] = offset;
    }

    /** Rodinha sobre o item: abre e já muda o volume. */
    onScroll(event) {
        this._setOpen(true);
        if (!this.hover)
            this._close.start(CLOSE_DELAY_MS * 2, () => this._setOpen(false));
        if (!this._model?.available)
            return;
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
            this._model.set(this._model.level + delta);
    }

    // ---------- Abrir e fechar ----------

    _setOpen(open) {
        this._close.cancel();
        if (open === this._open || !this._geometry)
            return;
        this._open = open;
        if (open)
            this._box.add_style_class_name('wavebar-music-pill-dockvol-open');
        const target = open ? this._openExtra : 0;
        this._animate(target);
    }

    _animate(target) {
        this._extraFrom = this._extra;
        this._extraTo = target;
        const done = () => {
            if (!this._open)
                this._box.remove_style_class_name('wavebar-music-pill-dockvol-open');
            this._relayoutSoon.start(0, () => {
                if (!this.dock.destroyed)
                    this.dock.relayout();
            });
        };
        this._timeline?.stop();
        if (!this.mapped || !St.Settings.get().enable_animations) {
            this._extra = target;
            this._layoutBox();
            done();
            return;
        }
        if (!this._timeline) {
            this._timeline = new Clutter.Timeline({actor: this, duration: OPEN_MS});
            this._timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._timeline.connect('new-frame', () => this._onFrame());
            this._timeline.connect('completed', () => {
                this._onFrame(1);
                this._done?.();
            });
        }
        this._done = done;
        this._timeline.rewind();
        this._timeline.start();
    }

    _onFrame(progress = null) {
        const t = progress ?? this._timeline.get_progress();
        this._extra = this._extraFrom + (this._extraTo - this._extraFrom) * t;
        this.dock.layoutItemsNow();
        this._layoutBox();
    }

    // ---------- Cor (a da música, como na pílula) ----------

    async _syncColor() {
        if (!this._service || !this._geometry)
            return;
        const dark = this.dock.look?.dark !== false;
        const accent = hexToRgb(accentHex(this.dock.manager.accentName)).map(v => v / 255);
        const url = this._service.settings.get_boolean(`${KEY}dynamic-color`)
            ? this._service.current?.metadata.artUrl ?? '' : '';
        if (url === this._artUrl && this._dark === dark)
            return;
        this._artUrl = url;
        this._dark = dark;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        let color = null;
        try {
            const path = url ? await this._service.covers.load(url, cancellable) : null;
            color = path ? await coverColor(path, cancellable) : null;
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        if (cancellable.is_cancelled() || !this._service)
            return;
        this._control.setColor(readableColor(color ?? accent, dark), dark);
    }

    // ---------- Fim ----------

    _detach() {
        if (!this._service)
            return;
        this._close.cancel();
        this._relayoutSoon.cancel();
        this._cancellable?.cancel();
        this._service.disconnectObject(this);
        this._service.settings.disconnectObject(this);
        this._model.release();
        this._service = null;
    }

    destroy() {
        this._detach();
        this._timeline?.stop();
        this._timeline = null;
        this._done = null;
        super.destroy();
    }
});
