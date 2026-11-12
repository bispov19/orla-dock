// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/stylesPage.js — aba "Estilos": escolhe o estilo da barra.
//
// A lista vem do REGISTRO ÚNICO em lib/styles.js: um estilo novo
// registrado lá aparece aqui sozinho, sem mexer nesta página.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {STYLES} from '../lib/styles.js';
import {group, spinRow, switchRow} from './rows.js';

export function stylesPage(binder) {
    const page = new Adw.PreferencesPage({
        title: _('Styles'),
        icon_name: 'view-grid-symbolic',
    });

    const choose = group(page, _('Bar style'),
        _('Pick how the Dock looks and behaves. Each style keeps its own options below.'));

    // Um "cartão" (linha) por estilo, com um botão de rádio: os
    // Gtk.CheckButton do mesmo `group` só deixam um marcado por vez.
    const buttons = new Map();
    let first = null;
    for (const style of STYLES) {
        const radio = new Gtk.CheckButton({valign: Gtk.Align.CENTER, group: first});
        first ??= radio;
        const row = new Adw.ActionRow({
            title: _(style.name),
            subtitle: _(style.description),
            activatable_widget: radio,
        });
        row.add_prefix(radio);
        row.add_suffix(new Gtk.Image({icon_name: style.icon, pixel_size: 32, css_classes: ['dim-label']}));
        choose.add(row);
        buttons.set(style.id, radio);
    }
    binder.choice('bar-style', buttons);

    // --- Opções específicas de cada estilo ---
    const taskbar = group(page, _('Taskbar (Windows 10)'));
    taskbar.add(spinRow(binder, 'taskbar-icon-size', _('Icon size'), 16, 64));
    taskbar.add(switchRow(binder, 'taskbar-clock', _('Show clock and date')));
    binder.showWhen('bar-style', s => s.get_string('bar-style') === 'taskbar', taskbar);

    const dock = group(page, _('Dock (macOS)'),
        _('Size and magnification are on the Layout page'));
    dock.add(switchRow(binder, 'icon-reflection', _('Icon reflection'),
        _('A subtle reflection under the icons (bottom Dock only)')));
    binder.showWhen('bar-style', s => s.get_string('bar-style') === 'dock', dock);

    return page;
}
