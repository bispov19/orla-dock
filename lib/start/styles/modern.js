// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/styles/modern.js — estilo "Clássico moderno":
//
//   ┌──────────────────────────────────┐
//   │ 🔍 Pesquisar apps, arquivos…      │  busca: apps, arquivos, sistema
//   │ Fixados              Todos ›     │  grade em páginas (arrastar ordena)
//   │ ▢ ▢ ▢ ▢ ▢ ▢                      │
//   │ Recentes                          │  apps e arquivos recentes
//   │ 👤 Nome            🔒  ⏸  ⏻      │  usuário, bloquear, suspender, energia
//   └──────────────────────────────────┘
//
// "Todos ›" troca a parte do meio pela lista de A a Z (Esc ou ‹ voltam).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlphaList, AppGrid, RecentFiles, lockButton, powerButton, settingsButton, suspendButton,
    userButton} from '../parts.js';
import {Row, iconButton, sectionHeader} from '../widgets.js';
import {BaseStyle} from './base.js';

const WIDTH = 640;
const HEIGHT = 660;
const CELL = 100;
const ROWS = 3;
const RECENT_APPS = 4;

export class ModernStyle extends BaseStyle {
    constructor(menu, factor) {
        super(menu, factor, {id: 'modern', width: WIDTH, height: HEIGHT});
        this._showingAll = false;

        this.actor.add_child(this.makeEntry(_('Type an app, file, setting or a calculation')));

        // Início: fixados + recentes.
        this._home = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-view',
            x_expand: true, y_expand: true});
        this._home.add_child(sectionHeader(_('Pinned'), {label: _('All apps'), activate: () => this.showAll(true)}));
        this._pinned = new AppGrid(menu, {
            source: () => this.data.pinnedApps(),
            columns: this.columnsFor(WIDTH - 40, CELL),
            rows: ROWS,
            reorder: true,
        });
        this._home.add_child(this._pinned.actor);
        this._emptyPinned = new St.Label({text: _('Right-click an app and choose “Pin” to see it here'),
            style_class: 'orla-start-empty', x_align: Clutter.ActorAlign.CENTER, visible: false});
        this._home.add_child(this._emptyPinned);

        const scroll = new St.ScrollView({
            style_class: 'orla-start-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true,
        });
        this._recentBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._recentApps = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._recentBox.add_child(this._recentApps);
        this._files = new RecentFiles(menu, {columns: 2});
        this._recentBox.add_child(this._files.actor);
        scroll.set_child(this._recentBox);
        this._scroll = scroll;
        this._home.add_child(scroll);
        this.actor.add_child(this._home);

        // Todos os apps, de A a Z.
        this._all = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-view',
            x_expand: true, y_expand: true, visible: false});
        const header = new St.BoxLayout({style_class: 'orla-start-section-header'});
        header.add_child(iconButton('go-previous-symbolic', _('Back'), () => this.showAll(false)));
        header.add_child(new St.Label({text: _('All apps'), style_class: 'orla-start-section-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._gridToggle = iconButton('view-grid-symbolic', _('Switch between list and grid'), () => {
            const settings = menu.settings;
            settings.set_boolean('start-menu-all-apps-grid', !settings.get_boolean('start-menu-all-apps-grid'));
            this._makeAlpha();
            this._alpha.refresh();
            this._alpha.focusFirst();
        });
        header.add_child(this._gridToggle);
        this._all.add_child(header);
        this._alpha = null;
        this._makeAlpha();
        this.actor.add_child(this._all);

        this.actor.add_child(this.results.actor);

        // Rodapé.
        this._footer = new St.BoxLayout({style_class: 'orla-start-footer'});
        this._footer.add_child(userButton(menu));
        this._footer.add_child(new St.Widget({x_expand: true}));
        this._footer.add_child(lockButton(menu));
        this._footer.add_child(suspendButton(menu));
        this._footer.add_child(settingsButton(menu));
        this._footer.add_child(powerButton(menu));
        this.actor.add_child(this._footer);

        this.hideWhileSearching(this._home, this._all);
        this._areas = [this.entry, this._home, this._all, this._footer];
    }

    /** A lista de A a Z, em lista ou em grade (opção start-menu-all-apps-grid). */
    _makeAlpha() {
        const grid = this.menu.settings.get_boolean('start-menu-all-apps-grid');
        this._gridToggle.child.icon_name = grid ? 'view-list-symbolic' : 'view-grid-symbolic';
        this._alpha?.destroy();
        this._alpha = new AlphaList(this.menu, {grid, columns: this.columnsFor(WIDTH - 70, CELL)});
        this._all.add_child(this._alpha.actor);
    }

    showAll(on, {focus = true} = {}) {
        this._showingAll = on;
        this.setWanted(this._home, !on);
        this.setWanted(this._all, on);
        if (on) {
            this._alpha.refresh();      // só refaz se um app entrou/saiu
            this._alpha.reset();
        }
        if (focus) {
            if (on)
                this._alpha.focusFirst();
            else
                this._pinned.focusFirst();
        }
    }

    onReset() {
        if (this._showingAll)
            this.showAll(false, {focus: false});
        this._pinned.reset();
        this._scroll.vadjustment.value = 0;
    }

    refresh(parts) {
        if (parts.has('pinned') || parts.has('apps')) {
            this._pinned.refresh();
            this._emptyPinned.visible = this._pinned.isEmpty;
        }
        if (parts.has('running'))
            this._pinned.updateRunning();
        if (parts.has('recent') || parts.has('running'))
            this._buildRecentApps();
        if (parts.has('files'))
            this._files.refresh();
        if (parts.has('apps') && this._showingAll)
            this._alpha.refresh();
    }

    _buildRecentApps() {
        this._recentApps.destroy_all_children();
        const apps = this.menu.settings.get_boolean('start-menu-recent-apps')
            ? this.data.recentApps(RECENT_APPS) : [];
        if (!apps.length)
            return;
        this._recentApps.add_child(sectionHeader(_('Recent apps')));
        const grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: 6, row_spacing: 2}),
        });
        apps.forEach((app, i) => {
            grid.layout_manager.attach(new Row({
                app,
                subtitle: app.get_n_windows() > 0 ? _('Open') : '',
                activate: () => this.menu.launch(app),
                menu: () => this.menu.appMenu(app),
                owner: this.menu,
            }), i % 2, Math.floor(i / 2), 1, 1);
        });
        this._recentApps.add_child(grid);
    }

    escape() {
        if (super.escape())
            return true;
        if (this._showingAll) {
            this.showAll(false);
            return true;
        }
        return false;
    }

    handleKey(event) {
        return !this._showingAll && !this.searching && this._pinned.handleKey(event);
    }

    focusContent() {
        if (this._showingAll)
            this._alpha.focusFirst();
        else
            this._pinned.focusFirst();
    }

    destroy() {
        this._files.destroy();
        super.destroy();
    }
}
