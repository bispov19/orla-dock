// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// prefs/wobblyGroup.js — grupo "Janelas balançando" da aba Interação.
//
// A extensão lê só a mola, o atrito e a massa. A "Intensidade" é um atalho
// daqui: escolher Suave/Normal/Forte preenche os três valores, e mexer em
// qualquer um deles à mão muda a intensidade para "Personalizada".

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {group, sliderRow, switchRow} from './rows.js';
import {comboRow} from './widgets.js';

const COMPIZ_UUID = 'compiz-windows-effect@hermes83.github.com';

const PRESETS = {
    soft: {spring: 600, friction: 12, mass: 1},
    normal: {spring: 400, friction: 9, mass: 1},
    strong: {spring: 220, friction: 6, mass: 1.2},
};
const PRESET_IDS = ['soft', 'normal', 'strong', 'custom'];
const VALUE_KEYS = {spring: 'wobbly-spring', friction: 'wobbly-friction', mass: 'wobbly-mass'};

/** A extensão original está instalada E ligada? */
function compizEnabled(shellSettings) {
    if (shellSettings.get_boolean('disable-user-extensions'))
        return false;
    if (!shellSettings.get_strv('enabled-extensions').includes(COMPIZ_UUID))
        return false;
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    return dirs.some(dir => GLib.file_test(
        GLib.build_filenamev([dir, 'gnome-shell', 'extensions', COMPIZ_UUID]),
        GLib.FileTest.IS_DIR));
}

export function wobblyGroup(page, binder) {
    const settings = binder.settings;
    const wobbly = group(page, _('Wobbly windows'),
        _('Windows bend like jelly while you drag them and settle down on their own'));
    binder.resetButton(wobbly, ['wobbly-enabled', 'wobbly-preset', 'wobbly-spring',
        'wobbly-friction', 'wobbly-mass', 'wobbly-mesh', 'wobbly-resize', 'wobbly-maximize']);

    // --- Aviso: a extensão original também está ligada ---
    const warning = new Adw.ActionRow({
        title: _('“Compiz windows effect” is also enabled'),
        subtitle: _('To avoid applying the effect twice, Orla Dock leaves it to that extension. Turn it off in the Extensions app to use the Orla Dock effect.'),
        css_classes: ['warning'],
    });
    warning.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning']}));
    wobbly.add(warning);
    const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
    const syncWarning = () => {
        warning.visible = compizEnabled(shellSettings);
    };
    binder.watchOther(shellSettings, 'enabled-extensions', syncWarning);
    binder.watchOther(shellSettings, 'disable-user-extensions', syncWarning);
    syncWarning();

    wobbly.add(switchRow(binder, 'wobbly-enabled', _('Wobbly windows effect'),
        _('Bend and wobble windows while they move')));

    const intensity = comboRow(_('Intensity'),
        [_('Soft'), _('Normal'), _('Strong'), _('Custom')]);
    binder.stringCombo('wobbly-preset', intensity, PRESET_IDS);
    wobbly.add(intensity);

    const resize = switchRow(binder, 'wobbly-resize', _('When resizing'),
        _('The dragged edge pulls the rest of the window along'));
    wobbly.add(resize);
    const maximize = switchRow(binder, 'wobbly-maximize', _('When maximizing and restoring'),
        _('Also when moving a window with the keyboard'));
    wobbly.add(maximize);

    const advanced = new Adw.ExpanderRow({
        title: _('Advanced options'),
        subtitle: _('The physics behind the wobble'),
    });
    advanced.add_row(sliderRow(binder, 'wobbly-spring', _('Spring constant'),
        _('Higher values snap back faster and bend less'),
        {lower: 100, upper: 1200, step: 10, marks: [[100, _('Loose')], [1200, _('Stiff')]]}, false));
    advanced.add_row(sliderRow(binder, 'wobbly-friction', _('Friction'),
        _('Higher values stop the wobbling sooner'),
        {lower: 3, upper: 24, step: 0.5, digits: 1, format: v => v.toFixed(1)}));
    advanced.add_row(sliderRow(binder, 'wobbly-mass', _('Mass'),
        _('Heavier windows swing slower and wider'),
        {lower: 0.5, upper: 2.5, step: 0.1, digits: 1, format: v => v.toFixed(1)}));
    advanced.add_row(sliderRow(binder, 'wobbly-mesh', _('Mesh resolution'),
        _('Spring points on each side of the window; more points bend more smoothly'),
        {lower: 3, upper: 12, step: 1, format: v => `${Math.round(v)} × ${Math.round(v)}`}, true));
    wobbly.add(advanced);

    binder.showWhen('wobbly-enabled', s => s.get_boolean('wobbly-enabled'),
        intensity, resize, maximize, advanced);

    // --- Intensidade ↔ valores ---
    const applyPreset = () => {
        const values = PRESETS[settings.get_string('wobbly-preset')];
        if (!values)
            return;
        for (const [name, key] of Object.entries(VALUE_KEYS)) {
            if (Math.abs(settings.get_double(key) - values[name]) > 1e-6)
                settings.set_double(key, values[name]);
        }
    };
    const matchPreset = () => {
        const current = Object.fromEntries(Object.entries(VALUE_KEYS)
            .map(([name, key]) => [name, settings.get_double(key)]));
        const match = Object.keys(PRESETS).find(id => Object.keys(VALUE_KEYS)
            .every(name => Math.abs(PRESETS[id][name] - current[name]) < 1e-6));
        const id = match ?? 'custom';
        if (settings.get_string('wobbly-preset') !== id)
            settings.set_string('wobbly-preset', id);
    };
    binder.watchOther(settings, 'wobbly-preset', applyPreset);
    for (const key of Object.values(VALUE_KEYS))
        binder.watchOther(settings, key, matchPreset);
}
