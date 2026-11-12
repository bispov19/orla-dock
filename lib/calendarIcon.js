// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// calendarIcon.js — ícone do Calendário que mostra o dia de HOJE (como no
// macOS), em vez da data fixa desenhada no tema de ícones.
//
// O desenho é feito só com atores St (um bloco branco arredondado com dois
// rótulos), então segue a escala HiDPI automaticamente e fica nítido em
// qualquer tamanho — inclusive ampliado.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const CALENDAR_APP_IDS = ['org.gnome.Calendar.desktop', 'gnome-calendar.desktop'];

export function isCalendarApp(app) {
    return CALENDAR_APP_IDS.includes(app?.get_id());
}

/** Texto que identifica o dia (para saber quando ele muda). */
export function todayKey() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

/**
 * Cria o ícone no tamanho `size` (px lógicos). O bloco ocupa ~86% do
 * tamanho, como a maioria dos ícones de apps (que têm um respiro nas bordas).
 */
export function createCalendarIcon(size) {
    const now = GLib.DateTime.new_now_local();
    // %b = mês abreviado no idioma do sistema ("nov." em pt-BR).
    const month = now.format('%b').replace('.', '').toUpperCase();
    const day = now.format('%e').trim();

    const tile = Math.round(size * 0.86);
    const box = new Clutter.Actor({width: size, height: size});
    const card = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'orla-calendar-icon',
        style: `border-radius: ${Math.round(tile * 0.22)}px;` +
            `padding-top: ${Math.round(tile * 0.07)}px;`,
        width: tile,
        height: tile,
    });
    card.set_position(Math.round((size - tile) / 2), Math.round((size - tile) / 2));

    card.add_child(new St.Label({
        text: month,
        style_class: 'orla-calendar-month',
        style: `font-size: ${Math.max(6, Math.round(tile * 0.19))}px;`,
        x_align: Clutter.ActorAlign.CENTER,
    }));
    card.add_child(new St.Label({
        text: day,
        style_class: 'orla-calendar-day',
        style: `font-size: ${Math.max(10, Math.round(tile * 0.52))}px;`,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        y_expand: true,
    }));
    box.add_child(card);
    return box;
}
