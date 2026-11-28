// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// prefs/panelOptions.js — opções da barra de tarefas na aba Estilos: modo
// Painel, relógio e bandeja. Só aparecem com um estilo de
// barra de tarefas escolhido.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {group, switchRow} from './rows.js';

// Formatos da data embaixo do relógio (códigos do GLib.DateTime.format).
const DATE_FORMATS = ['%x', '%d/%m/%Y', '%d/%m/%y', '%-d/%-m/%Y', '%m/%d/%Y', '%Y-%m-%d',
    '%d.%m.%Y', '%d %b %Y', '%d de %B', '%a, %d/%m', '%a %d %b', '%A, %d de %B'];

/**
 * Uma lista suspensa ligada a uma chave de texto: `choices` são pares
 * [rótulo, valor]; se o valor salvo não estiver na lista, a última opção
 * ("Personalizado") fica marcada e `onCustom` decide o que mostrar.
 */
function stringChoiceRow(binder, settings, key, title, subtitle, choices, {custom = null, onChange = () => {}} = {}) {
    const labels = choices.map(([label]) => label);
    if (custom)
        labels.push(custom);
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
    const sync = () => {
        const index = choices.findIndex(([, value]) => value === settings.get_string(key));
        const wanted = index >= 0 ? index : (custom ? choices.length : 0);
        if (row.selected !== wanted)
            row.selected = wanted;
        onChange(index < 0);
    };
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice && settings.get_string(key) !== choice[1])
            settings.set_string(key, choice[1]);
        onChange(!choice);
    });
    binder.watchOther(settings, key, sync);
    sync();
    return row;
}

function clockGroup(page, binder) {
    // As opções do relógio do GNOME (valem também para a tela de bloqueio).
    const clock = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const box = group(page, _('Clock'), _('GNOME’s own clock settings, so the lock screen follows too'));

    const gnomeSwitch = (key, title, subtitle = null) => {
        const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
        clock.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    };
    const date = gnomeSwitch('clock-show-date', _('Date'), _('Second line under the time'));
    box.add(date);

    // Cada formato aparece já com a data de hoje, em vez de um código.
    const today = GLib.DateTime.new_now_local();
    const formats = DATE_FORMATS.map(code => [today.format(code) ?? code, code]);
    const format = stringChoiceRow(binder, binder.settings, 'panel-date-format', _('Date format'),
        _('How the date under the clock is written'), formats);
    box.add(format);
    const syncDate = () => {
        format.visible = clock.get_boolean('clock-show-date');
    };
    binder.watchOther(clock, 'clock-show-date', syncDate);
    syncDate();

    box.add(gnomeSwitch('clock-show-seconds', _('Seconds')));
    const hours = new Adw.SwitchRow({title: _('24-hour time')});
    const syncHours = () => {
        const is24 = clock.get_string('clock-format') === '24h';
        if (hours.active !== is24)
            hours.active = is24;
    };
    hours.connect('notify::active', () => {
        const value = hours.active ? '24h' : '12h';
        if (clock.get_string('clock-format') !== value)
            clock.set_string('clock-format', value);
    });
    binder.watchOther(clock, 'clock-format', syncHours);
    syncHours();
    box.add(hours);
    return box;
}

function trayGroup(page, binder) {
    const settings = binder.settings;
    const keys = ['tray-panel-indicators', 'tray-wide-indicators', 'tray-order', 'panel-applet-order'];
    const tray = group(page, _('Tray'),
        _('Icons from other extensions live behind the arrow at the end of the bar; ones with text stay on the bar. ' +
          'Use “Manage” in the tray to move or reorder them'));
    const row = new Adw.ActionRow({title: _('Reset the tray'), subtitle: _('Undo every move and reorder')});
    const button = new Gtk.Button({label: _('Reset'), valign: Gtk.Align.CENTER});
    const sync = () => {
        button.sensitive = keys.some(key => settings.get_strv(key).length > 0);
    };
    button.connect('clicked', () => keys.forEach(key => settings.reset(key)));
    keys.forEach(key => binder.watchOther(settings, key, sync));
    sync();
    row.add_suffix(button);
    tray.add(row);
    return tray;
}

/**
 * Acrescenta à `page` os grupos da barra de tarefas. `isTaskbar(settings)`
 * diz se o estilo escolhido é uma barra de tarefas.
 */
export function panelOptionGroups(page, binder, isTaskbar) {
    const panel = group(page, _('Panel Mode'),
        _('Moves the GNOME top bar into the taskbar: workspaces, tray, Quick Settings and the clock in one bar'));
    const enable = new Gtk.Switch({valign: Gtk.Align.CENTER});
    binder.bool('taskbar-merge-panel', enable);
    panel.set_header_suffix(enable);
    const workspaces = switchRow(binder, 'panel-workspace-indicator', _('Workspace indicator'),
        _('Dots at the start of the bar; scroll over them to switch workspaces'));
    panel.add(workspaces);

    const clock = clockGroup(page, binder);
    const tray = trayGroup(page, binder);

    const panelOn = s => isTaskbar(s) && s.get_boolean('taskbar-merge-panel');
    binder.showWhen('bar-style', isTaskbar, panel);
    binder.showWhen(['bar-style', 'taskbar-merge-panel'], panelOn, workspaces, clock, tray);
}
