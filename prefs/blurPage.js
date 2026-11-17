// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/blurPage.js — aba "Desfoque": o vidro fosco atrás da dock.
//
// Mesmos controles, limites e padrões da Luma Dock:
//   - liga/desliga (no cabeçalho);
//   - Modo: Dinâmico (o que está atrás da dock) ou Estático (uma imagem);
//   - Fundo do estático: imagens prontas ou uma foto sua;
//   - Vidro: visuais prontos (Cristal, Fosco, Vívido, Meia-noite) + ajustes;
//   - Luz na borda: brilho e direção da luz.
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

// Visuais prontos (os mesmos valores da Luma Dock).
const LOOKS = [
    [N_('Crystal'), {'blur-intensity': 10, 'blur-vibrancy': 1.05, 'blur-brightness': 0.6, 'blur-tint-opacity': 0.05}],
    [N_('Frosted'), {'blur-intensity': 30, 'blur-vibrancy': 1.2, 'blur-brightness': 0.55, 'blur-tint-opacity': 0.15}],
    [N_('Vivid'), {'blur-intensity': 22, 'blur-vibrancy': 1.8, 'blur-brightness': 0.5, 'blur-tint-opacity': 0.2}],
    [N_('Midnight'), {'blur-intensity': 36, 'blur-vibrancy': 0.9, 'blur-brightness': 0.15, 'blur-tint-opacity': 0.35}],
];
const MATERIAL_KEYS = ['blur-tint-color', 'blur-intensity', 'blur-vibrancy', 'blur-brightness', 'blur-tint-opacity'];
const LIGHT_KEYS = ['blur-border-glow', 'blur-highlight-angle'];

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
    const material = group(page, _('Glass'), _('Start from a look, then fine-tune'));
    binder.resetButton(material, MATERIAL_KEYS);
    const looks = new Gtk.Box({
        spacing: 8, homogeneous: true,
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
    const customLook = new Gtk.Button({label: _('Custom'), css_classes: ['pill']});
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
    ['blur-intensity', 'blur-vibrancy', 'blur-brightness', 'blur-tint-opacity']
        .forEach(key => binder._watch(key, syncLooks));
    syncLooks();
    material.add(new Adw.PreferencesRow({activatable: false, child: looks}));
    material.add(colorRow(binder, 'blur-tint-color', _('Tint'), _('Colour washed over the glass')));
    material.add(sliderRow(binder, 'blur-tint-opacity', _('Tint strength'), _('How much of the tint shows'),
        {lower: 0, upper: 1, step: 0.01, digits: 2, marks: [[0, '0%'], [1, '100%']]}));
    material.add(sliderRow(binder, 'blur-intensity', _('Blur'), _('How soft the background becomes'),
        {lower: 0, upper: 64, step: 1, marks: [[0, '0 px'], [64, '64 px']]}));
    material.add(sliderRow(binder, 'blur-vibrancy', _('Vibrancy'), _('Colour saturation seen through the glass'),
        {lower: 0.5, upper: 2, step: 0.05, digits: 2, marks: [[0.5, '0.5×'], [1, '1×'], [2, '2×']]}));
    material.add(sliderRow(binder, 'blur-brightness', _('Brightness'),
        _('Darker glass on the left, lighter on the right'),
        {lower: 0, upper: 1, step: 0.01, digits: 2, marks: [[0, _('Dark')], [1, _('Light')]]}));
    binder.showWhen('blur-enabled', isOn, material, mode);

    // --- Luz na borda ---
    const light = group(page, _('Edge light'), _('A thin highlight along the rim of the glass'));
    binder.resetButton(light, LIGHT_KEYS);
    light.add(sliderRow(binder, 'blur-border-glow', _('Glow'), _('Strength of the rim highlight'),
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, _('Off')], [1, _('Strong')]]}));
    light.add(sliderRow(binder, 'blur-highlight-angle', _('Light direction'), _('Where the light falls from'),
        {lower: 0, upper: 360, step: 5, marks: [[0, '0°'], [180, '180°'], [360, '360°']]}));
    binder.showWhen('blur-enabled', isOn, light);

    return page;
}
