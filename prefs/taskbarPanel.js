// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/taskbarPanel.js — opções das barras de tarefas (Windows 10 e 7) na
// aba Estilos, no mesmo modelo da aba "Painel" da Luma Dock: modo painel,
// layout, Menu Iniciar, relógio e bandeja. Os textos são os mesmos da Luma
// (e as traduções também vieram de lá).
//
// Partes adaptadas da Luma Dock (src/prefs/PanelPage.js — Dhruva GNOME
// Extension, (C) 2026 NarkAgni, GPL-3.0-or-later).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {group, sliderRow, switchRow} from './rows.js';

const DATE_FORMAT_KEY = 'panel-date-format';
const DEFAULT_DATE_FORMAT = '%d/%m/%Y';
const WEB_SEARCH_URL_KEY = 'start-menu-web-search-url';
const TRAY_KEYS = ['tray-panel-indicators', 'tray-wide-indicators', 'tray-order'];

const WEB_SEARCH_PROVIDERS = () => [
    {name: 'Google', url: 'https://www.google.com/search?q=%s'},
    {name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s'},
    {name: 'Bing', url: 'https://www.bing.com/search?q=%s'},
    {name: 'Brave Search', url: 'https://search.brave.com/search?q=%s'},
    {name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s'},
    {name: 'Perplexity', url: 'https://www.perplexity.ai/search?q=%s'},
    {name: 'Kagi', url: 'https://kagi.com/search?q=%s'},
    {name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s'},
    {name: 'Yahoo', url: 'https://search.yahoo.com/search?p=%s'},
    {name: 'Yandex', url: 'https://yandex.com/search/?text=%s'},
    {name: 'Qwant', url: 'https://www.qwant.com/?q=%s'},
    {name: _('Custom'), url: null},
];

const DATE_FORMATS = () => [
    {name: _('System Default'), value: '%x'},
    {name: _('DD/MM/YYYY'), value: '%d/%m/%Y'},
    {name: _('MM/DD/YYYY'), value: '%m/%d/%Y'},
    {name: _('YYYY/MM/DD'), value: '%Y/%m/%d'},
    {name: _('YYYY-MM-DD (ISO 8601)'), value: '%Y-%m-%d'},
    {name: _('DD-MM-YYYY'), value: '%d-%m-%Y'},
    {name: _('DD.MM.YYYY'), value: '%d.%m.%Y'},
    {name: _('D/M/YYYY'), value: '%-d/%-m/%Y'},
    {name: _('DD/MM/YY'), value: '%d/%m/%y'},
    {name: 'DD/MM', value: '%d/%m'},
    {name: _('DD Mon YYYY'), value: '%d %b %Y'},
    {name: _('DD Month YYYY'), value: '%d %B %Y'},
    {name: _('Day DD Mon'), value: '%a %d %b'},
    {name: _('Day DD/MM'), value: '%a %d/%m'},
    {name: _('Weekday, DD Month YYYY'), value: '%A, %d %B %Y'},
];

/** Formato da data: cada opção mostra o nome e um exemplo de hoje. */
function dateFormatRow(binder) {
    const settings = binder.settings;
    const now = GLib.DateTime.new_now_local();
    const formats = DATE_FORMATS().map(format => ({...format, example: now.format(format.value)}));
    const formatOf = item => formats.find(format => format.value === item.get_item().get_string());
    const makeLabel = cssClass => {
        const label = new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.NONE});
        if (cssClass)
            label.add_css_class(cssClass);
        return label;
    };

    const listFactory = new Gtk.SignalListItemFactory();
    listFactory.connect('setup', (_f, item) => {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 4, margin_bottom: 4});
        box.append(makeLabel(null));
        box.append(makeLabel('dim-label'));
        item.set_child(box);
    });
    listFactory.connect('bind', (_f, item) => {
        const format = formatOf(item);
        const name = item.get_child().get_first_child();
        name.set_label(format.name);
        name.get_next_sibling().set_label(format.example);
    });
    const valueFactory = new Gtk.SignalListItemFactory();
    valueFactory.connect('setup', (_f, item) => item.set_child(makeLabel(null)));
    valueFactory.connect('bind', (_f, item) => item.get_child().set_label(formatOf(item).example));

    const row = new Adw.ComboRow({
        title: _('Date Format'),
        subtitle: _('How the date under the clock is written'),
        model: Gtk.StringList.new(formats.map(format => format.value)),
        factory: valueFactory,
        list_factory: listFactory,
    });
    const sync = () => {
        const index = formats.findIndex(format => format.value === settings.get_string(DATE_FORMAT_KEY));
        const target = index === -1 ? formats.findIndex(format => format.value === DEFAULT_DATE_FORMAT) : index;
        if (row.get_selected() !== target)
            row.set_selected(target);
    };
    row.connect('notify::selected', () => {
        const format = formats[row.get_selected()];
        if (format && settings.get_string(DATE_FORMAT_KEY) !== format.value)
            settings.set_string(DATE_FORMAT_KEY, format.value);
    });
    binder.watchOther(settings, DATE_FORMAT_KEY, sync);
    sync();
    return row;
}

/** Buscador da web do Menu Iniciar (com endereço personalizado). */
function webSearchRows(binder) {
    const settings = binder.settings;
    const providers = WEB_SEARCH_PROVIDERS();
    const customIndex = providers.length - 1;
    const providerRow = new Adw.ComboRow({
        title: _('Search Engine'),
        subtitle: _('Provider used for web searches in the Start Menu'),
        model: Gtk.StringList.new(providers.map(p => p.name)),
    });
    const urlRow = new Adw.EntryRow({
        title: _('Custom Search Address (%s is the search text)'),
        show_apply_button: true,
        text: settings.get_string(WEB_SEARCH_URL_KEY),
    });
    let updating = false;
    const sync = () => {
        updating = true;
        const url = settings.get_string(WEB_SEARCH_URL_KEY).trim();
        const match = providers.findIndex(p => p.url === url);
        const target = match !== -1 ? match : customIndex;
        if (providerRow.get_selected() !== target)
            providerRow.set_selected(target);
        if (urlRow.get_text() !== url)
            urlRow.set_text(url);
        urlRow.visible = settings.get_boolean('start-menu-web-search') && target === customIndex;
        updating = false;
    };
    providerRow.connect('notify::selected', () => {
        if (updating)
            return;
        const selected = providers[providerRow.get_selected()];
        if (selected?.url) {
            if (settings.get_string(WEB_SEARCH_URL_KEY) !== selected.url)
                settings.set_string(WEB_SEARCH_URL_KEY, selected.url);
            urlRow.visible = false;
        } else {
            urlRow.visible = settings.get_boolean('start-menu-web-search');
        }
    });
    urlRow.connect('apply', () => {
        const value = urlRow.get_text().trim();
        if (value)
            settings.set_string(WEB_SEARCH_URL_KEY, value);
        else
            settings.reset(WEB_SEARCH_URL_KEY);
        sync();
    });
    binder.watchOther(settings, WEB_SEARCH_URL_KEY, sync);
    binder.watchOther(settings, 'start-menu-web-search', sync);
    sync();
    return [providerRow, urlRow];
}

/** Liga uma chave do relógio do GNOME (org.gnome.desktop.interface). */
function clockSwitch(clock, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    clock.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * Acrescenta à `page` os grupos das barras de tarefas. `isTaskbar(settings)`
 * diz se o estilo atual é uma barra de tarefas (os grupos só aparecem nela).
 */
export function taskbarPanelGroups(page, binder, isTaskbar) {
    const settings = binder.settings;
    const panelOn = s => isTaskbar(s) && s.get_boolean('taskbar-merge-panel');

    // --- Modo painel: a barra de cima entra na barra de tarefas ---
    const hero = group(page, _('Panel Mode'),
        _('Moves the GNOME top bar into the dock: workspaces, tray, Quick Settings and the clock in one bar'));
    const enable = new Gtk.Switch({valign: Gtk.Align.CENTER});
    binder.bool('taskbar-merge-panel', enable);
    hero.set_header_suffix(enable);

    const layout = group(page, _('Panel Layout'));
    layout.add(switchRow(binder, 'panel-workspace-indicator', _('Workspace Indicator'),
        _('Show the workspace pills at the start of the panel')));

    // --- Menu Iniciar ---
    const start = group(page, _('Start Menu'),
        _('Opens from the start button of the Windows 10 and Windows 7 taskbars'));
    start.add(switchRow(binder, 'start-menu', _('Orla Dock Start Menu'),
        _('Pinned apps, recent apps and files, search, Lock and Power. Turn off to open GNOME’s app grid instead')));
    const startRows = [
        switchRow(binder, 'start-menu-recent-apps', _('Recent Apps'),
            _('Show the apps you use most under Pinned')),
        switchRow(binder, 'start-menu-continue', _('Continue Where You Left Off'),
            _('Show the files you opened recently')),
    ];
    const recent = sliderRow(binder, 'start-menu-recent-files', _('Recent Files'),
        _('How many files Continue where you left off shows'),
        {lower: 1, upper: 50, step: 1, format: v => `${Math.round(v)}`}, true);
    const providers = switchRow(binder, 'start-menu-search-providers', _('Search Providers'),
        _('Results from apps like Characters, Calendar and Calculator'));
    const web = switchRow(binder, 'start-menu-web-search', _('Web Search'),
        _('Offer to search the web for what you type'));
    const [engine, customUrl] = webSearchRows(binder);
    for (const row of [...startRows, recent, providers, web, engine, customUrl])
        start.add(row);
    const startOn = s => s.get_boolean('start-menu');
    binder.showWhen('start-menu', startOn, ...startRows, providers, web);
    binder.showWhen(['start-menu', 'start-menu-continue'],
        s => startOn(s) && s.get_boolean('start-menu-continue'), recent);
    binder.showWhen(['start-menu', 'start-menu-web-search'],
        s => startOn(s) && s.get_boolean('start-menu-web-search'), engine);

    // --- Relógio (são as chaves do próprio GNOME) ---
    const clock = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const clockGroup = group(page, _('Clock'),
        _('These are GNOME’s own clock settings, so the lock screen follows too'));
    clockGroup.add(clockSwitch(clock, 'clock-show-date', _('Date'), _('Second line under the time')));
    const dateFormat = dateFormatRow(binder);
    clockGroup.add(dateFormat);
    const syncDate = () => {
        dateFormat.visible = clock.get_boolean('clock-show-date');
    };
    binder.watchOther(clock, 'clock-show-date', syncDate);
    syncDate();
    clockGroup.add(clockSwitch(clock, 'clock-show-seconds', _('Seconds')));
    const format24 = new Adw.SwitchRow({title: _('24-Hour Time')});
    const sync24 = () => {
        const is24 = clock.get_string('clock-format') === '24h';
        if (format24.active !== is24)
            format24.active = is24;
    };
    format24.connect('notify::active', () => {
        const value = format24.active ? '24h' : '12h';
        if (clock.get_string('clock-format') !== value)
            clock.set_string('clock-format', value);
    });
    binder.watchOther(clock, 'clock-format', sync24);
    sync24();
    clockGroup.add(format24);

    // --- Bandeja ---
    const tray = group(page, _('Tray'),
        _('Small icons from other extensions live behind the arrow. Wide ones like CPU or network speed stay on the bar'));
    const reset = new Adw.ActionRow({
        title: _('Tidy Up Tray'),
        subtitle: _('Undo every move and reorder made from the tray'),
    });
    const resetButton = new Gtk.Button({label: _('Reset'), valign: Gtk.Align.CENTER});
    const syncReset = () => {
        resetButton.sensitive = TRAY_KEYS.some(key => settings.get_strv(key).length > 0);
    };
    resetButton.connect('clicked', () => TRAY_KEYS.forEach(key => settings.set_strv(key, [])));
    TRAY_KEYS.forEach(key => binder.watchOther(settings, key, syncReset));
    syncReset();
    reset.add_suffix(resetButton);
    tray.add(reset);
    tray.add(new Adw.ActionRow({
        title: _('Pin an icon to the bar'),
        subtitle: _('Open the tray from the arrow to pin, reorder, or move wide applets into it'),
    }));

    binder.showWhen('bar-style', isTaskbar, hero, start);
    binder.showWhen(['bar-style', 'taskbar-merge-panel'], panelOn, layout, clockGroup, tray);
}
