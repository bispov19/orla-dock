// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// prefs/musicPage.js — aba "Música": o widget wavebar-music-pill (a música
// tocando, dentro da dock). Tudo vale na hora; com o widget desligado, as
// outras opções ficam esmaecidas.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _, pgettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {drawingArea, roundedRect} from './previews.js';
import {group, sliderRow, switchRow} from './rows.js';

const KEY = 'wavebar-music-pill-';
// ---------- Prévias da posição do widget ----------

const ACCENT = [0.18, 0.83, 0.75];
const APP_COLORS = [[0.36, 0.62, 0.98], [0.98, 0.55, 0.24], [0.3, 0.8, 0.52], [0.86, 0.36, 0.62]];

function fillBox(cr, x, y, w, h, r, [cr0, cg, cb], a = 1) {
    roundedRect(cr, x, y, w, h, r);
    cr.setSourceRGBA(cr0, cg, cb, a);
    cr.fill();
}

/** Uma dock de mentira com o widget no extremo esquerdo ou no fim. */
function paintPositionPreview(cr, w, h, id, dark, selected) {
    const scale = Math.min(w / 180, h / 90);
    cr.save();
    cr.scale(scale, scale);
    const ink = dark ? [1, 1, 1] : [0.1, 0.1, 0.12];
    fillBox(cr, 0, 0, 180, 90, 8, dark ? [0.16, 0.17, 0.2] : [0.86, 0.89, 0.94]);
    fillBox(cr, 10, 60, 160, 22, 7, ink, 0.12);
    let x = 16;
    const icon = (color, a = 1) => {
        fillBox(cr, x, 64, 14, 14, 4, color, a);
        x += 18;
    };
    const sep = () => {
        fillBox(cr, x, 65, 1.5, 12, 0.75, ink, 0.35);
        x += 6;
    };
    const pill = () => {
        const px = x;
        fillBox(cr, x, 64, 36, 14, 7, ACCENT, 0.4);
        cr.arc(x + 7, 71, 5, 0, 2 * Math.PI);
        cr.setSourceRGBA(...APP_COLORS[3], 1);
        cr.fill();
        fillBox(cr, x + 15, 68, 15, 2.5, 1.2, ink, 0.6);
        fillBox(cr, x + 15, 72.5, 10, 2, 1, ink, 0.35);
        if (selected) {
            roundedRect(cr, px - 2, 62, 40, 18, 9);
            cr.setSourceRGBA(...ACCENT, 1);
            cr.setLineWidth(1.5);
            cr.stroke();
        }
        x += 40;
    };
    if (id === 'apps') {
        pill();                         // extremo esquerdo
        sep();
    }
    icon([0.2, 0.22, 0.26]);           // botão de aplicativos
    APP_COLORS.forEach(c => icon(c));
    if (id !== 'apps')
        sep();
    icon([0.2, 0.7, 0.45]);            // Lixeira
    if (id !== 'apps') {
        sep();
        pill();
    }
    cr.restore();
}

function positionCards(binder) {
    const settings = binder.settings;
    const key = `${KEY}position`;
    const choices = [
        ['apps', _('Far left'), _('At the start of the dock, next to the applications button (default)')],
        ['end', _('Right side'), _('At the end of the dock, next to the Trash')],
    ];
    const row = new Gtk.Box({spacing: 12, homogeneous: true});
    const dark = () => Adw.StyleManager.get_default().dark;
    const cards = new Map();
    let first = null;
    for (const [id, title, subtitle] of choices) {
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8});
        const art = drawingArea(180, 90, (cr, w, h) =>
            paintPositionPreview(cr, w, h, id, dark(), settings.get_string(key) === id), {halign: Gtk.Align.CENTER});
        content.append(art);
        content.append(new Gtk.Label({label: title, css_classes: ['heading']}));
        content.append(new Gtk.Label({label: subtitle, css_classes: ['caption', 'dim-label'], wrap: true,
            justify: Gtk.Justification.CENTER}));
        const card = new Gtk.ToggleButton({child: content, css_classes: ['card'], tooltip_text: subtitle});
        if (first)
            card.set_group(first);
        else
            first = card;
        card.connect('toggled', () => {
            if (card.active && settings.get_string(key) !== id)
                settings.set_string(key, id);
        });
        row.append(card);
        cards.set(id, {card, art});
    }
    const sync = () => {
        const current = settings.get_string(key);
        for (const [id, {card, art}] of cards) {
            if (id === current)
                card.active = true;
            art.queue_draw();
        }
    };
    binder.watchOther(settings, key, sync);
    sync();
    return row;
}

/** Apaga os arquivos do cache de letras (~/.cache/orla-dock/music/lyrics). */
function clearLyricsCache(done) {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'orla-dock', 'music', 'lyrics']));
    dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (d, res) => {
        let enumerator;
        try {
            enumerator = d.enumerate_children_finish(res);
        } catch {
            done(0);
            return;
        }
        let count = 0;
        const next = () => enumerator.next_files_async(50, GLib.PRIORITY_LOW, null, (e, r) => {
            let infos = [];
            try {
                infos = e.next_files_finish(r);
            } catch {}
            if (!infos.length) {
                enumerator.close_async(GLib.PRIORITY_LOW, null, null);
                done(count);
                return;
            }
            for (const info of infos) {
                count++;
                dir.get_child(info.get_name()).delete_async(GLib.PRIORITY_LOW, null, null);
            }
            next();
        });
        next();
    });
}

export function musicPage(binder, window) {
    const settings = binder.settings;
    const page = new Adw.PreferencesPage({
        // Translators: título de aba; curto, porque as abas dividem a largura.
        title: pgettext('preferences tab', 'Music'),
        icon_name: 'audio-x-generic-symbolic',
    });

    const main = group(page, _('Music'),
        _('The song that is playing, right on the dock'));
    main.add(switchRow(binder, `${KEY}enabled`, _('Enable wavebar-music-pill'),
        _('Reads the players through MPRIS (Spotify, browsers, local players)')));

    // Tudo abaixo fica esmaecido com o widget desligado.
    const groups = [];
    const dependent = (title, description = null) => {
        const g = group(page, title, description);
        groups.push(g);
        return g;
    };

    const place = dependent(_('Position on the dock'));
    place.add(positionCards(binder));

    const look = dependent(_('Look'));
    const mode = new Adw.ComboRow({
        title: _('Display mode'),
        subtitle: _('Compact is the size of an icon; expanded shows title and artist'),
        model: Gtk.StringList.new([_('Compact'), _('Expanded')]),
    });
    binder.stringCombo(`${KEY}mode`, mode, ['compact', 'expanded']);
    look.add(mode);
    look.add(switchRow(binder, `${KEY}separators`, _('Show separators'),
        _('A separator on each side of the widget')));
    look.add(switchRow(binder, `${KEY}show-cover`, _('Show album cover')));
    look.add(switchRow(binder, `${KEY}scroll-title`, _('Scroll long titles automatically')));
    look.add(sliderRow(binder, `${KEY}max-width`, _('Maximum width when expanded'), null,
        {lower: 160, upper: 480, step: 10, format: v => `${Math.round(v)} px`}, true));
    look.add(switchRow(binder, `${KEY}show-without-player`, _('Show even without a player'),
        _('A discreet music item stays on the dock')));

    const behavior = dependent(_('Behavior'));
    behavior.add(switchRow(binder, `${KEY}controls`, _('Always show previous and next'),
        _('Off: play/pause is always there, and previous and next appear when the pointer is over the widget')));
    behavior.add(switchRow(binder, `${KEY}expand-on-hover`, _('Expand on hover')));
    behavior.add(switchRow(binder, `${KEY}expand-on-track-change`, _('Expand when the track changes')));
    const duration = sliderRow(binder, `${KEY}track-change-duration`, _('For how long'), null,
        {lower: 2, upper: 10, step: 1, format: v => `${Math.round(v)} s`}, true);
    behavior.add(duration);
    binder.showWhen(`${KEY}expand-on-track-change`, s => s.get_boolean(`${KEY}expand-on-track-change`), duration);

    const progress = dependent(_('Progress'));
    progress.add(switchRow(binder, `${KEY}progress`, _('Progress outline'),
        _('An outline around the widget that goes all the way around as the song plays')));
    const thickness = new Adw.ComboRow({title: _('Outline thickness'),
        model: Gtk.StringList.new([_('Thin (2 px)'), _('Medium (3 px)')])});
    binder.stringCombo(`${KEY}progress-width`, thickness, ['thin', 'medium']);
    progress.add(thickness);
    binder.showWhen(`${KEY}progress`, st => st.get_boolean(`${KEY}progress`), thickness);
    progress.add(switchRow(binder, `${KEY}dynamic-color`, _('Color from the album cover'),
        _('The outline, the widget and the play button take the main color of the cover. Off: the dock accent color')));

    const lyrics = dependent(_('Lyrics'));
    lyrics.add(switchRow(binder, `${KEY}lyrics`, _('Show real-time lyrics'),
        _('Sends the song title and artist to LRCLIB to find the lyrics. Shown in the expanded mode and in the card')));
    const clear = new Adw.ActionRow({title: _('Clear lyrics cache'),
        subtitle: _('Lyrics already found (and the ones not found) are kept to avoid asking again')});
    const clearButton = new Gtk.Button({label: _('Clear'), valign: Gtk.Align.CENTER});
    clearButton.connect('clicked', () => {
        clearButton.sensitive = false;
        clearLyricsCache(count => {
            // Avisa a extensão para esquecer também o que está na memória.
            settings.set_int(`${KEY}lyrics-cache-stamp`, settings.get_int(`${KEY}lyrics-cache-stamp`) + 1);
            clearButton.sensitive = true;
            window.add_toast?.(new Adw.Toast({title: _('Lyrics cache cleared (%d files)').format(count)}));
        });
    });
    clear.add_suffix(clearButton);
    lyrics.add(clear);

    const note = dependent(null, _('If the Wavebar extension is also active, the music indicator will appear in both places.'));
    void note;

    for (const g of groups)
        settings.bind(`${KEY}enabled`, g, 'sensitive', Gio.SettingsBindFlags.GET);
    return page;
}
