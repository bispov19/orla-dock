// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// start/search.js — os resultados da busca do Menu Iniciar.
//
// Ordem: conta (calculadora) → melhor resultado (o app mais provável, em
// destaque) → Apps → Configurações → Arquivos → resultados de outros apps
// (provedores de busca do GNOME) → pesquisar na web.
//
// Começando com ">", vira um comando: Enter roda em segundo plano e
// Ctrl+Enter abre num terminal.
//
// Apps, configurações e calculadora respondem na hora; arquivos e
// provedores chegam depois (assíncronos) e só entram se a busca ainda for
// a mesma (cada busca tem um "token").

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {calculate} from './calculator.js';
import {queryWords} from './data.js';
import {Row, sectionHeader} from './widgets.js';

const MAX_APPS = 6;
const SLOW_DELAY_MS = 120;

export class SearchView {
    constructor(menu) {
        this._menu = menu;
        this._data = menu.data;
        this._first = null;
        this.actor = new St.ScrollView({
            style_class: 'orla-start-scroll orla-start-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true,
        });
        this._box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this.actor.set_child(this._box);
        this._slow = null;
    }

    /** Uma busca nova (a cada letra digitada). */
    setQuery(text) {
        this._text = text;
        this._token = {};
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this._box.destroy_all_children();
        this._first = null;
        this._fileGroup = null;
        this._empty = null;
        this._commandRun = null;

        if (text.trimStart().startsWith('>')) {
            this._showCommand(text.trimStart().slice(1).trim());
            return;
        }
        const words = queryWords(text);
        this._showFast(text, words);
        // Arquivos e outros apps: depois de uma pausa curta na digitação.
        const token = this._token;
        this._menu.later(SLOW_DELAY_MS, () => {
            if (token === this._token)
                this._showSlow(words, token);
        });
    }

    _showFast(text, words) {
        const result = calculate(text);
        if (result !== null) {
            const shown = String(result).replace('.', (1.5).toLocaleString().charAt(1));
            this._add(_('Calculator'), [{
                iconName: 'accessories-calculator-symbolic',
                title: `= ${shown}`,
                subtitle: _('Copy the result'),
                activate: () => {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, String(shown));
                    this._menu.close();
                },
            }], 'orla-start-best');
        }

        const apps = this._data.searchApps(words);
        if (apps.length) {
            const [best, ...rest] = apps;
            this._add(_('Best match'), [this._appEntry(best, _('App'))], 'orla-start-best');
            if (rest.length)
                this._add(_('Apps'), rest.slice(0, MAX_APPS).map(app => this._appEntry(app)));
        }
        const panels = this._data.searchSettings(words);
        if (panels.length)
            this._add(_('Settings'), panels.map(app => this._appEntry(app)));

        // O lugar dos arquivos fica reservado: eles chegam depois.
        this._fileGroup = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._box.add_child(this._fileGroup);
        this._providerGroup = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._box.add_child(this._providerGroup);

        if (this._menu.settings.get_boolean('start-menu-web-search') && text.trim()) {
            this._add(_('Web'), [{
                iconName: 'web-browser-symbolic',
                title: _('Search %s for “%s”').format(this._data.webSearchName(), text.trim()),
                subtitle: _('Opens in your browser'),
                activate: () => this._menu.openUri(this._data.webSearchUri(text.trim())),
            }]);
        }
        if (!this._first)
            this._showEmpty(text);
    }

    async _showSlow(words, token) {
        const files = await this._data.searchFiles(words);
        if (token !== this._token || !this._fileGroup)
            return;
        if (files.length) {
            this._removeEmpty();
            this._fill(this._fileGroup, _('Files'), files.map(entry => ({
                gicon: entry.gicon,
                title: entry.name,
                subtitle: entry.file.get_parent()?.get_path()?.replace(GLib.get_home_dir(), '~') ?? '',
                activate: () => this._menu.openFile(entry.file),
                menu: () => this._menu.fileMenu(entry.file),
            })));
        }
        const groups = await this._data.searchProviders(words, this._cancellable);
        if (token !== this._token)
            return;
        for (const {provider, metas} of groups) {
            this._removeEmpty();
            const name = provider.appInfo?.get_name() ?? '';
            this._fill(this._providerGroup, name, metas.map(meta => ({
                iconActor: meta.createIcon(24),
                title: meta.name,
                subtitle: meta.description ?? '',
                activate: () => {
                    provider.activateResult(meta.id, words);
                    this._menu.close();
                },
            })), true);
        }
    }

    _showCommand(command) {
        const run = inTerminal => {
            if (command)
                this._menu.runCommand(command, inTerminal);
        };
        this._add(_('Command'), [
            {
                iconName: 'system-run-symbolic',
                title: command || _('Type a command to run'),
                subtitle: _('Run in Background · Enter'),
                activate: () => run(false),
            },
            {
                iconName: 'utilities-terminal-symbolic',
                title: command || _('Type a command to run'),
                subtitle: _('Run in Terminal · Ctrl+Enter'),
                activate: () => run(true),
            },
        ], 'orla-start-best');
        this._commandRun = run;
    }

    _appEntry(app, subtitle = '') {
        return {
            app,
            title: app.get_name(),
            subtitle,
            activate: () => this._menu.launch(app),
            menu: () => this._menu.appMenu(app),
        };
    }

    _add(title, entries, styleClass = '') {
        const group = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._fill(group, title, entries, false, styleClass);
        this._box.add_child(group);
    }

    _fill(group, title, entries, append = false, styleClass = '') {
        if (!append)
            group.destroy_all_children();
        group.add_child(sectionHeader(title));
        for (const entry of entries) {
            const row = new Row({
                ...entry,
                iconActor: entry.iconActor ?? (entry.iconName ? new St.Icon({icon_name: entry.iconName, icon_size: 24}) : null),
                owner: this._menu,
                styleClass,
            });
            this._first ??= row;
            group.add_child(row);
        }
    }

    _showEmpty(text) {
        this._empty = new St.Label({
            text: _('No results for “%s”').format(text.trim()),
            style_class: 'orla-start-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._box.insert_child_at_index(this._empty, 0);
    }

    _removeEmpty() {
        this._empty?.destroy();
        this._empty = null;
    }

    /** Enter na busca: o primeiro resultado (ou rodar o comando). */
    activateFirst(withCtrl) {
        if (this._commandRun) {
            this._commandRun(withCtrl);
            return;
        }
        this._first?.emit('clicked', 0);
    }

    focusFirst() {
        this._first?.grab_key_focus();
    }

    destroy() {
        this._token = null;
        this._cancellable?.cancel();
        this.actor.destroy();
    }
}
