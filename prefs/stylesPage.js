// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/stylesPage.js — aba "Estilos": escolhe o estilo da barra.
//
// Como na Luma Dock: clicar num cartão só MOSTRA a prévia; o estilo muda de
// verdade quando você aperta "Aplicar". A lista vem do REGISTRO ÚNICO em
// lib/styles.js: um estilo novo registrado lá aparece aqui sozinho, já com
// prévia (desenhada a partir das marcas dele, em prefs/previews.js).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {STYLES, getStyle} from '../lib/styles.js';
import {drawingArea, paintStylePreview} from './previews.js';
import {group, spinRow, switchRow} from './rows.js';
import {taskbarPanelGroups} from './taskbarPanel.js';

const PREVIEW_HEIGHT = 250;

export function stylesPage(binder) {
    const settings = binder.settings;
    const page = new Adw.PreferencesPage({
        title: _('Styles'),
        icon_name: 'view-grid-symbolic',
    });

    const choose = group(page, _('Bar style'),
        _('Pick a style to preview it, then apply it. Each style keeps its own options below.'));

    // O estilo em PRÉVIA (pode ser diferente do aplicado).
    let previewId = getStyle(settings.get_string('bar-style')).id;

    // --- Prévia grande ---
    const preview = drawingArea(560, PREVIEW_HEIGHT,
        (cr, w, h) => paintStylePreview(cr, w, h, getStyle(previewId)),
        {hexpand: true, margin_bottom: 12});
    choose.add(preview);

    // --- Situação + botão Aplicar ---
    const status = new Gtk.Label({
        xalign: 0, hexpand: true, wrap: true,
        css_classes: ['dim-label'],
    });
    const apply = new Gtk.Button({
        label: _('Apply'),
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action', 'pill'],
    });
    const actions = new Gtk.Box({spacing: 12, margin_bottom: 12});
    actions.append(status);
    actions.append(apply);
    choose.add(actions);

    // --- Cartões (um por estilo, 2 por linha) ---
    const grid = new Gtk.Grid({column_spacing: 12, row_spacing: 12, column_homogeneous: true});
    const cards = new Map();
    let first = null;
    STYLES.forEach((style, i) => {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
        });
        content.append(drawingArea(220, 110, (cr, w, h) => paintStylePreview(cr, w, h, style),
            {hexpand: true}));
        content.append(new Gtk.Label({label: _(style.name), xalign: 0, css_classes: ['heading']}));
        content.append(new Gtk.Label({
            label: _(style.description), xalign: 0, wrap: true, width_chars: 1,
            css_classes: ['dim-label', 'caption'],
        }));
        const card = new Gtk.ToggleButton({child: content, hexpand: true, css_classes: ['card']});
        if (first)
            card.set_group(first);
        else
            first = card;
        card.connect('toggled', () => {
            if (!card.active)
                return;
            previewId = style.id;
            sync();
        });
        grid.attach(card, i % 2, Math.floor(i / 2), 1, 1);
        cards.set(style.id, card);
    });
    choose.add(grid);

    const sync = () => {
        const applied = getStyle(settings.get_string('bar-style'));
        const shown = getStyle(previewId);
        cards.get(shown.id).active = true;
        preview.queue_draw();
        if (shown.id === applied.id) {
            status.label = `${_('Current style')}: ${_(applied.name)}`;
            apply.sensitive = false;
        } else {
            status.label = `${_('Preview')}: ${_(shown.name)}. ${_('Not applied yet')}`;
            apply.sensitive = true;
        }
    };
    apply.connect('clicked', () => settings.set_string('bar-style', previewId));
    // Mudou por fora (ex.: menu da dock): a prévia acompanha.
    binder.watchOther(settings, 'bar-style', () => {
        previewId = getStyle(settings.get_string('bar-style')).id;
        sync();
    });
    sync();

    // --- Opções específicas de cada estilo ---
    const isTaskbar = s => getStyle(s.get_string('bar-style')).fullWidth;
    const taskbar = group(page, _('Taskbar (Windows 10)'));
    taskbar.add(spinRow(binder, 'taskbar-icon-size', _('Icon size'), 16, 64));
    const ownClock = switchRow(binder, 'taskbar-clock', _('Show clock and date'),
        _('When the Panel mode is off'));
    taskbar.add(ownClock);
    binder.showWhen('bar-style', isTaskbar, taskbar);
    binder.showWhen('taskbar-merge-panel', s => !s.get_boolean('taskbar-merge-panel'), ownClock);

    // Modo painel, Menu Iniciar, relógio e bandeja: o modelo da Luma Dock.
    taskbarPanelGroups(page, binder, isTaskbar);

    const dock = group(page, _('Dock (macOS)'),
        _('Size and magnification are on the Layout page'));
    dock.add(switchRow(binder, 'icon-reflection', _('Icon reflection'),
        _('A subtle reflection under the icons (bottom Dock only)')));
    binder.showWhen('bar-style', s => s.get_string('bar-style') === 'dock', dock);

    return page;
}
