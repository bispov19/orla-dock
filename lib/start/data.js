// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// start/data.js — de onde o Menu Iniciar tira o que mostra.
//
//   Fixados    os favoritos do GNOME (os mesmos da dock e do dash)
//   Recentes   start-menu-recent-app-ids, atualizado quando um app abre
//   Arquivos   o histórico de arquivos do GNOME (recently-used.xbel)
//   Busca      apps, painéis das Configurações, arquivos da pasta pessoal,
//              provedores de busca do GNOME, calculadora e web
//
// Toda leitura de disco é assíncrona (o Shell não pode travar).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {loadRemoteSearchProviders} from 'resource:///org/gnome/shell/ui/remoteSearch.js';

import {listDir, readBytes, readInfo} from '../files.js';

const RECENT_APPS_MAX = 12;
const SCAN_DEPTH = 3;
const SCAN_LIMIT = 4000;
const SCAN_TTL_US = 120 * GLib.USEC_PER_SEC;
const SKIP_DIRS = new Set(['node_modules', 'snap', 'go', 'target', 'build', 'dist', '__pycache__']);

const normalize = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Quanto `name` combina com as palavras (0 = não combina). */
export function matchScore(name, words) {
    const hay = normalize(name);
    let score = 0;
    for (const word of words) {
        const at = hay.indexOf(word);
        if (at < 0)
            return 0;
        // Começo do nome vale mais; começo de palavra vale mais que o meio.
        score += at === 0 ? 3 : /[\s\-_.]/.test(hay[at - 1]) ? 2 : 1;
    }
    return score;
}

export const queryWords = text => normalize(text).split(/\s+/).filter(Boolean);

export class StartData {
    /**
     * @param {Gio.Settings} settings - as configurações da Orla
     * @param {object} appTracker - os apps fixados da dock (lib/appTracker.js)
     */
    constructor(settings, appTracker) {
        this._settings = settings;
        this._dockApps = appTracker;
        this._apps = Shell.AppSystem.get_default();
        this._index = null;
        this._indexTime = 0;
        this._indexing = null;
        this._providers = null;

        // Um app abriu: ele vai para o começo dos "recentes".
        this._apps.connectObject('app-state-changed', (_s, app) => {
            if (app.state === Shell.AppState.STARTING || app.state === Shell.AppState.RUNNING)
                this._rememberApp(app);
        }, this);
        // Apps instalados ou removidos: as listas guardadas são refeitas.
        this._apps.connectObject('installed-changed', () => {
            this._allApps = null;
        }, this);

        // O histórico de arquivos do GNOME mudou: a lista guardada vence.
        this.onFilesChanged = null;
        this._recent = null;
        this._recentFile = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
        try {
            this._recentMonitor = this._recentFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._recentMonitor.connect('changed', () => {
                this._recent = null;
                this.onFilesChanged?.();
            });
        } catch {
            this._recentMonitor = null;
        }
    }

    // ---------- Fixados ----------
    //
    // Os fixados do menu SÃO os favoritos do GNOME (os mesmos da dock e do
    // dash): fixar ou reordenar aqui muda lá também, e vice-versa.

    pinnedApps() {
        return this._dockApps.getPinned();
    }

    isPinned(app) {
        return this._dockApps.isPinned(app);
    }

    pin(app) {
        if (!this.isPinned(app))
            this._dockApps.pin(app.get_id());
    }

    unpin(app) {
        this._dockApps.unpin(app.get_id());
    }

    /** Move um fixado para a posição `index` (entre os fixados). */
    movePinned(app, index) {
        this._dockApps.pinAt(app.get_id(), index);
    }

    // ---------- Apps ----------

    _rememberApp(app) {
        const id = app.get_id();
        const list = [id, ...this._settings.get_strv('start-menu-recent-app-ids').filter(i => i !== id)];
        this._settings.set_strv('start-menu-recent-app-ids', list.slice(0, RECENT_APPS_MAX));
    }

    recentApps(limit) {
        return this._settings.get_strv('start-menu-recent-app-ids')
            .map(id => this._apps.lookup_app(id))
            .filter(Boolean)
            .slice(0, limit);
    }

    /**
     * Todos os apps que aparecem no menu, em ordem alfabética. should_show()
     * respeita NoDisplay, OnlyShowIn/NotShowIn e Hidden do .desktop. A
     * lista fica guardada até um app ser instalado ou removido.
     */
    allApps() {
        this._allApps ??= this._apps.get_installed()
            .filter(info => info.should_show())
            .map(info => this._apps.lookup_app(info.get_id()))
            .filter(Boolean)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        return this._allApps;
    }

    /** As categorias do .desktop de um app (ex.: ['Network', 'WebBrowser']). */
    categoriesOf(app) {
        return (app.get_app_info()?.get_categories?.() ?? '').split(';').filter(Boolean);
    }

    /**
     * Pastas do usuário para os atalhos do menu (as que existirem).
     * `name` vem do próprio GLib, já no idioma do sistema.
     */
    places() {
        const out = [];
        const add = (path, iconName) => {
            if (!path)
                return;
            const file = Gio.File.new_for_path(path);
            out.push({file, name: file.get_basename(), iconName});
        };
        add(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS), 'folder-documents-symbolic');
        add(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES), 'folder-pictures-symbolic');
        add(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC), 'folder-music-symbolic');
        add(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD), 'folder-download-symbolic');
        return out;
    }

    searchApps(words) {
        if (!words.length)
            return [];
        return this.allApps()
            .filter(app => !isSettingsPanel(app))
            .map(app => {
                const info = app.get_app_info();
                const extra = [info?.get_generic_name?.(), info?.get_keywords?.()?.join(' ')]
                    .filter(Boolean).join(' ');
                const score = matchScore(app.get_name(), words) * 2 || matchScore(extra, words);
                return {app, score};
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(r => r.app);
    }

    /** Painéis das Configurações do GNOME (Wi-Fi, Som, Monitores…). */
    searchSettings(words) {
        if (!words.length)
            return [];
        return this._apps.get_installed()
            .map(info => this._apps.lookup_app(info.get_id()))
            .filter(app => app && isSettingsPanel(app))
            .filter(app => matchScore(app.get_name(), words) ||
                matchScore(app.get_app_info()?.get_keywords?.()?.join(' ') ?? '', words))
            .slice(0, 6);
    }

    // ---------- Arquivos ----------

    /**
     * Arquivos abertos recentemente (o histórico do GNOME), mais novos
     * primeiro. A leitura fica guardada até o histórico mudar.
     */
    async recentFiles(limit) {
        if (this._recent && this._recent.limit >= limit)
            return this._recent.list.slice(0, limit);
        const list = await this._readRecentFiles(limit);
        this._recent = {limit, list};
        return list;
    }

    async _readRecentFiles(limit) {
        let text;
        try {
            const bytes = await readBytes(this._recentFile);
            text = new TextDecoder().decode(bytes);
        } catch {
            return [];
        }
        const entries = [];
        for (const match of text.matchAll(/<bookmark\b[^>]*>/g)) {
            const tag = match[0];
            const href = /href="([^"]+)"/.exec(tag)?.[1];
            const when = /(?:visited|modified)="([^"]+)"/.exec(tag)?.[1];
            if (!href?.startsWith('file://'))
                continue;
            const file = Gio.File.new_for_uri(href.replace(/&amp;/g, '&'));
            const time = when ? GLib.DateTime.new_from_iso8601(when, null)?.to_unix() ?? 0 : 0;
            entries.push({file, time});
        }
        entries.sort((a, b) => b.time - a.time);
        const out = [];
        const seen = new Set();
        for (const entry of entries) {
            if (out.length >= limit)
                break;
            const uri = entry.file.get_uri();
            if (seen.has(uri))
                continue;
            seen.add(uri);
            const described = await describe(entry.file, entry.time);
            if (described)
                out.push(described);
        }
        return out;
    }

    /** Busca por nome nos arquivos da pasta pessoal (índice em memória). */
    async searchFiles(words, limit = 8) {
        if (!words.length)
            return [];
        const index = await this._fileIndex();
        return index
            .map(entry => ({entry, score: matchScore(entry.name, words)}))
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score || b.entry.time - a.entry.time)
            .slice(0, limit)
            .map(r => r.entry);
    }

    /** Começa a montar o índice de arquivos (para a primeira busca ser rápida). */
    warmUp() {
        this._fileIndex().catch(() => {});
        // Os provedores conectam ao D-Bus de forma assíncrona: carregando
        // agora, eles já estão prontos na primeira busca.
        if (this._settings.get_boolean('start-menu-search-providers'))
            this._searchProviders();
    }

    async _fileIndex() {
        const now = GLib.get_monotonic_time();
        if (this._index && now - this._indexTime < SCAN_TTL_US)
            return this._index;
        this._indexing ??= (async () => {
            const out = [];
            await scan(Gio.File.new_for_path(GLib.get_home_dir()), 0, out);
            this._index = out;
            this._indexTime = GLib.get_monotonic_time();
            this._indexing = null;
            return out;
        })();
        return this._indexing;
    }

    // ---------- Provedores de busca do GNOME ----------

    _searchProviders() {
        if (!this._providers) {
            try {
                const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
                this._providers = loadRemoteSearchProviders(settings);
            } catch {
                this._providers = [];
            }
        }
        return this._providers;
    }

    /** Resultados dos outros apps (Calendário, Contatos, Caracteres…). */
    async searchProviders(words, cancellable) {
        if (!words.length || !this._settings.get_boolean('start-menu-search-providers'))
            return [];
        // Só os que já terminaram de conectar ao D-Bus.
        const ready = this._searchProviders().filter(provider => provider.proxy?.g_connection);
        const groups = await Promise.all(ready.map(async provider => {
            try {
                const ids = await provider.getInitialResultSet(words, cancellable);
                const metas = await provider.getResultMetas(provider.filterResults(ids, 3), cancellable);
                return {provider, metas};
            } catch {
                return null;
            }
        }));
        return groups.filter(group => group?.metas?.length);
    }

    // ---------- Web ----------

    webSearchUri(text) {
        const template = this._settings.get_string('start-menu-web-search-url') || 'https://duckduckgo.com/?q=%s';
        return template.replace('%s', encodeURIComponent(text));
    }

    webSearchName() {
        const host = /^https?:\/\/(?:www\.)?([^/]+)/.exec(this._settings.get_string('start-menu-web-search-url'))?.[1];
        return host ? host.split('.')[0].replace(/^./, c => c.toUpperCase()) : 'Web';
    }

    destroy() {
        this._recentMonitor?.cancel();
        this._recentMonitor = null;
        this.onFilesChanged = null;
        this._recent = null;
        this._apps.disconnectObject(this);
        this._allApps = null;
        this._index = null;
        this._providers = null;
    }
}

function isSettingsPanel(app) {
    const info = app.get_app_info();
    const categories = info?.get_categories?.() ?? '';
    return categories.includes('X-GNOME-Settings-Panel') || /^gnome-.*-panel\.desktop$/.test(app.get_id());
}

async function describe(file, time = 0) {
    try {
        const info = await readInfo(file,
            'standard::display-name,standard::icon,standard::content-type,time::modified');
        return {
            file,
            name: info.get_display_name(),
            gicon: info.get_icon(),
            type: info.get_content_type(),
            time: time || info.get_modification_date_time()?.to_unix() || 0,
        };
    } catch {
        return null;   // o arquivo não existe mais
    }
}

/** Lê a pasta pessoal até SCAN_DEPTH níveis, pulando pastas ocultas e pesadas. */
async function scan(dir, depth, out) {
    if (depth > SCAN_DEPTH || out.length >= SCAN_LIMIT)
        return;
    let infos;
    try {
        infos = await listDir(dir,
            'standard::name,standard::display-name,standard::type,standard::is-hidden,standard::icon,' +
            'standard::content-type,time::modified');
    } catch {
        return;
    }
    const subdirs = [];
    for (const info of infos) {
        if (info.get_is_hidden() || out.length >= SCAN_LIMIT)
            continue;
        const child = dir.get_child(info.get_name());
        const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
        out.push({
            file: child,
            name: info.get_display_name(),
            gicon: info.get_icon(),
            type: info.get_content_type(),
            isDir,
            time: info.get_modification_date_time()?.to_unix() ?? 0,
        });
        if (isDir && !SKIP_DIRS.has(info.get_name()))
            subdirs.push(child);
    }
    for (const sub of subdirs)
        await scan(sub, depth + 1, out);
}
