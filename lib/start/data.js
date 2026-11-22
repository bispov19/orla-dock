// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/data.js — de onde o Menu Iniciar tira o que mostra.
//
//   Fixados    start-menu-pinned (ids de apps e "folder:<id>"); vazio =
//              os apps fixados na dock
//   Pastas     start-menu-folders, um JSON: [{id, name, apps: [ids]}]
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

export const FOLDER_PREFIX = 'folder:';
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
    }

    // ---------- Fixados e pastas ----------

    get folders() {
        try {
            const list = JSON.parse(this._settings.get_string('start-menu-folders'));
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    _saveFolders(folders) {
        this._settings.set_string('start-menu-folders', JSON.stringify(folders));
    }

    get pinnedKeys() {
        const own = this._settings.get_strv('start-menu-pinned');
        return own.length ? own : this._dockApps.getPinned().map(app => app.get_id());
    }

    set pinnedKeys(keys) {
        this._settings.set_strv('start-menu-pinned', [...new Set(keys)]);
    }

    /** Os fixados prontos para mostrar: {key, app} ou {key, folder, apps}. */
    pinnedItems() {
        const folders = new Map(this.folders.map(f => [`${FOLDER_PREFIX}${f.id}`, f]));
        return this.pinnedKeys.map(key => {
            const folder = folders.get(key);
            if (folder)
                return {key, folder, apps: folder.apps.map(id => this._apps.lookup_app(id)).filter(Boolean)};
            const app = this._apps.lookup_app(key);
            return app ? {key, app} : null;
        }).filter(Boolean);
    }

    isPinned(app) {
        const id = app.get_id();
        return this.pinnedKeys.includes(id) || this.folders.some(f => f.apps.includes(id));
    }

    pin(app) {
        if (!this.isPinned(app))
            this.pinnedKeys = [...this.pinnedKeys, app.get_id()];
    }

    unpin(key) {
        this.pinnedKeys = this.pinnedKeys.filter(k => k !== key);
        if (key.startsWith(FOLDER_PREFIX))
            this._saveFolders(this.folders.filter(f => `${FOLDER_PREFIX}${f.id}` !== key));
    }

    /** Move um fixado para a posição `index`. */
    movePinned(key, index) {
        const keys = this.pinnedKeys.filter(k => k !== key);
        keys.splice(Math.max(0, Math.min(index, keys.length)), 0, key);
        this.pinnedKeys = keys;
    }

    /** Soltar um app em cima de outro: os dois viram uma pasta. */
    makeFolder(targetKey, sourceKey, name) {
        const id = `${GLib.get_real_time()}`;
        this._saveFolders([...this.folders, {id, name, apps: [targetKey, sourceKey]}]);
        this.pinnedKeys = this.pinnedKeys
            .filter(k => k !== sourceKey)
            .map(k => (k === targetKey ? `${FOLDER_PREFIX}${id}` : k));
    }

    addToFolder(folderKey, appKey) {
        const folders = this.folders;
        const folder = folders.find(f => `${FOLDER_PREFIX}${f.id}` === folderKey);
        if (!folder || folder.apps.includes(appKey))
            return;
        folder.apps.push(appKey);
        this._saveFolders(folders);
        this.pinnedKeys = this.pinnedKeys.filter(k => k !== appKey);
    }

    /** Tira o app da pasta; ele volta para os fixados logo depois dela. */
    removeFromFolder(folderId, appId) {
        const folders = this.folders;
        const folder = folders.find(f => f.id === folderId);
        if (!folder)
            return;
        folder.apps = folder.apps.filter(id => id !== appId);
        const key = `${FOLDER_PREFIX}${folderId}`;
        let keys = this.pinnedKeys;
        const at = keys.indexOf(key);
        if (folder.apps.length <= 1) {
            // Pasta com um app só deixa de ser pasta.
            keys.splice(at, 1, ...folder.apps, appId);
            this._saveFolders(folders.filter(f => f !== folder));
        } else {
            keys.splice(at + 1, 0, appId);
            this._saveFolders(folders);
        }
        keys = keys.filter((k, i) => keys.indexOf(k) === i);
        this.pinnedKeys = keys;
    }

    renameFolder(folderId, name) {
        const clean = name.trim();
        const folders = this.folders;
        const folder = folders.find(f => f.id === folderId);
        if (folder && clean && clean !== folder.name) {
            folder.name = clean;
            this._saveFolders(folders);
        }
    }

    // ---------- Dock ----------

    isOnDock(app) {
        return this._dockApps.isPinned(app);
    }

    toggleDock(app) {
        if (this._dockApps.isPinned(app))
            this._dockApps.unpin(app.get_id());
        else
            this._dockApps.pin(app.get_id());
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

    /** Todos os apps que aparecem no menu, em ordem alfabética. */
    allApps() {
        return this._apps.get_installed()
            .filter(info => info.should_show())
            .map(info => this._apps.lookup_app(info.get_id()))
            .filter(Boolean)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
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

    /** Arquivos abertos recentemente (o histórico do GNOME), mais novos primeiro. */
    async recentFiles(limit) {
        const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
        let text;
        try {
            const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
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
        this._apps.disconnectObject(this);
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
        const info = await file.query_info_async(
            'standard::display-name,standard::icon,standard::content-type,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
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
    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async(
            'standard::name,standard::display-name,standard::type,standard::is-hidden,standard::icon,' +
            'standard::content-type,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
    } catch {
        return;
    }
    const subdirs = [];
    for (;;) {
        const infos = await enumerator.next_files_async(64, GLib.PRIORITY_LOW, null);
        if (!infos.length)
            break;
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
    }
    enumerator.close_async(GLib.PRIORITY_LOW, null, null);
    for (const sub of subdirs)
        await scan(sub, depth + 1, out);
}
