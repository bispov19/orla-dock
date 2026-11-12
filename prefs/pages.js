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

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ShortcutRow, comboRow, scaleRow, sizeAndMagnificationRow} from './widgets.js';

function switchRow(binder, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    binder.bool(key, row);
    return row;
}

// ---------------------------------------------------------------- Dock

export function dockPage(binder) {
    const page = new Adw.PreferencesPage({
        title: _('Dock'),
        icon_name: 'user-desktop-symbolic',
    });

    const dock = new Adw.PreferencesGroup({title: _('Dock')});
    page.add(dock);

    dock.add(sizeAndMagnificationRow(binder));

    const position = comboRow(_('Position on screen'),
        [_('Bottom'), _('Top'), _('Left'), _('Right')]);
    binder.enum('position', position);
    dock.add(position);

    const minimize = comboRow(_('Minimize windows using'),
        [_('Genie effect'), _('Scale effect')]);
    binder.enum('minimize-effect', minimize);
    dock.add(minimize);

    dock.add(switchRow(binder, 'minimize-to-app',
        _('Minimize windows into application icon'),
        _('When off, each minimized window gets its own thumbnail next to the Trash')));
    dock.add(switchRow(binder, 'autohide', _('Automatically hide and show the Dock')));
    dock.add(new ShortcutRow(binder.settings, 'orla-toggle-autohide', {
        title: _('Shortcut to turn hiding on or off'),
    }));
    dock.add(switchRow(binder, 'animate-launch', _('Animate opening applications')));
    dock.add(switchRow(binder, 'show-indicators', _('Show indicators for open applications')));
    dock.add(switchRow(binder, 'show-recent', _('Show suggested and recent apps in Dock')));

    const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
    page.add(behavior);
    behavior.add(switchRow(binder, 'show-apps-button', _('Show the applications button')));
    behavior.add(switchRow(binder, 'window-previews', _('Show window previews on hover')));
    behavior.add(switchRow(binder, 'show-badges', _('Show notification badges and progress')));
    behavior.add(switchRow(binder, 'bounce-on-attention',
        _('Bounce when an application needs attention')));
    behavior.add(switchRow(binder, 'hide-overview-dash',
        _('Hide the GNOME dash in the Activities overview')));

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
    const group = new Adw.PreferencesGroup({
        title: _('Appearance'),
        description: _('The Dock follows the system light or dark style.'),
    });
    page.add(group);

    const opacity = scaleRow(_('Background opacity'), null,
        {lower: 0, upper: 1, step: 0.05, digits: 2, marks: [[0, '0%'], [1, '100%']]});
    binder.number('background-opacity', opacity.adjustment);
    group.add(opacity.row);

    const blur = scaleRow(_('Blur intensity'), _('0 turns blur off'),
        {lower: 0, upper: 80, step: 1, marks: [[0, _('Off')], [80, _('Strong')]]});
    binder.number('blur-radius', blur.adjustment, {integer: true});
    group.add(blur.row);

    const radius = scaleRow(_('Corner radius'), null,
        {lower: 0, upper: 40, step: 1, marks: [[0, _('Square')], [40, _('Round')]]});
    binder.number('corner-radius', radius.adjustment, {integer: true});
    group.add(radius.row);

    const margin = new Adw.SpinRow({
        title: _('Distance from screen edge'),
        adjustment: new Gtk.Adjustment({lower: 0, upper: 40, step_increment: 1}),
    });
    binder.number('dock-margin', margin.adjustment, {integer: true});
    group.add(margin);

    group.add(switchRow(binder, 'icon-reflection', _('Icon reflection'),
        _('A subtle reflection under the icons (bottom Dock only)')));

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

    const view = comboRow(_('Open stacks as'),
        [_('Automatic'), _('Grid'), _('Fan'), _('List')],
        _('Automatic uses a fan for small stacks on a bottom Dock, and a grid otherwise'));
    binder.enum('stack-view', view);
    group.add(view);

    const sort = comboRow(_('Sort stack items by'), [_('Date'), _('Name')]);
    binder.enum('stack-sort', sort);
    group.add(sort);

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
    const id = settings.connect('changed::stack-folders', refresh);
    window.connect('close-request', () => settings.disconnect(id));
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
