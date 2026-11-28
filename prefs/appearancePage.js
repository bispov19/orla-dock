// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// prefs/appearancePage.js — aba "Aparência": cores, forma, indicadores,
// contadores e separadores. (O vidro/desfoque tem a sua própria aba.)

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {enumRow, group, sliderRow, spinRow, switchRow} from './rows.js';
import {colorRow} from './widgets.js';

const THEME_CUSTOM = 1;
const COLOR_CUSTOM = 2;

export function appearancePage(binder) {
    const page = new Adw.PreferencesPage({
        title: _('Appearance'),
        icon_name: 'applications-graphics-symbolic',
    });

    // --- Fundo ---
    const background = group(page, _('Background'));
    background.add(enumRow(binder, 'theme', _('Theme'), [
        _('System (light or dark)'), _('Custom colour'), _('Wallpaper colour'),
        _('Graphite'), 'Nord', 'Catppuccin Mocha', 'Gruvbox', 'Dracula', 'Tokyo Night', 'Frost',
    ], _('A ready palette, or your own colours')));
    const custom = [
        colorRow(binder, 'background-color', _('Colour')),
        switchRow(binder, 'use-gradient', _('Gradient'), _('Blend into a second colour')),
    ];
    const gradient = [
        colorRow(binder, 'gradient-color', _('Second colour')),
        enumRow(binder, 'gradient-direction', _('Direction'), [_('Vertical'), _('Horizontal')]),
    ];
    [...custom, ...gradient].forEach(row => background.add(row));
    binder.showWhen('theme', s => s.get_enum('theme') === THEME_CUSTOM, ...custom);
    binder.showWhen(['theme', 'use-gradient'],
        s => s.get_enum('theme') === THEME_CUSTOM && s.get_boolean('use-gradient'), ...gradient);
    background.add(sliderRow(binder, 'background-opacity', _('Opacity'), null,
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, '0%'], [1, '100%']]}));
    // Com o vidro ligado, o fundo vem da aba Desfoque.
    binder.showWhen('blur-enabled', s => !s.get_boolean('blur-enabled'), background);

    const glassNote = group(page, _('Background'));
    glassNote.add(new Adw.ActionRow({
        title: _('Blur is on'),
        subtitle: _('The Dock is made of glass now. Its look is set on the Blur page'),
        icon_name: 'dialog-information-symbolic',
    }));
    binder.showWhen('blur-enabled', s => s.get_boolean('blur-enabled'), glassNote);

    // --- Forma ---
    const shape = group(page, _('Shape'));
    shape.add(sliderRow(binder, 'corner-radius', _('Corner radius'), null,
        {lower: 0, upper: 40, step: 1, marks: [[0, _('Square')], [40, _('Round')]]}, true));
    shape.add(spinRow(binder, 'border-width', _('Outline'), 0, 4, _('Line around the Dock, 0 hides it')));
    shape.add(colorRow(binder, 'border-color', _('Outline colour')));
    shape.add(sliderRow(binder, 'border-opacity', _('Outline opacity'), null,
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, '0%'], [1, '100%']]}));

    // --- Apps abertos ---
    const running = group(page, _('Running apps'));
    running.add(switchRow(binder, 'show-indicators', _('Show indicators for open applications')));
    running.add(enumRow(binder, 'indicator-style', _('Indicator style'),
        [_('Dot'), _('Dash'), _('Line'), _('Square'), _('One dot per window')]));
    running.add(enumRow(binder, 'indicator-color-mode', _('Indicator colour'),
        [_('Automatic'), _('System accent'), _('Custom')]));
    const indicatorColor = colorRow(binder, 'indicator-color', _('Custom indicator colour'));
    running.add(indicatorColor);
    binder.showWhen('indicator-color-mode', s => s.get_enum('indicator-color-mode') === COLOR_CUSTOM, indicatorColor);
    running.add(spinRow(binder, 'indicator-size', _('Indicator size'), 2, 12));
    running.add(switchRow(binder, 'indicator-glow', _('Indicator glow')));
    running.add(enumRow(binder, 'badge-color-mode', _('Notification badge colour'),
        [_('Automatic'), _('System accent'), _('Custom')]));
    const badgeColor = colorRow(binder, 'badge-color', _('Custom badge colour'));
    running.add(badgeColor);
    binder.showWhen('badge-color-mode', s => s.get_enum('badge-color-mode') === COLOR_CUSTOM, badgeColor);
    running.add(sliderRow(binder, 'popup-opacity', _('Label and preview opacity'), null,
        {lower: 0.3, upper: 1, step: 0.05, digits: 2, marks: [[0.3, '30%'], [1, '100%']]}));

    // --- Separadores ---
    const separators = group(page, _('Separators'));
    separators.add(spinRow(binder, 'separator-thickness', _('Thickness'), 0, 6, _('0 hides the separators')));
    separators.add(sliderRow(binder, 'separator-length', _('Length'), _('Share of the icon height'),
        {lower: 0.2, upper: 1, step: 0.05, digits: 2, marks: [[0.2, '20%'], [1, '100%']]}));
    separators.add(colorRow(binder, 'separator-color', _('Colour')));
    separators.add(sliderRow(binder, 'separator-opacity', _('Opacity'), null,
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, '0%'], [1, '100%']]}));

    return page;
}
