// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// start/styles/alphabetical.js — estilo "Lista alfabética":
//
//   ┌──┬──────────────────┬────────────────┐
//   │  │ 🔍 Pesquisar…     │ Fixados        │
//   │  │ A                │ ▢  ▢  ▢        │
//   │  │  ▢ App           │ ▢  ▢  ▢        │
//   │📄│  ▢ App           │ ▢  ▢  ▢        │
//   │🖼│ B                │                │
//   │⚙ │  ▢ App           │                │
//   │👤│ …                │                │
//   │⏻ │                  │                │
//   └──┴──────────────────┴────────────────┘
//
// Todos os apps de A a Z com as letras como índice: clicar numa letra
// mostra a grade de letras, e escolher uma pula direto para ela. Os
// fixados ficam na coluna da direita (arrastar muda a ordem).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlphaList, AppGrid, LETTERS, avatar, userName} from '../parts.js';
import {iconButton, sectionHeader} from '../widgets.js';
import {BaseStyle} from './base.js';

const WIDTH = 720;
const HEIGHT = 620;
const PINNED_COLUMNS = 3;
const PINNED_ROWS = 4;
const LETTER_COLUMNS = 4;

export class AlphabeticalStyle extends BaseStyle {
    constructor(menu, factor) {
        super(menu, factor, {id: 'alphabetical', width: WIDTH, height: HEIGHT, vertical: false});

        // ---- Faixa da esquerda: atalhos só com ícones ----
        const rail = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-alpha-rail'});
        rail.add_child(new St.Widget({y_expand: true}));
        for (const place of this.data.places().slice(0, 2))
            rail.add_child(iconButton(place.iconName, place.name, () => menu.openFile(place.file)));
        rail.add_child(iconButton('emblem-system-symbolic', _('Settings'),
            () => menu.launchId('org.gnome.Settings.desktop')));
        const user = new St.Button({style_class: 'orla-start-round', can_focus: true, accessible_name: userName(),
            child: avatar(22)});
        user.connect('clicked', () => menu.launchId('gnome-users-panel.desktop'));
        rail.add_child(user);
        const power = iconButton('system-shutdown-symbolic', _('Power Off / Log Out'), () => {
            const [x, y] = power.get_transformed_position();
            menu.showContextMenu(menu.powerItems(), x + power.width, y);
        });
        rail.add_child(power);
        this.actor.add_child(rail);

        // ---- Meio: busca e a lista de A a Z ----
        const middle = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-alpha-middle',
            x_expand: true, y_expand: true});
        middle.add_child(this.makeEntry(_('Search apps, files and settings')));
        this._alpha = new AlphaList(menu, {rail: false, onLetter: () => this._showLetters(true)});
        middle.add_child(this._alpha.actor);
        this._letters = new St.Widget({
            style_class: 'orla-start-letter-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true}),
            x_expand: true, y_expand: true, visible: false,
        });
        middle.add_child(this._letters);
        middle.add_child(this.results.actor);
        this.actor.add_child(middle);

        // ---- Direita: fixados ----
        const right = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-alpha-pinned'});
        right.add_child(sectionHeader(_('Pinned')));
        this._pinned = new AppGrid(menu, {
            source: () => this.data.pinnedApps(),
            columns: PINNED_COLUMNS,
            rows: PINNED_ROWS,
            reorder: true,
        });
        right.add_child(this._pinned.actor);
        this.actor.add_child(right);

        this.hideWhileSearching(this._alpha.actor, this._letters);
        this._areas = [this.entry, this._alpha.actor, this._letters, right, rail];
    }

    onReset() {
        if (this._showingLetters)
            this._showLetters(false);
        this._alpha.reset();
        this._pinned.reset();
    }

    refresh(parts) {
        if (parts.has('apps'))
            this._alpha.refresh();
        if (parts.has('pinned') || parts.has('apps'))
            this._pinned.refresh();
        if (parts.has('running'))
            this._pinned.updateRunning();
    }

    /** A grade de letras (as que não têm app ficam apagadas). */
    _showLetters(on) {
        if (on) {
            this._letters.destroy_all_children();
            const present = new Set(this._alpha.letters);
            LETTERS.forEach((letter, i) => {
                const has = present.has(letter);
                const button = new St.Button({
                    style_class: 'orla-start-letter-key',
                    label: letter,
                    can_focus: has,
                    reactive: has,
                    accessible_name: _('Apps starting with %s').format(letter),
                });
                if (!has)
                    button.add_style_pseudo_class('insensitive');
                button.connect('clicked', () => {
                    this._showLetters(false);
                    this._alpha.scrollTo(letter, {focus: true});
                });
                this._letters.layout_manager.attach(button, i % LETTER_COLUMNS, Math.floor(i / LETTER_COLUMNS), 1, 1);
            });
        }
        this._showingLetters = on;
        this.setWanted(this._letters, on);
        this.setWanted(this._alpha.actor, !on);
        if (on)
            this._letters.get_children().find(c => c.can_focus)?.grab_key_focus();
    }

    escape() {
        if (super.escape())
            return true;
        if (this._showingLetters) {
            this._showLetters(false);
            this._alpha.focusFirst();
            return true;
        }
        return false;
    }

    focusContent() {
        if (this._showingLetters)
            this._letters.get_children().find(c => c.can_focus)?.grab_key_focus();
        else
            this._alpha.focusFirst();
    }
}
