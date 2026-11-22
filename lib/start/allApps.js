// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/allApps.js — "Todos os apps": em ordem alfabética, agrupados pela
// primeira letra, em lista ou em grade (start-menu-all-apps-grid). Ao
// lado, um índice com as letras leva direto ao grupo.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppCell, Row, iconButton} from './widgets.js';

const GRID_COLUMNS = 6;

/** A letra do grupo: A–Z sem acento; números e símbolos em "#". */
function groupOf(name) {
    const first = name.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : '#';
}

export class AllAppsView {
    constructor(menu) {
        this._menu = menu;
        this.actor = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-view', y_expand: true});

        const header = new St.BoxLayout({style_class: 'orla-start-section-header'});
        header.add_child(iconButton('go-previous-symbolic', _('Back'), () => menu.showHome()));
        header.add_child(new St.Label({text: _('All apps'), style_class: 'orla-start-section-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._toggle = iconButton('view-grid-symbolic', _('Switch between list and grid'), () => {
            const settings = menu.settings;
            settings.set_boolean('start-menu-all-apps-grid', !settings.get_boolean('start-menu-all-apps-grid'));
            this.refresh();
        });
        header.add_child(this._toggle);
        this.actor.add_child(header);

        const body = new St.BoxLayout({y_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'orla-start-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true,
        });
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-all-list'});
        this._scroll.set_child(this._list);
        body.add_child(this._scroll);
        this._rail = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-rail'});
        body.add_child(this._rail);
        this.actor.add_child(body);
        this._headers = new Map();
    }

    refresh() {
        const grid = this._menu.settings.get_boolean('start-menu-all-apps-grid');
        this._toggle.child.icon_name = grid ? 'view-list-symbolic' : 'view-grid-symbolic';
        this._list.destroy_all_children();
        this._rail.destroy_all_children();
        this._headers.clear();

        const groups = new Map();
        for (const app of this._menu.data.allApps()) {
            const key = groupOf(app.get_name());
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(app);
        }
        const keys = [...groups.keys()].sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)));
        for (const key of keys) {
            const header = new St.Label({text: key, style_class: 'orla-start-letter'});
            this._headers.set(key, header);
            this._list.add_child(header);
            this._list.add_child(grid ? this._gridOf(groups.get(key)) : this._listOf(groups.get(key)));

            const jump = new St.Button({style_class: 'orla-start-rail-key', label: key, can_focus: false});
            jump.connect('clicked', () => this._scrollTo(key));
            this._rail.add_child(jump);
        }
        this._scroll.vadjustment.value = 0;
    }

    _menuOf(app) {
        return () => this._menu.appMenu(app);
    }

    _listOf(apps) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        for (const app of apps) {
            box.add_child(new Row({
                gicon: app.get_icon(),
                title: app.get_name(),
                activate: () => this._menu.launch(app),
                menu: this._menuOf(app),
                owner: this._menu,
            }));
        }
        return box;
    }

    _gridOf(apps) {
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true})});
        apps.forEach((app, i) => {
            grid.layout_manager.attach(new AppCell({
                gicon: app.get_icon(),
                name: app.get_name(),
                running: app.get_n_windows() > 0,
                activate: () => this._menu.launch(app),
                menu: this._menuOf(app),
                owner: this._menu,
            }), i % GRID_COLUMNS, Math.floor(i / GRID_COLUMNS), 1, 1);
        });
        return grid;
    }

    _scrollTo(key) {
        const header = this._headers.get(key);
        if (!header)
            return;
        const adjustment = this._scroll.vadjustment;
        adjustment.ease(Math.min(header.y, adjustment.upper - adjustment.page_size), {
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    focusFirst() {
        const first = this._list.get_child_at_index(1);
        (first?.get_first_child?.() ?? first)?.grab_key_focus();
    }

    destroy() {
        this.actor.destroy();
    }
}
