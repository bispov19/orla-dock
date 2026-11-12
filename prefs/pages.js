// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/pages.js — as páginas da janela de preferências, inspiradas no
// painel "Mesa e Dock" dos Ajustes do macOS.
//
// Estrutura do libadwaita (Adw):
//   Adw.PreferencesPage   → uma "aba" (aparece no seletor do topo)
//   Adw.PreferencesGroup  → um bloco com título dentro da página
//   Adw.*Row              → cada linha: SwitchRow (liga/desliga),
//                           ComboRow (lista), ActionRow (genérica)…
//   Adw.ExpanderRow       → uma linha que "abre" mostrando mais linhas
//
// Os valores dos enums (ex.: 'layout-mode' = 1) seguem a ordem declarada
// no schema.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    ShortcutRow, colorRow, comboRow, imageRow, scaleRow, sizeAndMagnificationRow,
} from './widgets.js';

const TASKBAR = 1;
const APPS_ICON_GRID = 1;
const APPS_ICON_CUSTOM = 3;
const THEME_CUSTOM = 1;
const COLOR_CUSTOM = 2;

function switchRow(binder, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    binder.bool(key, row);
    return row;
}

function sliderRow(binder, key, title, subtitle, params, integer = false) {
    const {row, adjustment} = scaleRow(title, subtitle, params);
    binder.number(key, adjustment, {integer});
    return row;
}

function spinRow(binder, key, title, lower, upper, subtitle = null) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
    });
    binder.number(key, row.adjustment, {integer: true});
    return row;
}

function enumRow(binder, key, title, items, subtitle = null) {
    const row = comboRow(title, items, subtitle);
    binder.enum(key, row);
    return row;
}

const isTaskbar = s => s.get_enum('layout-mode') === TASKBAR;

// ---------------------------------------------------------------- Dock

export function dockPage(binder, window) {
    const page = new Adw.PreferencesPage({
        title: _('Dock'),
        icon_name: 'user-desktop-symbolic',
    });

    // --- Estilo: dock ou barra de tarefas ---
    const styleGroup = new Adw.PreferencesGroup({
        title: _('Style'),
        description: _('A floating dock with magnification, or a full-width taskbar'),
    });
    page.add(styleGroup);
    styleGroup.add(enumRow(binder, 'layout-mode', _('Layout'),
        [_('Dock (macOS)'), _('Taskbar (Windows 10)')]));

    // --- Dock ---
    const dock = new Adw.PreferencesGroup({title: _('Dock')});
    page.add(dock);
    dock.add(sizeAndMagnificationRow(binder));

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
    dock.add(zoom);
    binder.showWhen('layout-mode', s => !isTaskbar(s), dock);

    // --- Barra de tarefas ---
    const taskbar = new Adw.PreferencesGroup({title: _('Taskbar')});
    page.add(taskbar);
    taskbar.add(spinRow(binder, 'taskbar-icon-size', _('Icon size'), 16, 64));
    taskbar.add(switchRow(binder, 'taskbar-clock', _('Show clock and date')));
    binder.showWhen('layout-mode', isTaskbar, taskbar);

    // --- Comum ---
    const general = new Adw.PreferencesGroup({title: _('Position and windows')});
    page.add(general);
    general.add(enumRow(binder, 'position', _('Position on screen'),
        [_('Bottom'), _('Top'), _('Left'), _('Right')]));
    general.add(enumRow(binder, 'minimize-effect', _('Minimize windows using'),
        [_('Genie effect'), _('Scale effect')]));
    general.add(switchRow(binder, 'minimize-to-app',
        _('Minimize windows into application icon'),
        _('When off, minimized windows go next to the Downloads folder, like on macOS')));
    general.add(switchRow(binder, 'autohide', _('Automatically hide and show the Dock')));
    general.add(new ShortcutRow(binder.settings, 'orla-toggle-autohide', {
        title: _('Shortcut to turn hiding on or off'),
    }));
    general.add(switchRow(binder, 'animate-launch', _('Animate opening applications')));
    general.add(switchRow(binder, 'show-indicators', _('Show indicators for open applications')));
    general.add(switchRow(binder, 'show-recent', _('Show suggested and recent apps in Dock'),
        _('Closed apps stay in the Dock for a while, like on macOS')));

    // --- Botão de aplicativos ---
    const apps = new Adw.PreferencesGroup({title: _('Applications button')});
    page.add(apps);
    apps.add(switchRow(binder, 'show-apps-button', _('Show the applications button')));
    apps.add(enumRow(binder, 'apps-button-icon', _('Icon'),
        [_('System logo'), _('Grid'), _('Coloured tile'), _('Custom image')]));
    const gridColor = colorRow(binder, 'apps-button-color', _('Grid colour'));
    apps.add(gridColor);
    binder.showWhen('apps-button-icon', s => s.get_enum('apps-button-icon') === APPS_ICON_GRID, gridColor);
    const image = imageRow(binder, 'apps-button-custom-icon', _('Image'), window);
    apps.add(image);
    binder.showWhen('apps-button-icon', s => s.get_enum('apps-button-icon') === APPS_ICON_CUSTOM, image);
    apps.add(sliderRow(binder, 'apps-button-icon-scale', _('Icon scale'), null,
        {lower: 50, upper: 200, step: 5, marks: [[50, '50%'], [100, '100%'], [200, '200%']]}, true));

    // --- Comportamento ---
    const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
    page.add(behavior);
    behavior.add(switchRow(binder, 'window-previews', _('Show window previews on hover')));
    behavior.add(switchRow(binder, 'show-badges', _('Show notification badges and progress')));
    behavior.add(switchRow(binder, 'bounce-on-attention',
        _('Bounce when an application needs attention')));
    behavior.add(switchRow(binder, 'dynamic-calendar-icon', _("Show today's date on the Calendar icon")));
    behavior.add(switchRow(binder, 'hide-overview-dash',
        _('Hide the GNOME dash in the Activities overview')));

    // --- Monitores ---
    const monitors = new Adw.PreferencesGroup({title: _('Monitors')});
    page.add(monitors);
    monitors.add(switchRow(binder, 'multi-monitor', _('Show the Dock on all monitors'),
        _('When off, the Dock appears only on the primary monitor')));

    return page;
}

// ---------------------------------------------------------------- Aparência

export function appearancePage(binder) {
    const page = new Adw.PreferencesPage({
        title: _('Appearance'),
        icon_name: 'applications-graphics-symbolic',
    });

    // --- Fundo ---
    const background = new Adw.PreferencesGroup({title: _('Background')});
    page.add(background);
    background.add(enumRow(binder, 'theme', _('Theme'), [
        _('System (light or dark)'), _('Custom colour'), _('Wallpaper colour'),
        'Carbon', 'Nord', 'Catppuccin Mocha', 'Gruvbox', 'Dracula', 'Tokyo Night', 'Frost',
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

    // --- Vidro ---
    const glass = new Adw.PreferencesGroup({
        title: _('Glass'),
        description: _('The blur shows what is behind the Dock, like frosted glass'),
    });
    page.add(glass);
    glass.add(sliderRow(binder, 'blur-radius', _('Blur intensity'), _('0 turns blur off'),
        {lower: 0, upper: 80, step: 1, marks: [[0, _('Off')], [80, _('Strong')]]}, true));
    glass.add(sliderRow(binder, 'blur-brightness', _('Brightness'),
        _('Darker glass on the left, lighter on the right'),
        {lower: 0.2, upper: 1, step: 0.05, digits: 2, marks: [[0.2, _('Dark')], [1, _('Light')]]}));
    glass.add(sliderRow(binder, 'blur-vibrancy', _('Vibrancy'),
        _('Colour saturation seen through the glass'),
        {lower: 0, upper: 2, step: 0.05, digits: 2, marks: [[0, _('Grey')], [1, _('Normal')], [2, _('Vivid')]]}));
    glass.add(sliderRow(binder, 'glass-glow', _('Edge glow'), _('A light rim on the glass edge'),
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, _('Off')], [1, _('Strong')]]}));

    // --- Forma ---
    const shape = new Adw.PreferencesGroup({title: _('Shape')});
    page.add(shape);
    shape.add(sliderRow(binder, 'corner-radius', _('Corner radius'), null,
        {lower: 0, upper: 40, step: 1, marks: [[0, _('Square')], [40, _('Round')]]}, true));
    shape.add(spinRow(binder, 'border-width', _('Outline'), 0, 4, _('Line around the Dock, 0 hides it')));
    shape.add(colorRow(binder, 'border-color', _('Outline colour')));
    shape.add(sliderRow(binder, 'border-opacity', _('Outline opacity'), null,
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, '0%'], [1, '100%']]}));
    shape.add(spinRow(binder, 'dock-margin', _('Distance from screen edge'), 0, 40));
    shape.add(spinRow(binder, 'icon-spacing', _('Space between icons'), 0, 24));
    shape.add(spinRow(binder, 'dock-padding', _('Inner padding'), 0, 20,
        _('Extra space between the icons and the Dock edge')));
    shape.add(switchRow(binder, 'icon-reflection', _('Icon reflection'),
        _('A subtle reflection under the icons (bottom Dock only)')));

    // --- Apps abertos ---
    const running = new Adw.PreferencesGroup({title: _('Running apps')});
    page.add(running);
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
    const separators = new Adw.PreferencesGroup({title: _('Separators')});
    page.add(separators);
    separators.add(spinRow(binder, 'separator-thickness', _('Thickness'), 0, 6, _('0 hides the separators')));
    separators.add(sliderRow(binder, 'separator-length', _('Length'), _('Share of the icon height'),
        {lower: 0.2, upper: 1, step: 0.05, digits: 2, marks: [[0.2, '20%'], [1, '100%']]}));
    separators.add(colorRow(binder, 'separator-color', _('Colour')));
    separators.add(sliderRow(binder, 'separator-opacity', _('Opacity'), null,
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, '0%'], [1, '100%']]}));

    return page;
}

// ---------------------------------------------------------------- Stacks

export function stacksPage(binder, window) {
    const settings = binder.settings;
    const page = new Adw.PreferencesPage({
        title: _('Stacks and Trash'),
        icon_name: 'folder-symbolic',
    });

    const group = new Adw.PreferencesGroup({title: _('Stacks and Trash')});
    page.add(group);
    group.add(switchRow(binder, 'show-downloads', _('Show Downloads')));
    group.add(switchRow(binder, 'show-trash', _('Show Trash')));
    group.add(enumRow(binder, 'stack-view', _('Open stacks as'),
        [_('Automatic'), _('Grid'), _('Fan'), _('List')],
        _('Automatic uses a fan for small stacks on a bottom Dock, and a grid otherwise')));
    group.add(enumRow(binder, 'stack-sort', _('Sort stack items by'), [_('Date'), _('Name')]));

    // --- Pastas extras ---
    const folders = new Adw.PreferencesGroup({
        title: _('Other folders'),
        description: _('Folders shown as stacks next to the Trash'),
    });
    page.add(folders);

    const addButton = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: _('Add folder…'),
        css_classes: ['flat'],
    });
    folders.set_header_suffix(addButton);

    let rows = [];
    const refresh = () => {
        rows.forEach(r => folders.remove(r));
        rows = settings.get_strv('stack-folders').map(uri => {
            const file = Gio.File.new_for_uri(uri);
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(file.get_basename() ?? uri, -1),
                subtitle: GLib.markup_escape_text(file.get_path() ?? uri, -1),
            });
            row.add_prefix(new Gtk.Image({icon_name: 'folder-symbolic'}));
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => {
                settings.set_strv('stack-folders',
                    settings.get_strv('stack-folders').filter(u => u !== uri));
            });
            row.add_suffix(remove);
            folders.add(row);
            return row;
        });
    };
    binder._watch('stack-folders', refresh);
    refresh();

    // Gtk.FileDialog: o seletor de arquivos/pastas padrão do GTK 4.
    addButton.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({title: _('Choose a folder')});
        dialog.select_folder(window, null, (dlg, res) => {
            let folder;
            try {
                folder = dlg.select_folder_finish(res);
            } catch {
                return;   // cancelado
            }
            const uris = settings.get_strv('stack-folders');
            if (folder && !uris.includes(folder.get_uri()))
                settings.set_strv('stack-folders', [...uris, folder.get_uri()]);
        });
    });

    return page;
}

// ---------------------------------------------------------------- Sobre

const REPO_URL = 'https://github.com/viniciusbispo19/orla-dock';
const PROFILE_URL = 'https://github.com/viniciusbispo19';

/** Linha clicável que abre um endereço no navegador. */
function linkRow(window, title, subtitle, uri, icon) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_prefix(new Gtk.Image({icon_name: icon}));
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    // Gtk.UriLauncher abre o link no aplicativo padrão (o navegador).
    row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
    return row;
}

/** Um bloco de texto que quebra linha, dentro de um cartão. */
function textRow(text) {
    const row = new Adw.PreferencesRow({activatable: false});
    row.set_child(new Gtk.Label({
        label: text,
        wrap: true,
        xalign: 0,
        margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
    }));
    return row;
}

export function aboutPage(metadata, extensionPath, window) {
    const page = new Adw.PreferencesPage({
        title: _('About'),
        icon_name: 'help-about-symbolic',
    });

    // --- Cabeçalho: logo, nome e versão ---
    const header = new Adw.PreferencesGroup();
    page.add(header);
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        margin_top: 6,
    });
    const logo = Gio.File.new_for_path(GLib.build_filenamev([extensionPath, 'icons', 'orla-logo.svg']));
    box.append(new Gtk.Image({gicon: new Gio.FileIcon({file: logo}), pixel_size: 112}));
    box.append(new Gtk.Label({label: 'Orla Dock', css_classes: ['title-1']}));
    box.append(new Gtk.Label({
        label: _('Version %s').format(metadata['version-name'] ?? metadata.version ?? '?'),
        css_classes: ['dim-label'],
    }));
    box.append(new Gtk.Label({
        label: _('A dock for GNOME inspired by the macOS Dock, with a Windows 10 taskbar mode.'),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        max_width_chars: 50,
    }));
    header.add(box);

    // --- Sobre mim ---
    const me = new Adw.PreferencesGroup({title: _('About me')});
    page.add(me);
    // Aspas duplas por causa do apóstrofo em "I'm" (o xgettext não lida
    // bem com \' escapado).
    me.add(textRow(_("Hi! I'm Vinicius Bispo (Vini), a Systems Analysis and Development student " +
        'making the move into technology. I created Orla Dock from scratch to learn how GNOME ' +
        'works from the inside — and to have the dock I always wanted on my own desktop.\n\n' +
        'The code is commented in Portuguese, step by step, so that other people who are ' +
        'starting out can learn from it too. Suggestions and contributions are very welcome!')));
    me.add(linkRow(window, _('My GitHub profile'), 'github.com/viniciusbispo19',
        PROFILE_URL, 'avatar-default-symbolic'));

    // --- Projeto ---
    const project = new Adw.PreferencesGroup({title: _('Project')});
    page.add(project);
    project.add(linkRow(window, _('Source code'), _('See the code, star it or contribute'),
        REPO_URL, 'text-x-generic-symbolic'));
    project.add(linkRow(window, _('Report a problem'), _('Found a bug or have an idea? Open an issue'),
        `${REPO_URL}/issues`, 'dialog-warning-symbolic'));

    // --- Licença ---
    const license = new Adw.PreferencesGroup({title: _('License')});
    page.add(license);
    license.add(textRow(_('Orla Dock is free software, released under the GNU General Public ' +
        'License, version 3 or later (GPL-3.0-or-later). It comes with absolutely no warranty.')));

    return page;
}
