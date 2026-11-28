// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// stacks.js — "Stacks" do macOS: uma pasta na dock que, ao clicar, abre
// os arquivos em GRADE, LEQUE ou LISTA.
//
// Arquivos e pastas são acessados com o Gio (a biblioteca de E/S do GLib):
//   - Gio.File representa um caminho/URI (file:///…, trash:///…);
//   - enumerate_children_async lista o conteúdo SEM travar a interface
//     (operações de disco nunca devem rodar de forma síncrona no Shell);
//   - monitor_directory avisa quando algo muda na pasta.
//
// Os arquivos podem ser arrastados para um ícone de app (abre com ele),
// para a lixeira (vai para a lixeira) ou para a janela de um app (o
// arquivo é copiado e a janela vem para a frente: é só colar com Ctrl+V).
// Soltos num lugar vazio, voltam voando para o ícone da pilha.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SimpleMenu} from './appMenu.js';
import {DockItem} from './dockItem.js';
import {copyFiles, isFileManager} from './fileClipboard.js';
import {Position, Timeout, animationsEnabled, later} from './utils.js';

const ATTRIBUTES = [
    'standard::name', 'standard::display-name', 'standard::icon', 'standard::content-type',
    'standard::is-hidden', 'standard::type', 'time::modified', 'time::created',
    'thumbnail::path',
].join(',');

const MAX_ENTRIES = 200;     // quantos ficam guardados para mostrar
const MAX_SCAN = 5000;       // quantos lemos para achar os mais recentes
const FAN_MAX = 12;
// Tempos das animações (a saída usa os mesmos, invertidos).
const FAN_MS = 220;          // primeiro item do leque
const FAN_STAGGER_MS = 18;   // cada item acima demora isto a mais
const PANEL_MS = 180;        // grade e lista
const MORPH_MS = 200;        // ícone da dock ↔ quadrado com a seta (pilha aberta)
const DRAG_FADE_MS = 160;    // o leque some quando um arquivo começa a ser arrastado
const DROP_MS = 220;         // arquivo solto: "entra" na janela ou volta para a pilha
const TOAST_MS = 1800;       // quanto tempo o aviso "cole com Ctrl+V" fica na tela
const View = Object.freeze({AUTO: 0, GRID: 1, FAN: 2, LIST: 3});
const Sort = Object.freeze({DATE: 0, NAME: 1});

/**
 * Os "Locais" que podem aparecer na dock: cada um tem a
 * chave do GSettings que o liga, o ícone e a pasta especial do sistema
 * (GLib.UserDirectory respeita o idioma: ~/Downloads, ~/Documentos…).
 */
export const PLACES = [
    {key: 'show-home', icon: 'user-home', dir: null, fallback: ''},
    {key: 'show-downloads', icon: 'folder-download', dir: GLib.UserDirectory.DIRECTORY_DOWNLOAD, fallback: 'Downloads'},
    {key: 'show-documents', icon: 'folder-documents', dir: GLib.UserDirectory.DIRECTORY_DOCUMENTS, fallback: 'Documents'},
    {key: 'show-pictures', icon: 'folder-pictures', dir: GLib.UserDirectory.DIRECTORY_PICTURES, fallback: 'Pictures'},
    {key: 'show-videos', icon: 'folder-videos', dir: GLib.UserDirectory.DIRECTORY_VIDEOS, fallback: 'Videos'},
    {key: 'show-music', icon: 'folder-music', dir: GLib.UserDirectory.DIRECTORY_MUSIC, fallback: 'Music'},
];

/** URI de um local (a pasta pessoal quando `dir` é null). */
export function placeUri(place) {
    const home = GLib.get_home_dir();
    const path = place.dir === null
        ? home
        : GLib.get_user_special_dir(place.dir) ?? GLib.build_filenamev([home, place.fallback]);
    return Gio.File.new_for_path(path).get_uri();
}

export function placeForUri(uri) {
    return PLACES.find(place => placeUri(place) === uri) ?? null;
}

function openUri(uri) {
    const context = global.create_app_launch_context(0, -1);
    Gio.AppInfo.launch_default_for_uri_async(uri, context, null, (_o, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res);
        } catch (e) {
            Main.notifyError(_('Could not open'), e.message);
        }
    });
}

/** Ícone de um arquivo: a miniatura (se já existir) ou o ícone do tipo. */
function entryIcon(entry, size) {
    const gicon = entry.thumbnail
        ? Gio.FileIcon.new(Gio.File.new_for_path(entry.thumbnail))
        : entry.icon;
    return new St.Icon({gicon, icon_size: size, style_class: 'orla-stack-file-icon'});
}

export const StackItem = GObject.registerClass(
class OrlaStackItem extends DockItem {
    _init(dock, uri) {
        super._init(dock);
        this.uri = uri;
        this._closingPopups = new Set();
        this.folder = Gio.File.new_for_uri(uri);
        this.key = `stack:${uri}`;
        // Um dos "Locais" (Downloads, Documentos…) ou uma pasta qualquer.
        this._place = placeForUri(uri);
        this._name = this.folder.get_basename();
        this._entries = [];
        this._popup = null;
        // Animações e avisos de arquivos soltos (somem no disable()).
        this._dropEffects = new Set();
        // O "quadrado com a seta para baixo" que o macOS mostra no lugar do
        // ícone enquanto a pilha está aberta (criado na primeira abertura).
        this._openTile = null;
        this._cancellable = new Gio.Cancellable();
        this._reload = new Timeout();

        this._queryName();
        try {
            this._monitor = this.folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', () => this._reload.start(400, () => this._load()));
        } catch {
            this._monitor = null;
        }

        this.connect('clicked', () => this.togglePopup());
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.closePopup();
            this.dock.openMenu(this, this._createMenu());
            return Clutter.EVENT_STOP;
        });
        dock.settings.connectObject(
            'changed::stack-sort', () => this._load(),
            // Estilo do ícone do Downloads: troca na hora.
            'changed::downloads-icon-style', () => this.refreshIcon(),
            this);
        this._load();
    }

    /** É o Downloads com o estilo "pasta com seta de download"? */
    get _downloadsArrow() {
        return this._place?.key === 'show-downloads' &&
            this.dock.settings.get_string('downloads-icon-style') === 'arrow';
    }

    get labelText() {
        return this._name;
    }

    get popupOpen() {
        return this._popup !== null;
    }

    get entries() {
        return this._entries;
    }


    _queryName() {
        this.folder.query_info_async('standard::display-name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (file, res) => {
                try {
                    // A pasta pessoal se chama como o usuário; mostramos "Pasta pessoal".
                    this._name = this._place?.dir === null
                        ? _('Home')
                        : file.query_info_finish(res).get_display_name();
                } catch {}
            });
    }

    /** Lista a pasta de forma assíncrona e ordena. */
    _load() {
        this.folder.enumerate_children_async(ATTRIBUTES, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (folder, res) => {
                let enumerator;
                try {
                    enumerator = folder.enumerate_children_finish(res);
                } catch {
                    this._setEntries([]);
                    return;
                }
                const entries = [];
                const next = () => {
                    enumerator.next_files_async(50, GLib.PRIORITY_DEFAULT, this._cancellable, (en, r) => {
                        let infos;
                        try {
                            infos = en.next_files_finish(r);
                        } catch {
                            infos = [];
                        }
                        for (const info of infos) {
                            if (info.get_is_hidden())
                                continue;
                            const created = info.get_attribute_uint64('time::created');
                            const modified = info.get_attribute_uint64('time::modified');
                            entries.push({
                                file: folder.get_child(info.get_name()),
                                name: info.get_display_name(),
                                icon: info.get_icon(),
                                contentType: info.get_content_type(),
                                thumbnail: info.get_attribute_byte_string('thumbnail::path'),
                                time: Math.max(created, modified),
                            });
                        }
                        if (infos.length > 0 && entries.length < MAX_SCAN) {
                            next();
                        } else {
                            en.close_async(GLib.PRIORITY_DEFAULT, null, null);
                            this._setEntries(entries);
                        }
                    });
                };
                next();
            });
    }

    _setEntries(entries) {
        if (this._cancellable.is_cancelled())
            return;
        if (this.dock.settings.get_enum('stack-sort') === Sort.NAME)
            entries.sort((a, b) => a.name.localeCompare(b.name));
        else
            entries.sort((a, b) => b.time - a.time);
        // Lemos a pasta inteira (até MAX_SCAN) para os "mais recentes" serem
        // de verdade, mesmo em pastas grandes.
        this._entries = entries.slice(0, MAX_ENTRIES);
        this.refreshIcon();
    }

    /** O ícone na dock: uma "pilha" com os 3 arquivos mais recentes. */
    createIcon(size) {
        // Downloads, estilo novo: a nossa pasta com seta (SVG da extensão,
        // vetorial: nítido em qualquer tamanho, inclusive ampliado).
        if (this._downloadsArrow) {
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([this.dock.manager.extensionPath, 'icons', 'downloads-folder.svg']));
            return new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: size});
        }
        // Estilo "pasta com arquivos": os três mais recentes empilhados.
        const top = this._entries.slice(0, 3);
        if (top.length === 0) {
            return new St.Icon({
                icon_name: this._place?.icon ?? 'folder',
                icon_size: size,
            });
        }
        const stack = new Clutter.Actor({width: size, height: size});
        const iconSize = Math.round(size * 0.78);
        const angles = [-8, 6, 0];
        top.reverse().forEach((entry, i) => {
            const icon = entryIcon(entry, iconSize);
            icon.set_position(Math.round((size - iconSize) / 2), Math.round((size - iconSize) / 2 + (2 - i) * -2));
            icon.set_pivot_point(0.5, 0.9);
            icon.rotation_angle_z = angles[i + (3 - top.length)] ?? 0;
            stack.add_child(icon);
        });
        return stack;
    }

    /** Recria o ícone; com a pilha aberta, ele continua escondido. */
    refreshIcon() {
        super.refreshIcon();
        if (this._popup && this._icon) {
            this._icon.opacity = 0;
            if (this._openTile)
                this._iconBin.set_child_above_sibling(this._openTile, null);
        }
    }

    onBinSizeChanged(binSize) {
        if (this._openTile)
            this._layoutOpenTile(binSize);
    }

    /**
     * O quadrado translúcido com a seta, como no macOS. Fica DENTRO do
     * _iconBin, por cima do ícone: assim acompanha a ampliação, o quique e
     * o reflexo sem nenhum código a mais.
     */
    _ensureOpenTile() {
        if (this._openTile)
            return this._openTile;
        const tile = this._openTile = new St.Bin({
            style_class: 'orla-stack-open-tile',
            opacity: 0,
            child: new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'orla-stack-open-chevron'}),
        });
        // A cada quadro da transição o vidro dinâmico precisa redesenhar.
        tile.connect('notify::opacity', () => this.dock.queueGlassRedraw());
        this._iconBin.add_child(tile);
        this._layoutOpenTile(this._binSize ?? 48);
        return tile;
    }

    _layoutOpenTile(binSize) {
        const tile = this._openTile;
        const side = Math.round(binSize * 0.86);
        const offset = Math.round((binSize - side) / 2);
        tile.set_size(side, side);
        tile.set_position(offset, offset);
        tile.set_pivot_point(0.5, 0.5);
        tile.style = `border-radius: ${Math.round(side * 0.24)}px;`;
        tile.child.icon_size = Math.round(side * 0.56);
    }

    /**
     * Troca, com uma transição suave, o ícone pelo quadrado com a seta
     * (`open`) ou volta ao ícone normal. `duration` acompanha o leque/painel
     * para os dois chegarem juntos.
     */
    _setOpenLook(open, duration = MORPH_MS) {
        const tile = this._ensureOpenTile();
        tile.remove_style_class_name(this.dock.look.dark ? 'orla-light' : 'orla-dark');
        tile.add_style_class_name(this.dock.look.dark ? 'orla-dark' : 'orla-light');
        this._iconBin.set_child_above_sibling(tile, null);
        const icon = this._icon;
        icon?.set_pivot_point(0.5, 0.5);
        const shown = {opacity: 255, scale_x: 1, scale_y: 1};
        const hidden = {opacity: 0, scale_x: 0.82, scale_y: 0.82};
        const [iconTo, tileTo] = open ? [hidden, shown] : [shown, hidden];
        for (const actor of [icon, tile].filter(Boolean))
            actor.remove_all_transitions();
        if (!animationsEnabled()) {
            icon?.set(iconTo);
            tile.set(tileTo);
            return;
        }
        // Abrindo: desacelera no fim (EASE_OUT); fechando: o espelho (EASE_IN
        // no que sai, EASE_OUT no que volta) — sem "pulo" se trocar no meio.
        icon?.ease({...iconTo, duration, mode: open ? Clutter.AnimationMode.EASE_IN_QUAD : Clutter.AnimationMode.EASE_OUT_QUAD});
        tile.ease({...tileTo, duration, mode: open ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_IN_QUAD});
    }

    _createMenu() {
        const settings = this.dock.settings;
        const view = settings.get_enum('stack-view');
        const sort = settings.get_enum('stack-sort');
        // Escolhas exclusivas (uma entre várias): ornamento de rádio.
        const check = cond => cond ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT;
        const setView = v => () => settings.set_enum('stack-view', v);
        return new SimpleMenu(this, [
            {label: _('Open in Files'), callback: () => openUri(this.uri)},
            null,
            {label: _('Automatic'), callback: setView(View.AUTO), ornament: check(view === View.AUTO)},
            {label: _('Grid'), callback: setView(View.GRID), ornament: check(view === View.GRID)},
            {label: _('Fan'), callback: setView(View.FAN), ornament: check(view === View.FAN)},
            {label: _('List'), callback: setView(View.LIST), ornament: check(view === View.LIST)},
            null,
            {label: _('Sort by Date'), callback: () => settings.set_enum('stack-sort', Sort.DATE), ornament: check(sort === Sort.DATE)},
            {label: _('Sort by Name'), callback: () => settings.set_enum('stack-sort', Sort.NAME), ornament: check(sort === Sort.NAME)},
            null,
            {label: _('Remove from Dock'), callback: () => this._removeFromDock()},
        ]);
    }

    _removeFromDock() {
        const settings = this.dock.settings;
        if (this._place) {
            settings.set_boolean(this._place.key, false);
        } else {
            settings.set_strv('stack-folders',
                settings.get_strv('stack-folders').filter(u => u !== this.uri));
        }
    }

    // ---------- Popup ----------

    togglePopup() {
        if (this._popup)
            this.closePopup();
        else
            this.openPopup();
    }

    openPopup() {
        this.dock.hidePreviews();
        this.dock.resetZoom();
        const popup = this._popup = new StackPopup(this);
        popup.connect('closed', () => {
            this._popup = null;
            // Volta ao ícone no mesmo ritmo em que o leque/painel se recolhe.
            this._setOpenLook(false, popup.exitDuration);
            // Fica na lista enquanto faz a animação de saída.
            this._closingPopups.add(popup);
            this.dock.onPopupClosed();
        });
        popup.connect('destroy', () => this._closingPopups.delete(popup));
        this._popup.open();
        this._setOpenLook(true);
        this.dock.onPopupClosed();  // reavalia o auto-ocultar (agora "ocupada")
    }

    closePopup() {
        this._popup?.close();
    }

    // ---------- Arquivo do leque solto fora da dock ----------

    _trackEffect(actor) {
        this._dropEffects.add(actor);
        actor.connect('destroy', () => this._dropEffects.delete(actor));
        Main.uiGroup.add_child(actor);
    }

    /**
     * Uma cópia do ícone arrastado, no mesmo lugar. O dnd.js anima o ator
     * dele de volta para o leque se ninguém aceitar o arquivo; destruindo o
     * ator, essa animação não acontece e quem anima somos nós, com a cópia.
     */
    _ghostOf(dropActor) {
        const [x, y] = dropActor.get_transformed_position();
        const [width, height] = dropActor.get_transformed_size();
        const ghost = new St.Icon({
            gicon: dropActor.gicon,
            icon_size: dropActor.icon_size,
            style_class: dropActor.style_class,
            x, y, width, height,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._trackEffect(ghost);
        dropActor.destroy();
        return ghost;
    }

    /** Solto sobre uma janela: copia o arquivo e traz a janela para a frente. */
    dropFileOnWindow(file, win, dropActor) {
        copyFiles([file], {fileManager: isFileManager(win)});
        Main.activateWindow(win);
        const ghost = this._ghostOf(dropActor);
        const [x, y] = [ghost.x + ghost.width / 2, ghost.y];
        ghost.ease({
            scale_x: 0.4, scale_y: 0.4, opacity: 0,
            duration: animationsEnabled() ? DROP_MS : 0,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => ghost.destroy(),
        });
        this._showToast(x, y, _('File copied — paste it with Ctrl+V'));
    }

    /**
     * Solto num lugar vazio: o arquivo volta voando para o ícone da pilha,
     * como no macOS. Devolve false se não der (aí o dnd.js faz o normal).
     */
    flyFileBack(dropActor) {
        const rect = this.dock.getItemIconRect(this);
        if (!rect || !animationsEnabled())
            return false;
        const ghost = this._ghostOf(dropActor);
        const scale = rect.width / Math.max(1, ghost.width);
        // Pivô no centro: o centro da cópia vai até o centro do ícone.
        ghost.ease({
            x: rect.x + rect.width / 2 - ghost.width / 2,
            y: rect.y + rect.height / 2 - ghost.height / 2,
            scale_x: scale, scale_y: scale,
            duration: DROP_MS + 60,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            onStopped: () => ghost.destroy(),
        });
        // Some só no finzinho, quando já está chegando no ícone.
        ghost.ease_property('opacity', 0, {
            delay: DROP_MS - 40,
            duration: 100,
            mode: Clutter.AnimationMode.LINEAR,
        });
        return true;
    }

    /** Aviso pequeno perto de onde o arquivo foi solto. */
    _showToast(x, y, text) {
        const toast = new St.BoxLayout({
            style_class: `orla-tooltip orla-drop-toast${this.dock.look.dark ? '' : ' orla-light'}`,
            opacity: 0,
        });
        toast.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'orla-drop-toast-icon'}));
        toast.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
        this._trackEffect(toast);
        // Acima do ponto, sem sair do monitor.
        const [, , width, height] = toast.get_preferred_size();
        const point = new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1});
        const monitor = Main.layoutManager.monitors[global.display.get_monitor_index_for_rect(point)] ??
            Main.layoutManager.primaryMonitor;
        const left = Math.min(Math.max(x - width / 2, monitor.x + 8), monitor.x + monitor.width - width - 8);
        const top = Math.max(y - height - 12, monitor.y + 8);
        toast.set_position(Math.round(left), Math.round(top));
        // Aparece, espera e some. As animações ficam presas ao ator: se ele
        // for destruído antes (disable()), nada fica pendente.
        toast.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => toast.ease({
                opacity: 0,
                delay: TOAST_MS,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => toast.destroy(),
            }),
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._reload.cancel();
        this._monitor?.cancel();
        this.dock.settings.disconnectObject(this);
        this._popup?.close(false);
        for (const popup of [...this._closingPopups])
            popup.close(false);
        for (const actor of [...this._dropEffects])
            actor.destroy();
        super.destroy();
    }
});

// ---------- Menu de contexto de um arquivo (botão direito) ----------

const FILE_MANAGER = 'org.freedesktop.FileManager1';

/** Pede ao Arquivos (pelo D-Bus) para mostrar o arquivo ou as propriedades. */
function fileManagerCall(method, uri) {
    Gio.DBus.session.call(FILE_MANAGER, '/org/freedesktop/FileManager1', FILE_MANAGER, method,
        new GLib.Variant('(ass)', [[uri], '']),
        null, Gio.DBusCallFlags.NONE, -1, null, null);
}

/**
 * Apps que abrem este tipo de arquivo (os recomendados primeiro). O tipo
 * já veio na leitura da pasta; sem ele, é deduzido pelo nome (sem ler o
 * disco).
 */
function appsForFile(entry) {
    const type = entry.contentType || Gio.content_type_guess(entry.name ?? entry.file.get_basename(), null)[0];
    if (!type)
        return [];
    const seen = new Set();
    return [...Gio.AppInfo.get_recommended_for_type(type), ...Gio.AppInfo.get_all_for_type(type)]
        .filter(app => app.should_show() && !seen.has(app.get_id()) && seen.add(app.get_id()));
}

/**
 * Menu de contexto de um arquivo da stack (leque, grade ou lista). Fica
 * na frente do leque, com o visual padrão do GNOME; enquanto está aberto,
 * é ele quem recebe os cliques, então o leque não fecha. As ações rodam
 * depois que o menu termina de fechar (ver `later`).
 */
class StackFileMenu extends PopupMenu.PopupMenu {
    constructor(button, popup) {
        super(button, 0.5, St.Side.LEFT);
        this.actor.add_style_class_name('orla-menu');
        const file = button.file;
        const uri = file.get_uri();
        // `close`: a ação abre outra coisa, então o leque sai junto.
        const add = (label, fn, close = true) => this.addAction(label, () => later(() => {
            fn();
            if (close)
                popup.close();
        }));

        add(_('Open'), () => openUri(uri));
        const apps = appsForFile(button._entry ?? {file});
        if (apps.length) {
            const openWith = new PopupMenu.PopupSubMenuMenuItem(_('Open With'));
            for (const app of apps) {
                openWith.menu.addAction(app.get_name(), () => later(() => {
                    try {
                        app.launch([file], global.create_app_launch_context(0, -1));
                    } catch (e) {
                        logError(e, 'Orla Dock: não foi possível abrir o arquivo');
                    }
                    popup.close();
                }), app.get_icon());
            }
            this.addMenuItem(openWith);
        }
        add(_('Show in Folder'), () => fileManagerCall('ShowItems', uri));
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        add(_('Copy'), () => copyFiles([file]), false);
        add(_('Move to Trash'), () => file.trash_async(GLib.PRIORITY_DEFAULT, null, null));
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        add(_('Properties'), () => fileManagerCall('ShowItemProperties', uri));
    }
}

/**
 * A janela embaixo de um ator da tela (o que estava sob o cursor ao
 * soltar), ou null se não for uma janela (painel, dock, fundo de tela).
 */
function windowAt(actor) {
    for (let a = actor; a; a = a.get_parent()) {
        if (a instanceof Meta.WindowActor) {
            const win = a.meta_window;
            return win && !win.minimized && win.get_window_type() !== Meta.WindowType.DESKTOP
                ? win : null;
        }
    }
    return null;
}

/** Um arquivo dentro do popup: clicável e arrastável. */
const StackFileButton = GObject.registerClass(
class OrlaStackFileButton extends St.Button {
    _init(popup, entry, {iconSize, layout}) {
        super._init({style_class: `orla-stack-file orla-stack-${layout}`, can_focus: true});
        this._delegate = this;
        this.file = entry.file;
        this._entry = entry;
        this._iconSize = iconSize;

        const vertical = layout === 'grid';
        const box = new St.BoxLayout({
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            style_class: 'orla-stack-file-box',
        });
        const label = new St.Label({
            text: entry.name,
            style_class: 'orla-stack-file-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: vertical ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        const icon = entryIcon(entry, iconSize);
        if (vertical) {
            icon.x_align = Clutter.ActorAlign.CENTER;
        } else if (layout === 'list') {
            // Na lista, a linha ocupa toda a largura e o conteúdo fica à esquerda.
            this.x_expand = true;
            box.x_align = Clutter.ActorAlign.START;
            box.x_expand = true;
        }

        if (layout === 'fan') {
            // No leque, o nome fica à esquerda do ícone, numa "pílula".
            label.add_style_class_name('orla-fan-label');
            label.x_expand = true;
            label.x_align = Clutter.ActorAlign.END;
            box.add_child(label);
            box.add_child(icon);
        } else {
            box.add_child(icon);
            box.add_child(label);
        }
        this.set_child(box);

        this.connect('clicked', () => {
            openUri(this.file.get_uri());
            popup.close();
        });
        // Botão direito: o St.Button só "clica" com o esquerdo, então o
        // direito era ignorado. Abrimos o menu do arquivo e PARAMOS o evento
        // aqui (senão ele subiria até o leque).
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            popup.openFileMenu(this);
            return Clutter.EVENT_STOP;
        });

        // O arraste só começa depois de o mouse andar alguns pixels (o
        // limiar do GNOME), então um clique simples continua abrindo.
        const draggable = DND.makeDraggable(this);
        draggable.connect('drag-begin', () => popup.onFileDragBegin());
        draggable.connect('drag-cancelled', () => popup.onFileDragCancelled(this));
        draggable.connect('drag-end', () => popup.onFileDragEnd());
    }

    getDragActor() {
        return entryIcon(this._entry, this._iconSize);
    }

    getDragActorSource() {
        return this;
    }
});

/**
 * O popup de uma stack. Usa Main.pushModal para fechar ao clicar fora ou
 * apertar Esc.
 */
const StackPopup = GObject.registerClass({
    Signals: {'closed': {}},
}, class OrlaStackPopup extends St.Widget {
    _init(item) {
        super._init({reactive: true, style_class: 'orla-stack-popup-root'});
        this._item = item;
        this._dock = item.dock;
        this._grab = null;
        this._closed = false;
        this._dropMonitor = null;
        this.connect('destroy', () => this._removeDropMonitor());
        // Como cada item entrou, para sair fazendo o caminho inverso.
        this._fanItems = [];

        const settings = this._dock.settings;
        let view = settings.get_enum('stack-view');
        const count = item.entries.length;
        const bottom = this._dock.axis.position === Position.BOTTOM;
        if (view === View.AUTO)
            view = bottom && count > 0 && count <= FAN_MAX ? View.FAN : View.GRID;
        if (view === View.FAN && !bottom)
            view = View.GRID;   // o leque só faz sentido saindo da dock inferior
        this._view = view;
    }

    open() {
        const dark = this._dock.look.dark;
        this.add_style_class_name(dark ? 'orla-dark' : 'orla-light');
        Main.layoutManager.addTopChrome(this);
        if (this._view === View.FAN)
            this._buildFan();
        else
            this._buildPanel(this._view === View.LIST ? 'list' : 'grid');

        this._grab = Main.pushModal(this);
        this.connect('button-press-event', (_a, event) => {
            if (!this._isInsideContent(event)) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /**
     * O clique caiu num arquivo (ou no painel, na grade e na lista)?
     *
     * No LEQUE só valem os arquivos: o contêiner deles não tem tamanho
     * próprio e vai do canto da tela até o arquivo mais distante — contar
     * com ele fazia quase todo clique em volta do leque parecer "dentro", e
     * ele não fechava.
     */
    _isInsideContent(event) {
        const [x, y] = event.get_coords();
        const targets = this._view === View.FAN ? this._content.get_children() : [this._content];
        return targets.some(child => {
            const ext = child.get_transformed_extents();
            return x >= ext.origin.x && x <= ext.origin.x + ext.size.width &&
                y >= ext.origin.y && y <= ext.origin.y + ext.size.height;
        });
    }

    /** Menu de contexto de um arquivo, por cima do leque. */
    openFileMenu(button) {
        if (this._closed)
            return;
        this._dock.openMenu(button, new StackFileMenu(button, this));
    }

    _footerButton() {
        const button = new St.Button({
            style_class: 'orla-stack-open',
            label: _('Open in Files'),
            can_focus: true,
        });
        button.connect('clicked', () => {
            openUri(this._item.uri);
            this.close();
        });
        return button;
    }

    /** Quanto dura a animação de saída (o ícone da dock volta junto). */
    get exitDuration() {
        if (this._view !== View.FAN)
            return PANEL_MS;
        return Math.max(MORPH_MS, ...this._fanItems.map(({duration}) => duration));
    }

    /**
     * O topo do leque, como no macOS: "Abrir em Downloads" (o nome da
     * pasta) e um botão redondo com a seta. Abre a pasta no Arquivos.
     */
    _fanMoreButton() {
        // Translators: %s is a folder name, e.g. "Open in Downloads".
        const text = _('Open in %s').format(this._item.labelText);
        const label = new St.Label({
            text, style_class: 'orla-stack-file-label orla-fan-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        const round = new St.Bin({
            style_class: 'orla-fan-more-icon',
            child: new St.Icon({icon_name: 'mail-forward-symbolic', fallback_icon_name: 'go-next-symbolic'}),
        });
        const box = new St.BoxLayout({style_class: 'orla-stack-file-box'});
        box.add_child(label);
        box.add_child(round);
        const button = new St.Button({
            style_class: 'orla-stack-file orla-stack-fan orla-fan-more',
            child: box,
            can_focus: true,
        });
        button.connect('clicked', () => {
            openUri(this._item.uri);
            this.close();
        });
        return button;
    }

    /** Grade ou lista: um painel com título, rolagem e rodapé. */
    _buildPanel(layout) {
        const entries = this._item.entries;
        const panel = new St.BoxLayout({
            style_class: `orla-stack-panel orla-stack-panel-${layout}`,
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            style: this._dock.look.popupCss,
        });
        panel.add_child(new St.Label({text: this._item.labelText, style_class: 'orla-stack-title'}));

        const scroll = new St.ScrollView({
            style_class: 'orla-stack-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        let body;
        if (layout === 'grid') {
            const columns = Math.max(3, Math.min(6, Math.ceil(Math.sqrt(entries.length))));
            const grid = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
            // Dentro de um St.ScrollView o filho precisa ser "rolável"
            // (St.Scrollable): St.Viewport é o contêiner genérico que é.
            body = new St.Viewport({layout_manager: grid, style_class: 'orla-stack-grid'});
            entries.forEach((entry, i) => {
                grid.attach(new StackFileButton(this, entry, {iconSize: 56, layout}),
                    i % columns, Math.floor(i / columns), 1, 1);
            });
        } else {
            body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-stack-list'});
            for (const entry of entries)
                body.add_child(new StackFileButton(this, entry, {iconSize: 24, layout}));
        }
        if (entries.length === 0) {
            body = new St.BoxLayout();
            body.add_child(new St.Label({text: _('This folder is empty'), style_class: 'orla-stack-empty'}));
        }
        scroll.set_child(body);
        panel.add_child(scroll);
        panel.add_child(this._footerButton());

        // Limita a altura a 60% do monitor.
        const monitor = this._dock.monitor;
        scroll.style = `max-height: ${Math.round(monitor.height * 0.6)}px;`;

        this._content = panel;
        this.add_child(panel);
        this._dock.placeOutside(panel, this._item, 12);

        panel.set_pivot_point(0.5, this._dock.axis.edgeAtEnd ? 1 : 0);
        if (animationsEnabled()) {
            panel.opacity = 0;
            panel.set_scale(0.92, 0.92);
            panel.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: PANEL_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    /** Leque: os arquivos sobem num arco a partir do ícone. */
    _buildFan() {
        const ext = this._item._iconBin.get_transformed_extents();
        const originX = ext.origin.x + ext.size.width / 2;
        const originY = ext.origin.y;
        const step = 58;
        // Quantos itens cabem entre a dock e o topo do monitor (+1 do rodapé).
        const room = originY - this._dock.monitor.y - this._dock.topInset - step;
        const fits = Math.max(1, Math.floor(room / step) - 1);
        const entries = this._item.entries.slice(0, Math.min(FAN_MAX, fits));

        const container = new Clutter.Actor({reactive: false});
        this._content = container;
        this.add_child(container);

        const buttons = entries.map(e => new StackFileButton(this, e, {iconSize: 48, layout: 'fan'}));
        buttons.push(this._fanMoreButton());

        buttons.forEach((button, i) => {
            container.add_child(button);
            const [, , w, h] = button.get_preferred_size();
            // O arco: quanto mais alto, mais desloca para a direita e gira.
            const n = i + 1;
            const x = originX - w + 28 + n * n * 0.55;
            const y = originY - n * step - h / 2 + 10;
            button.set_pivot_point(1, 0.5);
            const angle = -n * 0.9;
            const startX = originX - w + 28;
            const startY = originY - h / 2;
            const duration = FAN_MS + i * FAN_STAGGER_MS;
            this._fanItems.push({button, startX, startY, duration});
            if (animationsEnabled()) {
                button.set_position(startX, startY);
                button.opacity = 0;
                button.rotation_angle_z = 0;
                button.ease({
                    x, y, opacity: 255, rotation_angle_z: angle,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                button.set_position(x, y);
                button.rotation_angle_z = angle;
            }
        });
    }

    // ---------- Arrastar um arquivo para fora ----------

    onFileDragBegin() {
        // Larga o "modal" na hora (o arraste precisa do mouse livre) e o
        // leque some suavemente, sem ser destruído: o arquivo arrastado
        // ainda pertence a ele até o fim do arraste.
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.reactive = false;
        // Mesmo transparente, o leque cobre a tela; sem isto ele seria o
        // "alvo" de qualquer soltura (o dnd.js procura o ator embaixo do
        // cursor) e a janela que está por baixo nunca seria encontrada.
        Shell.util_set_hidden_from_pick(this, true);
        if (animationsEnabled())
            this.ease({opacity: 0, duration: DRAG_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this.opacity = 0;

        // Anota onde o arquivo foi solto (o dnd.js só conta isso aos
        // "monitores" de arraste).
        this._fileDrop = null;
        this._removeDropMonitor();
        this._dropMonitor = {
            dragDrop: event => {
                this._fileDrop = event;
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dropMonitor);
    }

    /**
     * Ninguém aceitou o arquivo (nem um ícone de app nem a lixeira). Se ele
     * caiu numa janela, copiamos para colar lá; senão, volta para a pilha.
     */
    onFileDragCancelled(button) {
        const drop = this._fileDrop;
        if (!drop?.dropActor)
            return;     // cancelado com Esc: o dnd.js devolve ao leque
        const win = windowAt(drop.targetActor);
        if (win)
            this._item.dropFileOnWindow(button.file, win, drop.dropActor);
        else
            this._item.flyFileBack(drop.dropActor);
    }

    onFileDragEnd() {
        this._removeDropMonitor();
        this.close(false);
    }

    _removeDropMonitor() {
        if (!this._dropMonitor)
            return;
        DND.removeDragMonitor(this._dropMonitor);
        this._dropMonitor = null;
    }

    close(animate = true) {
        if (this._closed) {
            // Já estava saindo e pediram para fechar sem animação (ex.: a
            // extensão foi desligada): termina agora.
            if (!animate && this._closeTimeline) {
                this._closeTimeline.stop();
                this._closeTimeline = null;
                this.destroy();
            }
            return;
        }
        this._closed = true;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        // Enquanto a animação de saída roda, os cliques passam direto.
        this.reactive = false;
        this.emit('closed');
        if (!animate || !animationsEnabled() || this.opacity === 0) {
            this.destroy();
            return;
        }
        if (this._view === View.FAN)
            this._closeFan();
        else
            this._closePanel();
    }

    /**
     * A abertura do leque "de trás para frente": cada item espera
     * (maior duração − a sua), volta pelo mesmo caminho com a mesma duração
     * e acelera no começo (EASE_IN é o espelho do EASE_OUT da abertura).
     * Assim os de cima saem primeiro e todos chegam ao ícone juntos.
     */
    _closeFan() {
        const items = this._fanItems.filter(({button}) => button.get_stage());
        if (items.length === 0) {
            this.destroy();
            return;
        }
        const longest = Math.max(...items.map(({duration}) => duration));
        for (const {button, startX, startY, duration} of items) {
            button.reactive = false;
            // Se ainda estava abrindo, continua de onde está (sem pulo).
            button.remove_all_transitions();
            button.ease({
                x: startX, y: startY, opacity: 0, rotation_angle_z: 0,
                delay: longest - duration,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
        }
        this._destroyAfter(longest);
    }

    /** Grade e lista: o painel encolhe e some, o inverso de quando abriu. */
    _closePanel() {
        const panel = this._content;
        panel.remove_all_transitions();
        panel.ease({
            opacity: 0, scale_x: 0.92, scale_y: 0.92,
            duration: PANEL_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        this._destroyAfter(PANEL_MS);
    }

    /** Destroi o popup quando a animação de saída termina. */
    _destroyAfter(ms) {
        // Um Timeline preso ao popup: se ele for destruído antes (ex.: a
        // extensão foi desligada), o Timeline vai junto e nada fica pendente.
        const slowDown = St.Settings.get().slow_down_factor;
        const timeline = new Clutter.Timeline({actor: this, duration: Math.max(1, ms * slowDown)});
        timeline.connect('completed', () => {
            this._closeTimeline = null;
            this.destroy();
        });
        timeline.start();
        this._closeTimeline = timeline;
    }
});
