// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/startMenuPage.js — aba "Menu Iniciar": ligar o menu no lugar da
// App Grid, escolher o estilo (com prévias), posição, tamanho, animação,
// atalho e o que o menu mostra. Tudo vale na hora (GSettings).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _, pgettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {drawingArea, roundedRect} from './previews.js';
import {group, sliderRow, spinRow, switchRow} from './rows.js';
import {ShortcutRow} from './widgets.js';

// Buscadores para "Pesquisar na web" (%s = o texto digitado).
const ENGINES = [
    ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'],
    ['Google', 'https://www.google.com/search?q=%s'],
    ['Bing', 'https://www.bing.com/search?q=%s'],
    ['Brave Search', 'https://search.brave.com/search?q=%s'],
    ['Startpage', 'https://www.startpage.com/do/search?query=%s'],
    ['Ecosia', 'https://www.ecosia.org/search?q=%s'],
    ['Kagi', 'https://kagi.com/search?q=%s'],
    ['Qwant', 'https://www.qwant.com/?q=%s'],
];

const COLORS = [[0.36, 0.62, 0.98], [0.98, 0.55, 0.24], [0.30, 0.80, 0.52],
    [0.86, 0.36, 0.62], [0.96, 0.80, 0.30], [0.52, 0.46, 0.94]];
const ACCENT = [0.18, 0.83, 0.75];

// ---------- Prévias (Cairo) ----------

function fill(cr, [r, g, b], a = 1) {
    cr.setSourceRGBA(r, g, b, a);
    cr.fill();
}

function box(cr, x, y, w, h, r, color, a = 1) {
    roundedRect(cr, x, y, w, h, r);
    fill(cr, color, a);
}

/** Uma "linha de texto" de mentira. */
function line(cr, x, y, w, ink, a = 0.55) {
    box(cr, x, y, w, 3, 1.5, ink, a);
}

function icons(cr, x, y, columns, rows, size, gap) {
    let n = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++)
            box(cr, x + c * (size + gap), y + r * (size + gap), size, size, size * 0.28, COLORS[n++ % COLORS.length]);
    }
}

function listRows(cr, x, y, count, w, ink, gap = 9) {
    for (let i = 0; i < count; i++) {
        box(cr, x, y + i * gap, 6, 6, 2, COLORS[i % COLORS.length]);
        line(cr, x + 9, y + i * gap + 1.5, w - 9, ink);
    }
}

const PAINTERS = {
    classic(cr, x, y, w, h, ink) {
        const split = w * 0.62;
        listRows(cr, x + 6, y + 6, 4, split - 14, ink, 10);
        line(cr, x + 6, y + 48, split - 14, ink, 0.2);
        listRows(cr, x + 6, y + 54, 3, split - 20, ink, 9);
        box(cr, x + 5, y + h - 12, split - 10, 7, 3.5, ink, 0.15);
        box(cr, x + split, y, w - split, h, 0, ink, 0.1);
        cr.arc(x + split + (w - split) / 2, y + 12, 6, 0, 2 * Math.PI);
        fill(cr, COLORS[5]);
        for (let i = 0; i < 5; i++)
            line(cr, x + split + 6, y + 26 + i * 8, w - split - 12, ink, 0.45);
        box(cr, x + w - 26, y + h - 12, 20, 7, 3, ink, 0.3);
    },
    modern(cr, x, y, w, h, ink) {
        box(cr, x + 8, y + 6, w - 16, 8, 4, ink, 0.15);
        icons(cr, x + 10, y + 20, 6, 2, 11, (w - 20 - 66) / 5);
        line(cr, x + 10, y + 52, 30, ink, 0.7);
        listRows(cr, x + 10, y + 60, 2, w / 2 - 16, ink);
        listRows(cr, x + w / 2 + 2, y + 60, 2, w / 2 - 14, ink);
        line(cr, x + 6, y + h - 13, w - 12, ink, 0.15);
        cr.arc(x + 13, y + h - 7, 3.5, 0, 2 * Math.PI);
        fill(cr, COLORS[5]);
        for (let i = 0; i < 3; i++) {
            cr.arc(x + w - 10 - i * 9, y + h - 7, 2.5, 0, 2 * Math.PI);
            fill(cr, ink, 0.6);
        }
    },
    categories(cr, x, y, w, h, ink) {
        for (let i = 0; i < 3; i++)
            box(cr, x + 6 + i * 11, y + 5, 9, 7, 2, i === 0 ? ACCENT : ink, i === 0 ? 1 : 0.2);
        box(cr, x + w - 15, y + 5, 9, 7, 2, ink, 0.2);
        box(cr, x + 6, y + 16, w - 12, 7, 3.5, ink, 0.15);
        for (let i = 0; i < 6; i++) {
            box(cr, x + 8, y + 29 + i * 9, 6, 6, 2, COLORS[i]);
            line(cr, x + 17, y + 30.5 + i * 9, w - 34, ink);
            line(cr, x + w - 12, y + 30.5 + i * 9, 4, ink, 0.6);
        }
        // O submenu aberto ao lado.
        box(cr, x + w + 3, y + 38, 26, 34, 4, ink, 0.18);
        listRows(cr, x + w + 6, y + 42, 3, 18, ink);
    },
    alphabetical(cr, x, y, w, h, ink) {
        box(cr, x, y, 12, h, 0, ink, 0.08);
        for (let i = 0; i < 3; i++) {
            cr.arc(x + 6, y + h - 10 - i * 10, 2.5, 0, 2 * Math.PI);
            fill(cr, ink, 0.55);
        }
        const mid = x + 16;
        const midW = w * 0.5;
        box(cr, mid, y + 5, midW - 4, 7, 3.5, ink, 0.15);
        ['A', 'B', 'C'].forEach((_l, i) => {
            box(cr, mid, y + 17 + i * 23, 5, 5, 1, ACCENT);
            listRows(cr, mid + 3, y + 25 + i * 23, 2, midW - 10, ink, 7);
        });
        icons(cr, mid + midW + 4, y + 8, 3, 4, 10, 5);
    },
    launchpad(cr, x, y, w, h, ink) {
        box(cr, x + w / 2 - 20, y + 5, 40, 7, 3.5, ink, 0.15);
        box(cr, x + 8, y + 17, w - 16, 16, 5, ACCENT, 0.25);
        icons(cr, x + 14, y + 20, 7, 1, 10, (w - 28 - 70) / 6);
        icons(cr, x + 14, y + 40, 7, 3, 10, (w - 28 - 70) / 6);
        for (let i = 0; i < 3; i++) {
            cr.arc(x + w / 2 - 6 + i * 6, y + h - 6, 1.6, 0, 2 * Math.PI);
            fill(cr, i === 0 ? ACCENT : ink, i === 0 ? 1 : 0.4);
        }
    },
};

// Tamanho de cada menu na prévia (x, y, largura, altura numa tela 150×100).
const FRAMES = {
    classic: [18, 8, 100, 80],
    modern: [25, 8, 100, 82],
    categories: [45, 8, 54, 80],
    alphabetical: [12, 10, 126, 78],
    launchpad: [12, 8, 126, 80],
};

function paintStartPreview(cr, w, h, id, dark, selected) {
    const scale = Math.min(w / 150, h / 100);
    cr.save();
    cr.scale(scale, scale);
    // A "tela": um fundo suave com a dock embaixo.
    box(cr, 0, 0, 150, 100, 8, dark ? [0.16, 0.17, 0.2] : [0.86, 0.89, 0.94]);
    box(cr, 45, 92, 60, 5, 2.5, dark ? [1, 1, 1] : [0, 0, 0], 0.18);
    const [x, y, fw, fh] = FRAMES[id];
    const paper = dark ? [0.12, 0.12, 0.14] : [0.98, 0.98, 0.99];
    const ink = dark ? [1, 1, 1] : [0.1, 0.1, 0.12];
    box(cr, x, y, fw, fh, id === 'launchpad' ? 8 : 6, paper);
    PAINTERS[id](cr, x, y, fw, fh, ink);
    if (selected) {
        roundedRect(cr, x - 1.5, y - 1.5, fw + 3, fh + 3, 7);
        cr.setSourceRGBA(...ACCENT, 1);
        cr.setLineWidth(1.5);
        cr.stroke();
    }
    cr.restore();
}

function styleCards(binder) {
    const settings = binder.settings;
    const styles = [
        ['classic', _('Classic'), _('Two columns, like Windows 7')],
        ['modern', _('Modern Classic'), _('Search, pinned grid and recents')],
        ['categories', _('Compact Categories'), _('Workspaces and app categories')],
        ['alphabetical', _('Alphabetical List'), _('A to Z with letter index')],
        ['launchpad', _('Floating Grid'), _('Large centered icons in pages')],
    ];
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        max_children_per_line: 5,
        min_children_per_line: 2,
        column_spacing: 10,
        row_spacing: 10,
    });
    const dark = () => Adw.StyleManager.get_default().dark;
    const cards = new Map();
    let first = null;
    for (const [id, title, subtitle] of styles) {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
        });
        const art = drawingArea(150, 100, (cr, w, h) =>
            paintStartPreview(cr, w, h, id, dark(), settings.get_string('start-menu-style') === id),
        {halign: Gtk.Align.CENTER});
        content.append(art);
        content.append(new Gtk.Label({label: title, css_classes: ['heading']}));
        content.append(new Gtk.Label({label: subtitle, css_classes: ['caption', 'dim-label'],
            wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 18}));
        const card = new Gtk.ToggleButton({child: content, css_classes: ['card'], tooltip_text: subtitle});
        if (first)
            card.set_group(first);
        else
            first = card;
        card.connect('toggled', () => {
            if (card.active && settings.get_string('start-menu-style') !== id)
                settings.set_string('start-menu-style', id);
        });
        flow.append(card);
        cards.set(id, {card, art});
    }
    const sync = () => {
        const current = settings.get_string('start-menu-style');
        for (const [id, {card, art}] of cards) {
            if (id === current)
                card.active = true;
            art.queue_draw();
        }
    };
    binder.watchOther(settings, 'start-menu-style', sync);
    const styleManager = Adw.StyleManager.get_default();
    const darkId = styleManager.connect('notify::dark', sync);
    flow.connect('destroy', () => styleManager.disconnect(darkId));
    sync();
    return flow;
}

/** Lista suspensa ligada a uma chave de texto com valores fixos. */
function choiceRow(binder, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices.map(([, label]) => label))});
    binder.stringCombo(key, row, choices.map(([value]) => value));
    return row;
}

/**
 * Lista suspensa dos buscadores; um endereço fora da lista marca
 * "Personalizado" e mostra o campo do endereço.
 */
function engineRows(binder) {
    const settings = binder.settings;
    const key = 'start-menu-web-search-url';
    const labels = [...ENGINES.map(([label]) => label), _('Custom')];
    const engine = new Adw.ComboRow({title: _('Search engine'), model: Gtk.StringList.new(labels)});
    const address = new Adw.EntryRow({title: _('Search address (%s is the text you type)'), show_apply_button: true});
    address.connect('apply', () => {
        const url = address.text.trim();
        if (url.includes('%s'))
            settings.set_string(key, url);
    });
    const sync = () => {
        const index = ENGINES.findIndex(([, url]) => url === settings.get_string(key));
        const wanted = index >= 0 ? index : ENGINES.length;
        if (engine.selected !== wanted)
            engine.selected = wanted;
        address.visible = index < 0 && settings.get_boolean('start-menu-web-search');
        if (index >= 0 || !address.text)
            address.text = settings.get_string(key);
    };
    engine.connect('notify::selected', () => {
        const choice = ENGINES[engine.selected];
        if (choice && settings.get_string(key) !== choice[1])
            settings.set_string(key, choice[1]);
        address.visible = !choice && settings.get_boolean('start-menu-web-search');
    });
    binder.watchOther(settings, key, sync);
    binder.watchOther(settings, 'start-menu-web-search', sync);
    sync();
    return [engine, address];
}

export function startMenuPage(binder) {
    const page = new Adw.PreferencesPage({
        // Translators: título de aba; curto, porque as abas dividem a largura.
        title: pgettext('preferences tab', 'Start Menu'),
        icon_name: 'view-app-grid-symbolic',
    });

    const main = group(page, _('Start Menu'),
        _('A start menu with pinned apps, recents, search and power options'));
    main.add(switchRow(binder, 'start-menu-replace-grid', _('Use the start menu instead of the App Grid'),
        _('Pressing Super twice, the app grid button and Super+A open the menu. A single Super still opens the Overview')));
    main.add(switchRow(binder, 'start-menu', _('Taskbar start button opens the menu'),
        _('On the taskbar styles, even when the option above is off')));
    main.add(new ShortcutRow(binder.settings, 'start-menu-shortcut', {
        title: _('Extra shortcut'),
        subtitle: _('Opens or closes the menu'),
    }));

    const look = group(page, _('Style'));
    look.add(styleCards(binder));

    const place = group(page, _('Position and Size'));
    const position = choiceRow(binder, 'start-menu-position', _('Position'),
        _('The Floating Grid style always opens in the center'), [
            ['dock', _('Next to the dock')],
            ['corner', _('Screen corner')],
            ['center', _('Centered')],
        ]);
    place.add(position);
    place.add(choiceRow(binder, 'start-menu-size', _('Size'), null, [
        ['small', _('Small')],
        ['medium', _('Medium')],
        ['large', _('Large')],
    ]));
    place.add(switchRow(binder, 'start-menu-animate', _('Animation'),
        _('A short fade and slide when opening and closing')));

    const background = group(page, _('Background'));
    background.add(sliderRow(binder, 'start-menu-opacity', _('Opacity'),
        _('Text stays readable over any wallpaper, even at the minimum'),
        {lower: 0.85, upper: 1, step: 0.01, digits: 2, format: v => `${Math.round(v * 100)}%`}));
    background.add(switchRow(binder, 'start-menu-glass', _('Glass effect'),
        _('A frosted copy of the wallpaper behind the menu (computed once; off by default)')));

    const content = group(page, _('Content'));
    const files = spinRow(binder, 'start-menu-recent-files', _('How many recent files'), 1, 50);
    content.add(switchRow(binder, 'start-menu-recent-apps', _('Recent apps'), _('The apps you opened last')));
    content.add(switchRow(binder, 'start-menu-continue', _('Recent files'),
        _('Continue where you left off (Modern Classic style)')));
    content.add(files);
    binder.showWhen('start-menu-continue', s => s.get_boolean('start-menu-continue'), files);

    const search = group(page, _('Search'));
    search.add(switchRow(binder, 'start-menu-search-providers', _('Results from other apps'),
        _('Search results from apps like Calendar, Contacts and Characters')));
    search.add(switchRow(binder, 'start-menu-web-search', _('Web search'), _('Offer to search the web for what you type')));
    const [engine, address] = engineRows(binder);
    search.add(engine);
    search.add(address);
    binder.showWhen('start-menu-web-search', s => s.get_boolean('start-menu-web-search'), engine);
    return page;
}
