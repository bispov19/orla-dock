// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/styles/launchpad.js — estilo "Grade flutuante central": um painel
// no centro da tela, acima da dock, com ícones grandes em páginas.
//
//   ┌─────────────────────────────────────────┐
//   │            🔍 Pesquisar                  │
//   │  ┌───────────────────────────────────┐  │  fixados em destaque
//   │  │  ◉   ◉   ◉   ◉   ◉   ◉   ◉        │  │
//   │  └───────────────────────────────────┘  │
//   │   ◉   ◉   ◉   ◉   ◉   ◉   ◉             │  todos os apps, em
//   │   ◉   ◉   ◉   ◉   ◉   ◉   ◉             │  páginas (rodinha,
//   │   ◉   ◉   ◉   ◉   ◉   ◉   ◉             │  PageUp/PageDown ou
//   │                • • •                     │  setas na borda)
//   └─────────────────────────────────────────┘
//
// Só as células da página visível existem: abrir é rápido mesmo com
// centenas de apps.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppGrid} from '../parts.js';
import {BaseStyle} from './base.js';

const WIDTH = 940;
const HEIGHT = 680;
const CELL = 124;
const ICON = 64;
const PINNED_ICON = 48;
const ROWS = 3;

export class LaunchpadStyle extends BaseStyle {
    constructor(menu, factor) {
        super(menu, factor, {id: 'launchpad', width: WIDTH, height: HEIGHT});
        // Sempre no centro: é o jeito deste estilo.
        this.placement = 'center';
        const columns = this.columnsFor(WIDTH - 60, CELL);

        const top = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'orla-start-launchpad-top'});
        const entry = this.makeEntry(_('Search'));
        entry.width = Math.round(380 * factor);
        top.add_child(entry);
        this.actor.add_child(top);

        this._pinnedBox = new St.BoxLayout({style_class: 'orla-start-launchpad-pinned', x_expand: true});
        this._pinned = new AppGrid(menu, {
            source: () => this.data.pinnedApps(),
            columns,
            rows: 1,
            reorder: true,
            iconSize: PINNED_ICON,
            cellClass: 'orla-start-cell-big',
        });
        this._pinnedBox.add_child(this._pinned.actor);
        this.actor.add_child(this._pinnedBox);

        this._all = new AppGrid(menu, {
            source: () => this.data.allApps(),
            columns,
            rows: ROWS,
            iconSize: ICON,
            cellClass: 'orla-start-cell-big',
        });
        this._all.actor.y_expand = true;
        this._all.actor.y_align = Clutter.ActorAlign.CENTER;
        this.actor.add_child(this._all.actor);
        this.actor.add_child(this.results.actor);

        this.hideWhileSearching(this._pinnedBox, this._all.actor);
        this._areas = [this.entry, this._pinnedBox, this._all.actor];
    }

    onReset() {
        this._pinned.reset();
        this._all.reset();
    }

    refresh(parts) {
        if (parts.has('pinned') || parts.has('apps')) {
            this._pinned.refresh();
            this.setWanted(this._pinnedBox, !this._pinned.isEmpty);
        }
        if (parts.has('apps'))
            this._all.refresh();
        if (parts.has('running')) {
            this._pinned.updateRunning();
            this._all.updateRunning();
        }
    }

    handleKey(event) {
        if (this.searching)
            return false;
        const focus = global.stage.get_key_focus();
        if (focus && this._pinnedBox.contains(focus))
            return this._pinned.handleKey(event);
        return this._all.handleKey(event);
    }

    focusContent() {
        this._all.focusFirst();
    }
}
