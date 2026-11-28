// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// windowPreviews.js — miniaturas AO VIVO das janelas de um app.
//
// Cada janela na tela é desenhada por um Meta.WindowActor. Um Clutter.Clone
// desse ator mostra a mesma imagem (inclusive vídeo rodando) em outro lugar,
// em outro tamanho, sem copiar nada — a placa de vídeo desenha a mesma
// textura duas vezes. É assim que a Visão Geral do GNOME também funciona.
//
// Dois modos:
//   - hover: aparece ao parar o mouse no ícone e some quando o mouse sai;
//   - persistente ("Mostrar todas as janelas" no menu): fica até clicar fora
//     ou apertar Esc. Para isso usamos Main.pushModal(), que direciona todos
//     os eventos de teclado/mouse para a nossa caixa.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getAppWindows} from './appTracker.js';
import {Timeout} from './utils.js';

const MAX_WIDTH = 240;
const MAX_HEIGHT = 150;
const HOVER_CHECK_MS = 250;

export class WindowPreviews {
    constructor(dock) {
        this._dock = dock;
        this._actor = null;
        this._item = null;
        this._grab = null;
        this._watch = new Timeout();
    }

    get visible() {
        return this._actor !== null;
    }

    show(appIcon, persistent) {
        this.hide();
        const windows = getAppWindows(appIcon.app);
        if (windows.length === 0)
            return;

        this._item = appIcon;
        const dark = this._dock.look.dark;
        this._actor = new St.BoxLayout({
            style_class: `orla-previews ${dark ? 'orla-dark' : 'orla-light'}`,
            style: this._dock.look.popupCss,
            orientation: this._dock.axis.vertical
                ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            reactive: true,
            track_hover: true,
        });
        this._fill(windows);
        Main.layoutManager.addTopChrome(this._actor);
        this.reposition();

        this._actor.opacity = 0;
        this._actor.ease({opacity: 255, duration: 140});

        // Se uma janela abrir/fechar com as miniaturas abertas, refazemos.
        appIcon.app.connectObject('windows-changed', () => {
            const current = getAppWindows(appIcon.app);
            if (current.length === 0) {
                this.hide();
                return;
            }
            this._actor.destroy_all_children();
            this._fill(current);
            this.reposition();
        }, this);

        if (persistent) {
            this._grab = Main.pushModal(this._actor);
            this._actor.connect('button-press-event', (_a, event) => {
                const [x, y] = event.get_coords();
                const ext = this._actor.get_transformed_extents();
                const inside = x >= ext.origin.x && x <= ext.origin.x + ext.size.width &&
                    y >= ext.origin.y && y <= ext.origin.y + ext.size.height;
                if (!inside) {
                    this.hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._actor.connect('key-press-event', (_a, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this.hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        } else {
            // Some quando o mouse não está nem no ícone nem nas miniaturas.
            this._watch.startRepeating(HOVER_CHECK_MS, () => {
                if (this._actor?.hover || appIcon.hover)
                    return true;
                this.hide();
                return false;
            });
        }
    }

    _fill(windows) {
        for (const win of windows)
            this._actor.add_child(this._createPreview(win));
    }

    _createPreview(metaWindow) {
        const button = new St.Button({style_class: 'orla-preview', can_focus: true});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        button.set_child(box);

        const header = new St.BoxLayout({style_class: 'orla-preview-header'});
        const title = new St.Label({
            text: metaWindow.get_title() || '',
            style_class: 'orla-preview-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const close = new St.Button({
            style_class: 'orla-preview-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            accessible_name: _('Close'),
        });
        close.connect('clicked', () => metaWindow.delete(global.get_current_time()));
        header.add_child(title);
        header.add_child(close);
        box.add_child(header);

        const windowActor = metaWindow.get_compositor_private();
        if (windowActor) {
            const [w, h] = windowActor.get_size();
            const scale = Math.min(MAX_WIDTH / w, MAX_HEIGHT / h, 1);
            const clone = new Clutter.Clone({
                source: windowActor,
                width: Math.round(w * scale),
                height: Math.round(h * scale),
                x_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(clone);
        }

        button.connect('clicked', () => {
            Main.activateWindow(metaWindow);
            this.hide();
        });
        return button;
    }

    reposition() {
        if (this._actor && this._item)
            this._dock.placeOutside(this._actor, this._item, 14);
    }

    hide() {
        if (!this._actor)
            return;
        this._watch.cancel();
        this._item?.app.disconnectObject(this);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._actor.destroy();
        this._actor = null;
        this._item = null;
        this._dock.onPopupClosed();
    }

    destroy() {
        this.hide();
    }
}
