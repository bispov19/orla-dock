// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/layoutPage.js — aba "Disposição": onde a dock fica e o tamanho
// dela (posição, tamanho dos ícones, ampliação, espaços e monitores).

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {enumRow, group, sliderRow, spinRow, switchRow} from './rows.js';
import {sizeAndMagnificationRow} from './widgets.js';

export function layoutPage(binder) {
    const page = new Adw.PreferencesPage({
        title: _('Layout'),
        icon_name: 'view-dual-symbolic',
    });

    const place = group(page, _('Position'));
    place.add(enumRow(binder, 'position', _('Position on screen'),
        [_('Bottom'), _('Top'), _('Left'), _('Right')]));
    place.add(spinRow(binder, 'dock-margin', _('Distance from screen edge'), 0, 40));

    const size = group(page, _('Size'));
    binder.resetButton(size, ['icon-size', 'magnification', 'magnification-smoothness',
        'magnification-radius', 'magnification-rise']);
    size.add(sizeAndMagnificationRow(binder));
    const zoom = new Adw.ExpanderRow({
        title: _('Magnification details'),
        subtitle: _('How the icons grow under the pointer'),
    });
    zoom.add_row(sliderRow(binder, 'magnification-smoothness', _('Smoothness'),
        _('Lower values glide more, higher values follow the pointer faster'),
        {lower: 0.08, upper: 0.6, step: 0.02, digits: 2, marks: [[0.08, _('Soft')], [0.6, _('Snappy')]]}));
    zoom.add_row(sliderRow(binder, 'magnification-radius', _('Reach'),
        _('How many neighbouring icons grow along'),
        {lower: 1.5, upper: 6, step: 0.25, digits: 2, marks: [[1.5, _('Narrow')], [6, _('Wide')]]}));
    zoom.add_row(sliderRow(binder, 'magnification-rise', _('Lift'),
        _('Extra lift of the magnified icon'),
        {lower: 0, upper: 40, step: 1, marks: [[0, _('Off')], [40, '40 px']]}, true));
    size.add(zoom);

    const spacing = group(page, _('Spacing'));
    spacing.add(spinRow(binder, 'icon-spacing', _('Space between icons'), 0, 24));
    spacing.add(spinRow(binder, 'dock-padding', _('Inner padding'), 0, 20,
        _('Extra space between the icons and the Dock edge')));

    const monitors = group(page, _('Monitors'));
    monitors.add(switchRow(binder, 'multi-monitor', _('Show the Dock on all monitors'),
        _('When off, the Dock appears only on the primary monitor')));

    return page;
}
