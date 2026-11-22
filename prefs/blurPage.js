// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/blurPage.js — aba "Desfoque": o vidro fosco atrás da dock.
//
//   - liga/desliga (no cabeçalho);
//   - Modo: Dinâmico (o que está atrás da dock) ou Estático (uma imagem);
//   - Fundo do estático: imagens prontas ou uma foto sua;
//   - Vidro: visuais prontos (Orla, Lente, Névoa, Noite, Seda) e o material;
//   - Lente: refração e dispersão na borda;
//   - Luz: reflexo, relevo da borda, direção da luz e granulado.
// No topo, uma prévia ao vivo (prefs/blurPreview.js).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BlurPreview} from './blurPreview.js';
import {group, sliderRow} from './rows.js';
import {colorRow, imageRow} from './widgets.js';

const N_ = text => text;

// Imagens prontas do modo estático (icons/glass/<id>.svg).
const PRESETS = [
    ['abstract-dark', N_('Abstract')],
    ['aurora', N_('Aurora')],
    ['cyberpunk', N_('Cyberpunk')],
    ['minimal', N_('Minimal')],
    ['sunset', N_('Sunset')],
];

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

/** Um "cartão" de escolha: linha com rádio, ícone e descrição. */
function choiceRow(title, subtitle, icon, radioGroup) {
    const radio = new Gtk.CheckButton({valign: Gtk.Align.CENTER, group: radioGroup});
    const row = new Adw.ActionRow({title, subtitle, activatable_widget: radio});
    row.add_prefix(radio);
    row.add_suffix(new Gtk.Image({icon_name: icon, css_classes: ['dim-label']}));
    return {row, radio};
}

export function blurPage(binder, extensionPath, window) {
    const settings = binder.settings;
    const page = new Adw.PreferencesPage({
        title: _('Blur'),
        icon_name: 'view-paged-symbolic',
    });
    const isOn = s => s.get_boolean('blur-enabled');

    // --- Prévia ao vivo (a mesma receita do vidro da dock) ---
    const preview = new Adw.PreferencesGroup();
    preview.add(new BlurPreview(settings, extensionPath));
    page.add(preview);

    // --- Liga/desliga ---
    const hero = group(page, _('Blur material'), _('Frosted glass behind the Dock'));
    const enable = new Gtk.Switch({valign: Gtk.Align.CENTER});
    binder.bool('blur-enabled', enable);
    hero.set_header_suffix(enable);

    // --- Modo ---
    const mode = group(page, _('Mode'));
    const dynamic = choiceRow(_('Dynamic'), _('Follows windows and wallpaper behind the Dock in real time'),
        'view-refresh-symbolic', null);
    const still = choiceRow(_('Static'), _('A fixed image behind the glass — lighter on the graphics card'),
        'image-x-generic-symbolic', dynamic.radio);
    mode.add(dynamic.row);
    mode.add(still.row);
    binder.choice('blur-mode', new Map([['dynamic', dynamic.radio], ['static', still.radio]]));

    // --- Fundo do modo estático ---
    const source = group(page, _('Background'), _('The image that static blur is made from'));
    const switcher = new Gtk.Box({valign: Gtk.Align.CENTER, css_classes: ['linked']});
    const presetBtn = new Gtk.ToggleButton({label: _('Presets')});
    const customBtn = new Gtk.ToggleButton({label: _('Your photo'), group: presetBtn});
    switcher.append(presetBtn);
    switcher.append(customBtn);
    source.set_header_suffix(switcher);
    binder.choice('blur-static-source', new Map([['preset', presetBtn], ['custom', customBtn]]));

    // Gtk.FlowBox: uma grade que se ajusta à largura, com as miniaturas.
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.SINGLE,
        homogeneous: true,
        min_children_per_line: 2,
        max_children_per_line: 5,
        column_spacing: 6,
        row_spacing: 6,
        margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
    });
    const children = new Map();
    for (const [id, name] of PRESETS) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        const picture = Gtk.Picture.new_for_filename(
            GLib.build_filenamev([extensionPath, 'icons', 'glass', `${id}.svg`]));
        picture.set_content_fit(Gtk.ContentFit.COVER);
        picture.set_size_request(112, 64);
        picture.set_overflow(Gtk.Overflow.HIDDEN);
        picture.add_css_class('card');
        box.append(picture);
        box.append(new Gtk.Label({label: _(name), css_classes: ['caption']}));
        const child = new Gtk.FlowBoxChild({child: box});
        flow.append(child);
        children.set(id, child);
    }
    const syncPreset = () => {
        const child = children.get(settings.get_string('blur-static-preset'));
        if (child)
            flow.select_child(child);
    };
    flow.connect('child-activated', (_f, child) => {
        for (const [id, c] of children) {
            if (c === child)
                settings.set_string('blur-static-preset', id);
        }
    });
    binder._watch('blur-static-preset', syncPreset);
    syncPreset();
    const presetRow = new Adw.PreferencesRow({activatable: false, child: flow});
    source.add(presetRow);
    const photoRow = imageRow(binder, 'blur-custom-photo', _('Your photo'), window);
    source.add(photoRow);
    binder.showWhen('blur-static-source', s => s.get_string('blur-static-source') === 'preset', presetRow);
    binder.showWhen('blur-static-source', s => s.get_string('blur-static-source') === 'custom', photoRow);
    binder.showWhen(['blur-enabled', 'blur-mode'],
        s => isOn(s) && s.get_string('blur-mode') === 'static', source);

    // --- Vidro ---
    // --- Vidro: visuais prontos e o material ---
    const material = group(page, _('Glass'), _('Start from a look, then fine-tune'));
    binder.resetButton(material, [...GLASS_KEYS, ...LENS_KEYS, ...LIGHT_KEYS]);
    const looks = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        min_children_per_line: 3,
        max_children_per_line: 6,
        column_spacing: 8, row_spacing: 8,
        margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
    });
    const lookButtons = [];
    for (const [name, values] of LOOKS) {
        const button = new Gtk.Button({label: _(name), css_classes: ['pill']});
        button.connect('clicked', () => {
            for (const [key, value] of Object.entries(values))
                settings.set_double(key, value);
        });
        looks.append(button);
        lookButtons.push([button, values]);
    }
    const customLook = new Gtk.Button({label: _('Custom'), css_classes: ['pill'], sensitive: false});
    looks.append(customLook);
    // Destaca o visual que corresponde aos valores atuais (ou "Personalizado").
    const syncLooks = () => {
        let matched = false;
        for (const [button, values] of lookButtons) {
            const match = !matched && Object.entries(values)
                .every(([key, v]) => Math.abs(settings.get_double(key) - v) < 0.005);
            button[match ? 'add_css_class' : 'remove_css_class']('suggested-action');
            matched ||= match;
        }
        customLook[matched ? 'remove_css_class' : 'add_css_class']('suggested-action');
    };
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
    binder.showWhen('blur-enabled', isOn, material, mode);

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
