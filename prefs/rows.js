// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
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

/** Linha clicável que abre um endereço no navegador. */
export function linkRow(window, title, subtitle, uri, icon) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_prefix(new Gtk.Image({icon_name: icon}));
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    // Gtk.UriLauncher abre o link no aplicativo padrão (o navegador).
    row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
    return row;
}

/** Um bloco de texto que quebra linha, dentro de um cartão. */
export function textRow(text) {
    const row = new Adw.PreferencesRow({activatable: false});
    row.set_child(new Gtk.Label({
        label: text,
        wrap: true,
        xalign: 0,
        margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
    }));
    return row;
}

