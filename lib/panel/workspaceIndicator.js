// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// panel/workspaceIndicator.js — indicador de áreas de trabalho do modo
// Painel: um ponto por workspace; o atual fica alongado.
//
// - Clique: abre/fecha a Visão Geral.
// - Rodinha do mouse: vai para o workspace anterior/seguinte.
// - Opção "Indicador de workspaces" (panel-workspace-indicator): mostra ou
//   esconde.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const WorkspaceIndicator = GObject.registerClass(
class OrlaWorkspaceIndicator extends St.Button {
    /**
     * @param {Gio.Settings} settings - as configurações da Orla
     * @param {Function} onResize - avisa a barra que o tamanho mudou
     */
    _init(settings, onResize) {
        super._init({
            style_class: 'panel-button orla-ws-button',
            can_focus: false,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._settings = settings;
        this._onResize = onResize;
        this._vertical = false;
        this._dots = new St.BoxLayout({style_class: 'orla-ws', y_align: Clutter.ActorAlign.CENTER});
        this.set_child(this._dots);

        this.connect('clicked', () => Main.overview.toggle());
        this.connect('scroll-event', (_a, event) => this._onScroll(event));
        const sync = () => this._sync();
        global.workspace_manager.connectObject(
            'active-workspace-changed', sync,
            'notify::n-workspaces', sync,
            this);
        settings.connectObject('changed::panel-workspace-indicator', () => {
            this._syncVisible();
            this._onResize();
        }, this);
        this.connect('destroy', () => {
            global.workspace_manager.disconnectObject(this);
            settings.disconnectObject(this);
        });
        this._syncVisible();
        this._sync();
    }

    setVertical(vertical) {
        this._vertical = vertical;
        this._dots.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        this._sync();
    }

    _syncVisible() {
        this.visible = this._settings.get_boolean('panel-workspace-indicator');
    }

    _sync() {
        const manager = global.workspace_manager;
        const count = manager.get_n_workspaces();
        const active = manager.get_active_workspace_index();
        // Reaproveita os pontos e só cria/remove o que faltar ou sobrar.
        while (this._dots.get_n_children() < count)
            this._dots.add_child(new St.Widget({style_class: 'orla-ws-dot', y_align: Clutter.ActorAlign.CENTER}));
        while (this._dots.get_n_children() > count)
            this._dots.get_last_child().destroy();
        this._dots.get_children().forEach((dot, i) => {
            dot.style_class = [
                'orla-ws-dot',
                this._vertical ? 'orla-ws-vertical' : '',
                i === active ? 'orla-ws-active' : '',
            ].join(' ').trim();
        });
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        let step = 0;
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            step = -1;
        else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
            step = 1;
        if (!step)
            return Clutter.EVENT_PROPAGATE;
        const manager = global.workspace_manager;
        const target = manager.get_active_workspace_index() + step;
        if (target >= 0 && target < manager.get_n_workspaces())
            manager.get_workspace_by_index(target).activate(global.get_current_time());
        return Clutter.EVENT_STOP;
    }
});
