// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// prefs/rows.js — linhas prontas, já ligadas ao GSettings, usadas por
// todas as páginas de preferências.
//
// Estrutura do libadwaita (Adw):
//   Adw.PreferencesPage   → uma "aba" (aparece no seletor do topo)
//   Adw.PreferencesGroup  → um bloco com título dentro da página
//   Adw.*Row              → cada linha: SwitchRow (liga/desliga),
//                           ComboRow (lista), ActionRow (genérica)…

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {comboRow, scaleRow} from './widgets.js';

export function group(page, title, description = null) {
    const g = new Adw.PreferencesGroup({title, description});
    page.add(g);
    return g;
}

export function switchRow(binder, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    binder.bool(key, row);
    return row;
}

export function sliderRow(binder, key, title, subtitle, params, integer = false) {
    const {row, adjustment} = scaleRow(title, subtitle, params);
    binder.number(key, adjustment, {integer});
    return row;
}

export function spinRow(binder, key, title, lower, upper, subtitle = null) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
    });
    binder.number(key, row.adjustment, {integer: true});
    return row;
}

export function enumRow(binder, key, title, items, subtitle = null) {
    const row = comboRow(title, items, subtitle);
    binder.enum(key, row);
    return row;
}
