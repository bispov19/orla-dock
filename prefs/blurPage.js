// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/blurPage.js — aba "Desfoque": o Vidro da Orla atrás da dock.
//
//   prévia ao vivo        (prefs/blurPreview.js)
//   liga/desliga          no cabeçalho do primeiro grupo
//   de onde vem o vidro   Dinâmico (o que está atrás da dock) ou Estático
//   fundo do estático     cartões com os fundos prontos e a sua foto
//   Vidro / Lente / Luz   visuais prontos e cada ajuste do material

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BACKDROPS, backdropId, backdropPath} from '../lib/glassBackdrops.js';
import {BlurPreview} from './blurPreview.js';
import {group, sliderRow} from './rows.js';
import {colorRow} from './widgets.js';

const N_ = text => text;
const CARD_W = 128;
const CARD_H = 72;

// Visuais prontos do Vidro da Orla. Cada um é um ponto de partida: depois
// dá para ajustar cada controle (aí o visual vira "Personalizado").
const LOOKS = [
    [N_('Orla'), {
        'blur-intensity': 34, 'blur-vibrancy': 1.45, 'blur-brightness': 0.1, 'blur-tint-opacity': 0.3,
        'blur-adaptive': 0.85, 'blur-refraction': 0.5, 'blur-dispersion': 0.3, 'blur-sheen': 0.35,
        'blur-border-glow': 0.55, 'blur-grain': 0.3,
    }],
    [N_('Lens'), {
        'blur-intensity': 8, 'blur-vibrancy': 1.2, 'blur-brightness': 0.2, 'blur-tint-opacity': 0.1,
        'blur-adaptive': 0.6, 'blur-refraction': 1, 'blur-dispersion': 0.7, 'blur-sheen': 0.5,
        'blur-border-glow': 0.7, 'blur-grain': 0.2,
    }],
    [N_('Mist'), {
        'blur-intensity': 60, 'blur-vibrancy': 1.1, 'blur-brightness': 0.55, 'blur-tint-opacity': 0.15,
        'blur-adaptive': 0.9, 'blur-refraction': 0.2, 'blur-dispersion': 0, 'blur-sheen': 0.2,
        'blur-border-glow': 0.3, 'blur-grain': 0.5,
    }],
    [N_('Night'), {
        'blur-intensity': 40, 'blur-vibrancy': 0.9, 'blur-brightness': 0, 'blur-tint-opacity': 0.45,
        'blur-adaptive': 1, 'blur-refraction': 0.4, 'blur-dispersion': 0.2, 'blur-sheen': 0.15,
        'blur-border-glow': 0.4, 'blur-grain': 0.4,
    }],
    [N_('Silk'), {
        'blur-intensity': 28, 'blur-vibrancy': 1.6, 'blur-brightness': 0.9, 'blur-tint-opacity': 0.2,
        'blur-adaptive': 0.8, 'blur-refraction': 0.4, 'blur-dispersion': 0.15, 'blur-sheen': 0.45,
        'blur-border-glow': 0.5, 'blur-grain': 0.25,
    }],
];
const LOOK_KEYS = Object.keys(LOOKS[0][1]);
const GLASS_KEYS = ['blur-brightness', 'blur-adaptive', 'blur-tint-color', 'blur-tint-opacity',
    'blur-intensity', 'blur-vibrancy'];
const LENS_KEYS = ['blur-refraction', 'blur-dispersion'];
const LIGHT_KEYS = ['blur-sheen', 'blur-border-glow', 'blur-highlight-angle', 'blur-grain'];

/** O seletor Dinâmico | Estático, numa linha só. */
function sourceRow(binder) {
    const settings = binder.settings;
    const row = new Adw.ActionRow({title: _('Glass source')});
    // Largura mínima: sem ela, a descrição da linha espreme as opções.
    const toggles = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, width_request: 210, homogeneous: true});
    toggles.add(new Adw.Toggle({name: 'dynamic', label: _('Dynamic')}));
    toggles.add(new Adw.Toggle({name: 'static', label: _('Static')}));
    row.add_suffix(toggles);
    const hints = {
        dynamic: _('Follows windows and wallpaper behind the Dock in real time'),
        static: _('A fixed image behind the glass — lighter on the graphics card'),
    };
    const sync = () => {
        const mode = settings.get_string('blur-mode');
        if (toggles.active_name !== mode)
            toggles.active_name = mode;
        row.subtitle = hints[mode] ?? '';
    };
    toggles.connect('notify::active-name', () => {
        const mode = toggles.active_name;
        if (mode && settings.get_string('blur-mode') !== mode)
            settings.set_string('blur-mode', mode);
    });
    binder._watch('blur-mode', sync);
    sync();
    return row;
}

/** Um cartão do fundo estático: a imagem e o nome embaixo. */
function backdropCard(file, label) {
    const picture = new Gtk.Picture({
        file,
        content_fit: Gtk.ContentFit.COVER,
        width_request: CARD_W,
        height_request: CARD_H,
        overflow: Gtk.Overflow.HIDDEN,
        css_classes: ['card'],
    });
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    box.append(picture);
    box.append(new Gtk.Label({label, css_classes: ['caption']}));
    const button = new Gtk.ToggleButton({child: box, css_classes: ['flat']});
    return {button, picture};
}

/**
 * Os fundos do modo estático numa fileira de cartões; o último é "Sua foto"
 * (escolher abre o seletor de imagens e o cartão passa a mostrar a foto).
 */
function backdropPicker(binder, extensionPath, window) {
    const settings = binder.settings;
    const strip = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        min_children_per_line: 3,
        max_children_per_line: 6,
        margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6,
    });
    const cards = [];
    for (const {id, name} of BACKDROPS) {
        const card = backdropCard(Gio.File.new_for_path(backdropPath(extensionPath, id)), _(name));
        card.button.connect('clicked', () => {
            settings.set_string('blur-static-source', 'preset');
            settings.set_string('blur-static-preset', id);
            sync();
        });
        cards.push({id, ...card});
        strip.append(card.button);
    }
    const photo = backdropCard(null, _('Your photo'));
    photo.button.connect('clicked', () => {
        const filter = new Gtk.FileFilter({name: _('Images')});
        filter.add_mime_type('image/*');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        new Gtk.FileDialog({title: _('Choose an image'), filters}).open(window, null, (dialog, res) => {
            try {
                const path = dialog.open_finish(res)?.get_path();
                if (path) {
                    settings.set_string('blur-custom-photo', path);
                    settings.set_string('blur-static-source', 'custom');
                }
            } catch {
                // cancelado
            }
            sync();
        });
    });
    strip.append(photo.button);

    function sync() {
        const custom = settings.get_string('blur-static-source') === 'custom';
        const preset = backdropId(settings.get_string('blur-static-preset'));
        for (const card of cards)
            card.button.active = !custom && card.id === preset;
        const path = settings.get_string('blur-custom-photo');
        photo.picture.file = path ? Gio.File.new_for_path(path) : null;
        photo.button.active = custom;
    }
    ['blur-static-source', 'blur-static-preset', 'blur-custom-photo'].forEach(key => binder._watch(key, sync));
    sync();
    return new Adw.PreferencesRow({activatable: false, child: strip});
}

export function blurPage(binder, extensionPath, window) {
    const settings = binder.settings;
    const page = new Adw.PreferencesPage({title: _('Blur'), icon_name: 'view-paged-symbolic'});
    const isOn = s => s.get_boolean('blur-enabled');

    const preview = new Adw.PreferencesGroup();
    preview.add(new BlurPreview(settings, extensionPath));
    page.add(preview);

    const hero = group(page, _('Blur material'), _('Frosted glass behind the Dock'));
    const enable = new Gtk.Switch({valign: Gtk.Align.CENTER});
    binder.bool('blur-enabled', enable);
    hero.set_header_suffix(enable);
    const mode = sourceRow(binder);
    hero.add(mode);
    binder.showWhen('blur-enabled', isOn, mode);

    const backdrop = group(page, _('Background'), _('The image the static glass is made from'));
    backdrop.add(backdropPicker(binder, extensionPath, window));
    binder.showWhen(['blur-enabled', 'blur-mode'],
        s => isOn(s) && s.get_string('blur-mode') === 'static', backdrop);

    // --- Vidro: visuais prontos e o material ---
    const material = group(page, _('Glass'), _('Start from a look, then fine-tune'));
    binder.resetButton(material, [...GLASS_KEYS, ...LENS_KEYS, ...LIGHT_KEYS]);
    // Os visuais num seletor só: o que bate com os ajustes atuais fica
    // marcado; mexendo em qualquer ajuste, nenhum fica (é o seu visual).
    const looks = new Adw.ToggleGroup({
        homogeneous: true,
        margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
    });
    LOOKS.forEach(([name], i) => looks.add(new Adw.Toggle({name: `look-${i}`, label: _(name)})));
    const currentLook = () => LOOKS.findIndex(([, values]) => Object.entries(values)
        .every(([key, v]) => Math.abs(settings.get_double(key) - v) < 0.005));
    let syncing = false;
    const syncLooks = () => {
        syncing = true;
        const index = currentLook();
        if (index >= 0)
            looks.active_name = `look-${index}`;
        else
            looks.active = Gtk.INVALID_LIST_POSITION;
        syncing = false;
    };
    looks.connect('notify::active-name', () => {
        const match = /^look-(\d+)$/.exec(looks.active_name ?? '');
        if (syncing || !match)
            return;
        for (const [key, value] of Object.entries(LOOKS[Number(match[1])][1]))
            settings.set_double(key, value);
    });
    LOOK_KEYS.forEach(key => binder._watch(key, syncLooks));
    syncLooks();
    material.add(new Adw.PreferencesRow({activatable: false, child: looks}));

    const percent = {lower: 0, upper: 1, step: 0.05, digits: 2};
    material.add(sliderRow(binder, 'blur-brightness', _('Tone'),
        _('The glass keeps this brightness over any background'),
        {...percent, step: 0.01, marks: [[0, _('Dark')], [1, _('Light')]]}));
    material.add(sliderRow(binder, 'blur-adaptive', _('Adaptive'),
        _('How much bright and dark backgrounds are evened out'),
        {...percent, marks: [[0, _('Off')], [1, _('Full')]]}));
    material.add(colorRow(binder, 'blur-tint-color', _('Glass colour'),
        _('Its hue colours the glass; the brightness comes from the background')));
    material.add(sliderRow(binder, 'blur-tint-opacity', _('Colour strength'), _('How much of the colour shows'),
        {...percent, step: 0.01, marks: [[0, '0%'], [1, '100%']]}));
    material.add(sliderRow(binder, 'blur-intensity', _('Blur'), _('How soft the background becomes'),
        {lower: 0, upper: 64, step: 1, marks: [[0, '0 px'], [64, '64 px']]}));
    material.add(sliderRow(binder, 'blur-vibrancy', _('Vibrancy'), _('Colour saturation seen through the glass'),
        {lower: 0.5, upper: 2, step: 0.05, digits: 2, marks: [[0.5, '0.5×'], [1, '1×'], [2, '2×']]}));
    binder.showWhen('blur-enabled', isOn, material);

    // --- Lente: o vidro tem espessura ---
    const lens = group(page, _('Lens'),
        _('The thick, curved edge of the glass bends what is behind it — visible on the Dock itself'));
    binder.resetButton(lens, LENS_KEYS);
    lens.add(sliderRow(binder, 'blur-refraction', _('Refraction'), _('How much the edge bends the background'),
        {...percent, marks: [[0, _('Off')], [1, _('Strong')]]}));
    lens.add(sliderRow(binder, 'blur-dispersion', _('Dispersion'), _('A faint rainbow where the edge bends light'),
        {...percent, marks: [[0, _('Off')], [1, _('Strong')]]}));
    binder.showWhen('blur-enabled', isOn, lens);

    // --- Luz: reflexo, relevo da borda e granulado ---
    const light = group(page, _('Lighting'), _('How light falls on the glass'));
    binder.resetButton(light, LIGHT_KEYS);
    light.add(sliderRow(binder, 'blur-sheen', _('Sheen'), _('A soft reflection coming from the top'),
        {...percent, marks: [[0, _('Off')], [1, _('Strong')]]}));
    light.add(sliderRow(binder, 'blur-border-glow', _('Edge relief'),
        _('Light on one side of the rim, a thin shadow on the other'),
        {...percent, marks: [[0, _('Off')], [1, _('Strong')]]}));
    light.add(sliderRow(binder, 'blur-highlight-angle', _('Light direction'), _('Where the light falls from'),
        {lower: 0, upper: 360, step: 5, marks: [[0, '0°'], [180, '180°'], [360, '360°']]}));
    light.add(sliderRow(binder, 'blur-grain', _('Grain'), _('Barely visible texture that keeps dark gradients smooth'),
        {...percent, marks: [[0, _('Off')], [1, _('Visible')]]}));
    binder.showWhen('blur-enabled', isOn, light);

    return page;
}
