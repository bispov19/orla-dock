// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/logoPicker.js — galeria de logos do botão de aplicativos.
//
// Mesmo padrão das outras escolhas com prévia: um cartão por logo e clicar
// no cartão aplica na hora (a dock troca o ícone sem reiniciar nada).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LOGOS, SYSTEM_LOGO, logoPath} from '../lib/logos.js';

const KEY = 'apps-button-logo';

function logoTitle(id) {
    const titles = {
        'orla-dock': 'Orla Dock',
        [SYSTEM_LOGO]: _('From the system'),
        fedora: 'Fedora',
        gnome: 'GNOME',
        ubuntu: 'Ubuntu',
        debian: 'Debian',
        archlinux: 'Arch Linux',
        manjaro: 'Manjaro',
        linuxmint: 'Linux Mint',
        opensuse: 'openSUSE',
        elementary: 'elementary OS',
    };
    return titles[id] ?? id;
}

function logoImage(extensionPath, id) {
    const path = logoPath(extensionPath, id);
    const image = new Gtk.Image({pixel_size: 48});
    if (path)
        image.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(path)});
    else
        image.icon_name = GLib.get_os_info('LOGO') || 'start-here';
    return image;
}

export function logoPicker(binder, extensionPath) {
    const settings = binder.settings;
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        min_children_per_line: 3,
        max_children_per_line: 6,
        row_spacing: 8,
        column_spacing: 8,
    });

    const cards = new Map();
    let first = null;
    for (const {id} of LOGOS) {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 10, margin_bottom: 8, margin_start: 6, margin_end: 6,
        });
        content.append(logoImage(extensionPath, id));
        content.append(new Gtk.Label({
            label: logoTitle(id), wrap: true, justify: Gtk.Justification.CENTER,
            width_chars: 1, css_classes: ['caption'],
        }));
        const card = new Gtk.ToggleButton({child: content, css_classes: ['card']});
        if (id === SYSTEM_LOGO)
            card.tooltip_text = _('The logo your Linux distribution ships');
        if (first)
            card.set_group(first);
        else
            first = card;
        card.connect('toggled', () => {
            if (card.active && settings.get_string(KEY) !== id)
                settings.set_string(KEY, id);
        });
        // Sem isto o FlowBoxChild também "pega" o foco e o clique fica duplo.
        flow.append(new Gtk.FlowBoxChild({child: card, focusable: false}));
        cards.set(id, card);
    }

    const sync = () => {
        const card = cards.get(settings.get_string(KEY)) ?? cards.get(LOGOS[0].id);
        card.active = true;
    };
    binder.watchOther(settings, KEY, sync);
    sync();
    return flow;
}
