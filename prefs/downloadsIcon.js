// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/downloadsIcon.js — escolha do ícone do Downloads, com prévia.
//
// Mesmo padrão da escolha de posição: um cartão por estilo e clicar no
// cartão aplica na hora. Cada prévia mostra o ícone em cima de uma dock
// escura e de uma clara, para ver como fica nos dois modos.

import cairo from 'gi://cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {drawingArea, roundedRect} from './previews.js';

const STYLES = ['files', 'arrow'];

/** "Pasta com arquivos": os arquivos mais recentes empilhados e girados. */
function paintFiles(cr, x, y, s) {
    // Cores de "miniaturas" de mentira: foto, PDF e documento.
    const sheets = [
        {angle: -8, band: [0.86, 0.26, 0.24]},
        {angle: 6, band: [0.25, 0.55, 0.95]},
        {angle: 0, band: null},
    ];
    const w = s * 0.62, h = s * 0.74;
    for (const {angle, band} of sheets) {
        cr.save();
        cr.translate(x + s / 2, y + s * 0.92);
        cr.rotate(angle * Math.PI / 180);
        const left = -w / 2, top = -h;
        roundedRect(cr, left, top, w, h, s * 0.06);
        cr.setSourceRGB(0.98, 0.98, 0.99);
        cr.fillPreserve();
        cr.setSourceRGBA(0, 0, 0, 0.18);
        cr.setLineWidth(Math.max(1, s * 0.012));
        cr.stroke();
        if (band) {
            cr.rectangle(left + w * 0.14, top + h * 0.16, w * 0.72, h * 0.12);
            cr.setSourceRGB(...band);
            cr.fill();
            for (let i = 0; i < 3; i++) {
                cr.rectangle(left + w * 0.14, top + h * (0.4 + i * 0.14), w * (0.72 - i * 0.12), h * 0.05);
                cr.setSourceRGBA(0.3, 0.3, 0.35, 0.45);
                cr.fill();
            }
        } else {
            // A da frente é uma "foto".
            const photo = new cairo.LinearGradient(0, top, 0, 0);
            photo.addColorStopRGB(0, 0.98, 0.55, 0.3);
            photo.addColorStopRGB(1, 0.86, 0.25, 0.55);
            roundedRect(cr, left + w * 0.1, top + h * 0.1, w * 0.8, h * 0.8, s * 0.04);
            cr.setSource(photo);
            cr.fill();
        }
        cr.restore();
    }
}

/** "Pasta com seta de download": o próprio SVG da extensão. */
function arrowPainter(extensionPath) {
    const path = GLib.build_filenamev([extensionPath, 'icons', 'downloads-folder.svg']);
    const cache = new Map();
    return (cr, x, y, s) => {
        const px = Math.max(8, Math.round(s));
        let pixbuf = cache.get(px);
        if (!pixbuf) {
            try {
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, px, px);
            } catch {
                return;
            }
            cache.set(px, pixbuf);
        }
        Gdk.cairo_set_source_pixbuf(cr, pixbuf, x, y);
        cr.paint();
    };
}

/** Uma prévia: o ícone sobre uma dock escura e sobre uma clara. */
function paintCard(cr, w, h, paintIcon, selected) {
    const chipW = w / 2 - 6, chipH = h - 4;
    [[0.13, 0.13, 0.16], [0.93, 0.93, 0.95]].forEach((rgb, i) => {
        const cx = 2 + i * (chipW + 8);
        roundedRect(cr, cx, 2, chipW, chipH, 10);
        cr.setSourceRGB(...rgb);
        cr.fillPreserve();
        cr.setSourceRGBA(selected ? 0.21 : 1, selected ? 0.52 : 1, selected ? 0.89 : 1, selected ? 0.9 : 0.2);
        cr.setLineWidth(selected ? 2 : 1);
        cr.stroke();
        const s = Math.min(chipW, chipH) * 0.72;
        paintIcon(cr, cx + (chipW - s) / 2, 2 + (chipH - s) / 2, s);
    });
}

export function downloadsIconCards(binder, extensionPath) {
    const settings = binder.settings;
    const titles = {files: _('Folder with files'), arrow: _('Folder with download arrow')};
    const subtitles = {
        files: _('The newest files pile up on the icon'),
        arrow: _('A clean folder with a download arrow'),
    };
    const painters = {files: paintFiles, arrow: arrowPainter(extensionPath)};

    const box = new Gtk.Box({spacing: 12, homogeneous: true});
    const cards = new Map();
    let first = null;
    for (const id of STYLES) {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
        });
        const art = drawingArea(200, 86, (cr, w, h) =>
            paintCard(cr, w, h, painters[id], settings.get_string('downloads-icon-style') === id),
        {hexpand: true});
        content.append(art);
        content.append(new Gtk.Label({label: titles[id], xalign: 0, css_classes: ['heading']}));
        content.append(new Gtk.Label({
            label: subtitles[id], xalign: 0, wrap: true, width_chars: 1,
            css_classes: ['dim-label', 'caption'],
        }));
        const card = new Gtk.ToggleButton({child: content, hexpand: true, css_classes: ['card']});
        if (first)
            card.set_group(first);
        else
            first = card;
        card.connect('toggled', () => {
            if (card.active && settings.get_string('downloads-icon-style') !== id)
                settings.set_string('downloads-icon-style', id);
        });
        box.append(card);
        cards.set(id, {card, art});
    }
    const sync = () => {
        const current = settings.get_string('downloads-icon-style');
        for (const [id, {card, art}] of cards) {
            if (id === current)
                card.active = true;
            art.queue_draw();
        }
    };
    binder.watchOther(settings, 'downloads-icon-style', sync);
    sync();
    return box;
}
