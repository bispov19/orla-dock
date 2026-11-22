// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/panelOptions.js — opções da barra de tarefas na aba Estilos: modo
// Painel, Menu Iniciar, relógio e bandeja. Só aparecem com um estilo de
// barra de tarefas escolhido.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {group, spinRow, switchRow} from './rows.js';

// Buscadores para "Pesquisar na web" (%s = o texto digitado).
const ENGINES = [
    ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'],
    ['Google', 'https://www.google.com/search?q=%s'],
    ['Bing', 'https://www.bing.com/search?q=%s'],
    ['Brave Search', 'https://search.brave.com/search?q=%s'],
    ['Startpage', 'https://www.startpage.com/do/search?query=%s'],
    ['Ecosia', 'https://www.ecosia.org/search?q=%s'],
    ['Kagi', 'https://kagi.com/search?q=%s'],
    ['Qwant', 'https://www.qwant.com/?q=%s'],
];

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

function startMenuGroup(page, binder) {
    const settings = binder.settings;
    const start = group(page, _('Start Menu'), _('Opens from the start button of the taskbar'));
    start.add(switchRow(binder, 'start-menu', _('Orla Dock Start Menu'),
        _('Pinned apps, recent apps and files, search and power options. Off: GNOME’s app grid')));

    const rows = [
        switchRow(binder, 'start-menu-recent-apps', _('Recent apps'), _('The apps you opened last, under Pinned')),
        switchRow(binder, 'start-menu-continue', _('Continue where you left off'), _('Files you opened recently')),
        spinRow(binder, 'start-menu-recent-files', _('How many files'), 1, 50),
        switchRow(binder, 'start-menu-search-providers', _('Results from other apps'),
            _('Search results from apps like Calendar, Contacts and Characters')),
        switchRow(binder, 'start-menu-web-search', _('Web search'), _('Offer to search the web for what you type')),
    ];
    rows.forEach(row => start.add(row));

    const address = new Adw.EntryRow({title: _('Search address (%s is the text you type)')});
    address.text = settings.get_string('start-menu-web-search-url');
    address.connect('apply', () => {
        const url = address.text.trim();
        if (url.includes('%s'))
            settings.set_string('start-menu-web-search-url', url);
    });
    address.show_apply_button = true;
    const engine = stringChoiceRow(binder, settings, 'start-menu-web-search-url', _('Search engine'), null,
        ENGINES, {
            custom: _('Custom'),
            onChange: isCustom => {
                address.visible = isCustom && settings.get_boolean('start-menu-web-search');
                if (!isCustom)
                    address.text = settings.get_string('start-menu-web-search-url');
            },
        });
    start.add(engine);
    start.add(address);

    const on = s => s.get_boolean('start-menu');
    binder.showWhen('start-menu', on, ...rows);
    binder.showWhen(['start-menu', 'start-menu-continue'],
        s => on(s) && s.get_boolean('start-menu-continue'), rows[2]);
    binder.showWhen(['start-menu', 'start-menu-web-search'],
        s => on(s) && s.get_boolean('start-menu-web-search'), engine);
    return start;
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

    const start = startMenuGroup(page, binder);
    const clock = clockGroup(page, binder);
    const tray = trayGroup(page, binder);

    const panelOn = s => isTaskbar(s) && s.get_boolean('taskbar-merge-panel');
    binder.showWhen('bar-style', isTaskbar, panel, start);
    binder.showWhen(['bar-style', 'taskbar-merge-panel'], panelOn, workspaces, clock, tray);
}
