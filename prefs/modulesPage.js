// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/modulesPage.js — aba "Módulos": o que aparece na dock além dos
// apps — botão de aplicativos, locais (pastas e unidades), Lixeira e
// Stacks.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {enumRow, group, sliderRow, switchRow} from './rows.js';
import {colorRow, imageRow} from './widgets.js';
import {downloadsIconCards} from './downloadsIcon.js';

const APPS_ICON_GRID = 1;
const APPS_ICON_CUSTOM = 3;

export function modulesPage(binder, window, extensionPath) {
    const settings = binder.settings;
    const page = new Adw.PreferencesPage({
        title: _('Modules'),
        icon_name: 'view-app-grid-symbolic',
    });

    // --- Botão de aplicativos ---
    const apps = group(page, _('Applications button'));
    apps.add(switchRow(binder, 'show-apps-button', _('Show the applications button')));
    const appsSeparator = switchRow(binder, 'apps-button-separator', _('Separator after the button'),
        _('A divider between the applications button and the apps, like the one before Downloads and the Trash'));
    apps.add(appsSeparator);
    binder.showWhen('show-apps-button', s => s.get_boolean('show-apps-button'), appsSeparator);
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

    // --- Locais ---
    // Um liga/desliga por local, como na Luma. As pastas abrem como stacks.
    const places = group(page, _('Places'), _('Shortcuts that open as stacks'));
    places.add(switchRow(binder, 'show-home', _('Home')));
    places.add(switchRow(binder, 'show-downloads', _('Downloads')));
    places.add(switchRow(binder, 'show-documents', _('Documents')));
    places.add(switchRow(binder, 'show-pictures', _('Pictures')));
    places.add(switchRow(binder, 'show-videos', _('Videos')));
    places.add(switchRow(binder, 'show-music', _('Music')));
    places.add(switchRow(binder, 'show-mounts', _('USB and other drives'),
        _('Appear while they are connected')));
    places.add(switchRow(binder, 'show-trash', _('Trash')));

    // --- Ícone do Downloads: dois estilos, escolhidos pela prévia ---
    const downloads = group(page, _('Downloads icon'),
        _('Click a preview to choose how the Downloads folder looks on the Dock'));
    downloads.add(downloadsIconCards(binder, extensionPath));
    binder.showWhen('show-downloads', s => s.get_boolean('show-downloads'), downloads);

    // --- Stacks ---
    const stacks = group(page, _('Stacks'));
    stacks.add(enumRow(binder, 'stack-view', _('Open stacks as'),
        [_('Automatic'), _('Grid'), _('Fan'), _('List')],
        _('Automatic uses a fan for small stacks on a bottom Dock, and a grid otherwise')));
    stacks.add(enumRow(binder, 'stack-sort', _('Sort stack items by'), [_('Date'), _('Name')]));

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
