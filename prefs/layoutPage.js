// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/layoutPage.js — aba "Disposição": onde a dock fica e o tamanho
// dela (posição, tamanho dos ícones, ampliação, espaços e monitores).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {group, sliderRow, spinRow, switchRow} from './rows.js';
import {comboRow, sizeAndMagnificationRow} from './widgets.js';
import {getStyle} from '../lib/styles.js';
import {drawingArea, paintPositionPreview} from './previews.js';

// Posições (valores do enum no schema) na ordem dos cartões.
const POSITIONS = [[0, 'Bottom'], [2, 'Left'], [3, 'Right'], [1, 'Top']];

// Movimentos da ampliação, na ordem da lista.
const MOTIONS = ['fluid', 'domino', 'cylinder', 'magnetic', 'jelly', 'coverflow'];
const MOTION_KEYS = ['magnification-domino-tilt', 'magnification-cylinder-angle',
    'magnification-magnetic-strength', 'magnification-jelly-stretch',
    'magnification-jelly-squish', 'magnification-coverflow-angle'];

/**
 * Seletor de posição: um "monitor" desenhado por lado,
 * com a barra naquele lado; clicar muda a posição na hora.
 */
function positionCards(binder) {
    const settings = binder.settings;
    const names = {Bottom: _('Bottom'), Left: _('Left'), Right: _('Right'), Top: _('Top')};
    const box = new Gtk.Box({spacing: 12, homogeneous: true});
    const cards = new Map();
    let first = null;
    for (const [value, name] of POSITIONS) {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
        });
        const art = drawingArea(110, 70, (cr, w, h) => paintPositionPreview(cr, w, h, value,
            getStyle(settings.get_string('bar-style')), settings.get_enum('position') === value),
        {halign: Gtk.Align.CENTER});
        content.append(art);
        content.append(new Gtk.Label({label: names[name], css_classes: ['heading']}));
        const card = new Gtk.ToggleButton({child: content, hexpand: true, css_classes: ['card']});
        if (first)
            card.set_group(first);
        else
            first = card;
        card.connect('toggled', () => {
            if (card.active && settings.get_enum('position') !== value)
                settings.set_enum('position', value);
        });
        box.append(card);
        cards.set(value, {card, art});
    }
    const sync = () => {
        const current = settings.get_enum('position');
        for (const [value, {card, art}] of cards) {
            if (value === current)
                card.active = true;
            art.queue_draw();
        }
    };
    binder.watchOther(settings, 'position', sync);
    // Barra de tarefas (borda inteira) ou dock (centralizada): o desenho muda.
    binder.watchOther(settings, 'bar-style', sync);
    sync();
    return box;
}

export function layoutPage(binder) {
    const page = new Adw.PreferencesPage({
        title: _('Layout'),
        icon_name: 'view-dual-symbolic',
    });

    // Os cartões ficam num grupo só deles: o Adw.PreferencesGroup sempre põe
    // as linhas (rows) numa lista e os outros widgets DEPOIS dela.
    const cards = group(page, _('Position'), _('Click a screen to move the Dock to that side'));
    cards.add(positionCards(binder));
    const place = group(page, '');
    place.add(spinRow(binder, 'dock-margin', _('Distance from screen edge'), 0, 40));
    const hug = switchRow(binder, 'hug-edge-when-maximized', _('Touch the edge when a window is maximized'),
        _('The Dock drops its margin while a maximized window is on its screen and floats again when there is none'));
    place.add(hug);
    // Só faz sentido nos estilos que flutuam (as barras de tarefas já encostam).
    binder.showWhen('bar-style', s => !getStyle(s.get_string('bar-style')).fullWidth, hug);

    const size = group(page, _('Size'));
    binder.resetButton(size, ['icon-size', 'magnification', 'magnification-smoothness',
        'magnification-radius', 'magnification-rise', 'magnification-style',
        'magnification-make-room', 'magnification-push']);
    size.add(sizeAndMagnificationRow(binder));

    // Os nomes passam pelo _() aqui (e não na lista) para o xgettext achar.
    const motionNames = {
        fluid: _('Fluid'), domino: _('Domino'), cylinder: _('Cylinder'),
        magnetic: _('Magnetic'), jelly: _('Jelly'), coverflow: _('Coverflow'),
    };
    const motion = comboRow(_('Motion'), MOTIONS.map(id => motionNames[id]),
        _('The shape of the wave'));
    binder.stringCombo('magnification-style', motion, MOTIONS);
    size.add(motion);
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
    zoom.add_row(switchRow(binder, 'magnification-make-room', _('Make room'),
        _('Neighbours slide apart for the zoomed icon')));
    const push = sliderRow(binder, 'magnification-push', _('Push strength'),
        _('Higher values push the neighbours less'),
        {lower: 1, upper: 3, step: 0.1, digits: 1, format: v => `${v.toFixed(1)}×`});
    zoom.add_row(push);
    binder.showWhen('magnification-make-room', s => s.get_boolean('magnification-make-room'), push);
    size.add(zoom);

    // --- Detalhes de cada movimento (só aparece o do movimento escolhido) ---
    const details = group(page, _('Motion details'));
    binder.resetButton(details, MOTION_KEYS);
    const style = s => s.get_string('magnification-style');
    const tweaks = [
        ['domino', sliderRow(binder, 'magnification-domino-tilt', _('Tilt'), null,
            {lower: 2, upper: 40, step: 1, format: v => `${Math.round(v)}°`}, true)],
        ['cylinder', sliderRow(binder, 'magnification-cylinder-angle', _('Curve'), null,
            {lower: 10, upper: 60, step: 2, format: v => `${Math.round(v)}°`}, true)],
        ['magnetic', sliderRow(binder, 'magnification-magnetic-strength', _('Pull'),
            _('How strongly icons snap to the pointer'),
            {lower: 2, upper: 30, step: 1, format: v => `${Math.round(v)} px`}, true)],
        ['jelly', sliderRow(binder, 'magnification-jelly-stretch', _('Stretch'), null,
            {lower: 0.1, upper: 1.5, step: 0.05, digits: 2, format: v => v.toFixed(2)})],
        ['jelly', sliderRow(binder, 'magnification-jelly-squish', _('Squash'), null,
            {lower: 0.1, upper: 0.9, step: 0.05, digits: 2, format: v => v.toFixed(2)})],
        ['coverflow', sliderRow(binder, 'magnification-coverflow-angle', _('Card angle'), null,
            {lower: 15, upper: 65, step: 2, format: v => `${Math.round(v)}°`}, true)],
    ];
    for (const [id, row] of tweaks) {
        details.add(row);
        binder.showWhen('magnification-style', s => style(s) === id, row);
    }
    binder.showWhen('magnification-style', s => tweaks.some(([id]) => id === style(s)), details);

    const spacing = group(page, _('Spacing'));
    spacing.add(spinRow(binder, 'icon-spacing', _('Space between icons'), 0, 24));
    spacing.add(spinRow(binder, 'dock-padding', _('Inner padding'), 0, 20,
        _('Extra space between the icons and the Dock edge')));

    const monitors = group(page, _('Monitors'));
    monitors.add(switchRow(binder, 'multi-monitor', _('Show the Dock on all monitors'),
        _('When off, the Dock appears only on the primary monitor')));

    return page;
}
