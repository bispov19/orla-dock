// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/startMenu.js — o Menu Iniciar das barras de tarefas.
//
//   ┌──────────────────────────────┐
//   │ 🔍 Pesquisar…                 │  busca (digitar em qualquer lugar cai aqui)
//   │ Fixados · Recentes · Arquivos │  telas: Início / Todos os apps / Busca
//   │ 👤 Nome              ⚙  ⏻    │  rodapé: usuário, Configurações, energia
//   └──────────────────────────────┘
//
// Abre acima do botão Iniciar (ou ao lado, na barra lateral). Enquanto
// está aberto, o menu fica com o teclado e o mouse ("modal"): clicar fora
// ou apertar Esc fecha. Menus de contexto e pastas abrem por cima dele,
// numa camada própria.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RoundedBlurEffect} from '../blur.js';
import {glassParams} from '../glassMath.js';
import {Timeout} from '../utils.js';
import {AllAppsView} from './allApps.js';
import {StartData} from './data.js';
import {HomeView} from './home.js';
import {SearchView} from './search.js';
import {AppCell, iconButton} from './widgets.js';

const GAP = 8;
const MARGIN = 8;
const OPEN_MS = 170;
const RADIUS = 16;

// Terminais conhecidos e como pedir "rode este comando".
const TERMINALS = [
    ['ptyxis', ['--', 'sh', '-c']],
    ['kgx', ['--', 'sh', '-c']],
    ['gnome-terminal', ['--', 'sh', '-c']],
    ['konsole', ['-e', 'sh', '-c']],
    ['xterm', ['-e', 'sh', '-c']],
];

export class StartMenu {
    /** @param {object} dock - a dock da Orla (lib/dock.js) */
    constructor(dock) {
        this._dock = dock;
        this.settings = dock.settings;
        this.data = new StartData(dock.settings, dock.manager.appTracker);
        this.data.warmUp();
        this._isOpen = false;
        this._grab = null;
        this._timeouts = new Set();
        this._refresh = new Timeout();

        // A camada que cobre a tela: pega o clique fora e o teclado.
        this._overlay = new St.Widget({reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        Main.layoutManager.addTopChrome(this._overlay);
        this._overlay.connect('button-press-event', (_a, event) => this._onOutsidePress(event));
        this._overlay.connect('key-press-event', (_a, event) => this._onKey(event));

        this._box = new St.BoxLayout({
            style_class: 'orla-start',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._overlay.add_child(this._box);
        this._buildSearch();
        // Uma caixa vertical (e não um St.Bin): a tela começa no topo.
        this._body = new St.BoxLayout({style_class: 'orla-start-body', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: true});
        this._box.add_child(this._body);
        this._box.add_child(this._buildFooter());

        this._layer = new St.Widget({reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        this._overlay.add_child(this._layer);
        this._layer.connect('button-press-event', () => {
            this._hideLayer();
            return Clutter.EVENT_STOP;
        });

        this._home = new HomeView(this);
        this._allApps = new AllAppsView(this);
        this._search = new SearchView(this);
        this._view = null;

        const refresh = () => this._refresh.start(50, () => {
            if (this._isOpen && this._view === this._home)
                this._home.refresh();
            if (this._isOpen && this._openFolderId)
                this.showFolder(this._openFolderId);
        });
        this.settings.connectObject(
            'changed::start-menu-pinned', refresh,
            'changed::start-menu-folders', refresh,
            this);
        Main.overview.connectObject('showing', () => this.close(), this);
        Main.sessionMode.connectObject('updated', () => this.close(), this);
    }

    get isOpen() {
        return this._isOpen;
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    // ---------- Montagem ----------

    _buildSearch() {
        this._entry = new St.Entry({
            style_class: 'orla-start-search',
            hint_text: _('Type an app, file, setting or a calculation'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'orla-start-search-icon'}),
        });
        this._entry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._entry.clutter_text.connect('key-press-event', (_t, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                const ctrl = Boolean(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
                if (this._view === this._search)
                    this._search.activateFirst(ctrl);
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Down || key === Clutter.KEY_Tab) {
                this._view?.focusFirst();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._box.add_child(this._entry);
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'orla-start-footer'});
        const user = new St.Button({style_class: 'orla-start-user', can_focus: true, x_expand: false});
        const userBox = new St.BoxLayout({style_class: 'orla-start-user-box'});
        userBox.add_child(this._avatar());
        userBox.add_child(new St.Label({text: GLib.get_real_name() || GLib.get_user_name(),
            y_align: Clutter.ActorAlign.CENTER}));
        user.set_child(userBox);
        user.connect('clicked', () => this._launchId('gnome-users-panel.desktop'));
        footer.add_child(user);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(iconButton('emblem-system-symbolic', _('Settings'),
            () => this._launchId('org.gnome.Settings.desktop')));
        const power = iconButton('system-shutdown-symbolic', _('Power Off / Log Out'), () => {
            const [x, y] = power.get_transformed_position();
            this.showContextMenu(this._powerItems(), x + power.width / 2, y);
        });
        footer.add_child(power);
        return footer;
    }

    _avatar() {
        const path = GLib.build_filenamev(['/var/lib/AccountsService/icons', GLib.get_user_name()]);
        const gicon = GLib.file_test(path, GLib.FileTest.EXISTS)
            ? Gio.FileIcon.new(Gio.File.new_for_path(path))
            : Gio.ThemedIcon.new('avatar-default-symbolic');
        return new St.Icon({gicon, icon_size: 28, style_class: 'orla-start-avatar'});
    }

    _powerItems() {
        const actions = SystemActions.getDefault();
        const items = [];
        const add = (when, label, run) => {
            if (when)
                items.push({label, activate: () => this._afterClose(run)});
        };
        add(actions.canLockScreen, _('Lock'), () => actions.activateLockScreen());
        add(actions.canSwitchUser, _('Switch User'), () => actions.activateSwitchUser());
        add(actions.canLogout, _('Log Out'), () => actions.activateLogout());
        add(actions.canSuspend, _('Suspend'), () => actions.activateSuspend());
        add(this._canHibernate(), _('Hibernate'), () => this._hibernate());
        add(actions.canRestart, _('Restart'), () => actions.activateRestart());
        add(actions.canPowerOff, _('Power Off'), () => actions.activatePowerOff());
        return items;
    }

    /** Hibernar não está nas ações do GNOME: perguntamos ao systemd-logind. */
    _login1(method, args = null) {
        return Gio.DBus.system.call_sync('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', method, args, null, Gio.DBusCallFlags.NONE, 500, null);
    }

    _canHibernate() {
        if (this._hibernateOk === undefined) {
            try {
                this._hibernateOk = this._login1('CanHibernate').deepUnpack()[0] === 'yes';
            } catch {
                this._hibernateOk = false;
            }
        }
        return this._hibernateOk;
    }

    _hibernate() {
        Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'Hibernate', new GLib.Variant('(b)', [true]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _applyLook() {
        const dark = this._dock.look?.dark !== false;
        for (const actor of [this._box, this._layer]) {
            actor.remove_style_class_name(dark ? 'orla-light' : 'orla-dark');
            actor.add_style_class_name(dark ? 'orla-dark' : 'orla-light');
        }
        const glass = this.settings.get_boolean('blur-enabled');
        if (glass && !this._glass) {
            this._glass = new RoundedBlurEffect({cornerRadius: RADIUS});
            this._box.add_effect(this._glass);
        }
        if (this._glass) {
            this._glass.enabled = glass;
            if (glass) {
                const params = glassParams(this.settings);
                this._glass.radius = params.radius;
                this._glass.setGlass(params);
            }
        }
        this._box.set_style(glass ? 'background-color: transparent;' : this._dock.look?.popupCss ?? '');
    }

    // ---------- Telas ----------

    _show(view) {
        if (this._view === view)
            return;
        this._view = view;
        for (const child of this._body.get_children())
            this._body.remove_child(child);
        this._body.add_child(view.actor);
        // A tela ocupa a largura toda e começa no topo.
        view.actor.x_align = Clutter.ActorAlign.FILL;
        view.actor.opacity = 0;
        view.actor.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    showHome() {
        this._home.refresh();
        this._show(this._home);
    }

    showAllApps() {
        this._allApps.refresh();
        this._show(this._allApps);
        this._allApps.focusFirst();
    }

    _onSearchChanged() {
        const text = this._entry.get_text();
        if (!text.trim()) {
            this.showHome();
            return;
        }
        this._show(this._search);
        this._search.setQuery(text);
    }

    // ---------- Abrir e fechar ----------

    open() {
        if (this._isOpen)
            return;
        this._isOpen = true;
        this._dock.resetZoom?.();
        const monitor = this._dock.monitor;
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._overlay.show();
        this._applyLook();
        this._entry.set_text('');
        this.showHome();
        this._place();
        this._grab = Main.pushModal(this._overlay);
        this._entry.grab_key_focus();

        const from = this._slideOffset();
        this._box.opacity = 0;
        this._box.set_translation(from[0], from[1], 0);
        this._box.ease({
            opacity: 255, translation_x: 0, translation_y: 0,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._dock.autohide?.sync();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._hideLayer();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const [tx, ty] = this._slideOffset();
        this._box.ease({
            opacity: 0, translation_x: tx / 2, translation_y: ty / 2,
            duration: OPEN_MS * 0.7,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (!this._isOpen)
                    this._overlay.hide();
            },
        });
        this._dock.autohide?.sync();
    }

    /** O menu "sai" da barra: desliza um pouco a partir dela ao abrir. */
    _slideOffset() {
        const d = 14;
        return [[0, d], [0, -d], [-d, 0], [d, 0]][this._dock.axis.position];
    }

    /** Acima do botão Iniciar (centralizado na barra), sem sair da tela. */
    _place() {
        const monitor = this._dock.monitor;
        const bar = this._dock.backgroundActor;
        const [bx, by] = bar.get_transformed_position();
        const [bw, bh] = bar.get_transformed_size();
        const [, , width, height] = this._box.get_preferred_size();
        const start = this._dock.startButton ?? bar;
        const [sx] = start.get_transformed_position();
        const [sw] = start.get_transformed_size();
        let x, y;
        switch (this._dock.axis.position) {
        case 1:     // em cima
            x = sx + sw / 2 - width / 2;
            y = by + bh + GAP;
            break;
        case 2:     // esquerda
            x = bx + bw + GAP;
            y = by + bh / 2 - height / 2;
            break;
        case 3:     // direita
            x = bx - GAP - width;
            y = by + bh / 2 - height / 2;
            break;
        default:    // embaixo
            x = sx + sw / 2 - width / 2;
            y = by - GAP - height;
        }
        x = Math.max(monitor.x + MARGIN, Math.min(x, monitor.x + monitor.width - width - MARGIN));
        y = Math.max(monitor.y + MARGIN, Math.min(y, monitor.y + monitor.height - height - MARGIN));
        // O menu mora dentro da camada, que começa no canto do monitor.
        this._box.set_position(Math.round(x - monitor.x), Math.round(y - monitor.y));
    }

    _onOutsidePress(event) {
        const [x, y] = event.get_coords();
        const [bx, by] = this._box.get_transformed_position();
        const inside = x >= bx && x <= bx + this._box.width && y >= by && y <= by + this._box.height;
        if (!inside)
            this.close();
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            if (this._layer.visible)
                this._hideLayer();
            else if (this._entry.get_text())
                this._entry.set_text('');
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        // Setas andam entre os itens (o St acha o vizinho na direção).
        const directions = {
            [Clutter.KEY_Up]: St.DirectionType.UP, [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Left]: St.DirectionType.LEFT, [Clutter.KEY_Right]: St.DirectionType.RIGHT,
        };
        if (key in directions) {
            const focus = global.stage.get_key_focus();
            const root = this._layer.visible ? this._layer : this._box;
            if (root.navigate_focus(focus, directions[key], false))
                return Clutter.EVENT_STOP;
        }
        // Digitar em qualquer lugar vai para a busca.
        const char = event.get_key_unicode();
        if (char && char.length === 1 && char >= ' ' && !this._layer.visible &&
            global.stage.get_key_focus() !== this._entry.clutter_text) {
            this._entry.grab_key_focus();
            this._entry.clutter_text.insert_text(char, -1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---------- Ações ----------

    _afterClose(run) {
        this.close();
        this.later(OPEN_MS, run);
    }

    launch(app) {
        this._afterClose(() => app.open_new_window(-1));
    }

    _launchId(id) {
        const app = Shell.AppSystem.get_default().lookup_app(id);
        if (app)
            this.launch(app);
    }

    openFile(file) {
        this.openUri(file.get_uri());
    }

    openUri(uri) {
        this._afterClose(() => {
            Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, null);
        });
    }

    runCommand(command, inTerminal) {
        this._afterClose(() => {
            try {
                if (!inTerminal) {
                    GLib.spawn_command_line_async(command);
                    return;
                }
                const found = TERMINALS.find(([bin]) => GLib.find_program_in_path(bin));
                if (!found)
                    throw new Error(_('No terminal found'));
                const [bin, prefix] = found;
                GLib.spawn_async(null, [bin, ...prefix, `${command}; exec "\${SHELL:-sh}"`], null,
                    GLib.SpawnFlags.SEARCH_PATH, null);
            } catch (e) {
                Main.notifyError(_('Could not run the command'), e.message);
            }
        });
    }

    newFolderName() {
        const base = _('New Folder');
        const names = new Set(this.data.folders.map(f => f.name));
        let name = base;
        for (let i = 2; names.has(name); i++)
            name = `${base} ${i}`;
        return name;
    }

    /** Itens do menu de contexto de um app. */
    appMenu(app, {pinnedKey = null, folderId = null} = {}) {
        const items = [{label: _('Open'), activate: () => this.launch(app)}];
        if (app.can_open_new_window() && app.get_n_windows() > 0)
            items.push({label: _('New Window'), activate: () => this._afterClose(() => app.open_new_window(-1))});
        const info = app.get_app_info();
        for (const action of info?.list_actions?.() ?? []) {
            items.push({
                label: info.get_action_name(action),
                activate: () => this._afterClose(() => app.launch_action(action, 0, -1)),
            });
        }
        items.push(null);
        if (folderId) {
            items.push({label: _('Remove from Folder'), activate: () => this.data.takeOutOfFolder(folderId, app.get_id())});
        } else if (pinnedKey || this.data.isPinned(app)) {
            items.push({label: _('Unpin from Start'), activate: () => this.data.unpin(pinnedKey ?? app.get_id())});
        } else {
            items.push({label: _('Pin to Start'), activate: () => this.data.pin(app)});
        }
        items.push(this.data.isOnDock(app)
            ? {label: _('Unpin from Taskbar'), activate: () => this.data.toggleDock(app)}
            : {label: _('Pin to Taskbar'), activate: () => this.data.toggleDock(app)});
        return items;
    }

    fileMenu(file) {
        return [
            {label: _('Open'), activate: () => this.openFile(file)},
            {label: _('Show in Files'), activate: () => this._afterClose(() => {
                Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
                    'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
                    null, Gio.DBusCallFlags.NONE, -1, null, null);
            })},
        ];
    }

    // ---------- Camada de cima: menu de contexto e pastas ----------

    _showLayer(content, x, y, {center = false} = {}) {
        this._layer.destroy_all_children();
        this._layer.set_size(this._overlay.width, this._overlay.height);
        this._layer.add_child(content);
        this._layer.show();
        const [, , w, h] = content.get_preferred_size();
        const [ox, oy] = this._overlay.get_transformed_position();
        let left, top;
        if (center) {
            const [bx, by] = this._box.get_transformed_position();
            left = bx + this._box.width / 2 - w / 2;
            top = by + this._box.height / 2 - h / 2;
        } else {
            left = x;
            top = y - h > oy + MARGIN ? y - h : y;
        }
        left = Math.max(ox + MARGIN, Math.min(left, ox + this._overlay.width - w - MARGIN));
        top = Math.max(oy + MARGIN, Math.min(top, oy + this._overlay.height - h - MARGIN));
        content.set_position(Math.round(left - ox), Math.round(top - oy));
        content.opacity = 0;
        content.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        content.connect('button-press-event', () => Clutter.EVENT_STOP);
    }

    _hideLayer() {
        this._layer.hide();
        this._layer.destroy_all_children();
        this._openFolderId = null;
        if (this._isOpen && global.stage.get_key_focus() === null)
            this._entry.grab_key_focus();
    }

    /** Menu de contexto: itens {label, activate}; null = separador. */
    showContextMenu(items, x, y) {
        const menu = new St.BoxLayout({style_class: 'orla-start-context', orientation: Clutter.Orientation.VERTICAL});
        let first = null;
        for (const item of items) {
            if (!item) {
                if (menu.get_n_children())
                    menu.add_child(new St.Widget({style_class: 'orla-start-separator'}));
                continue;
            }
            const button = new St.Button({style_class: 'orla-start-context-item', can_focus: true,
                x_align: Clutter.ActorAlign.FILL,
                child: new St.Label({text: item.label, x_align: Clutter.ActorAlign.START, x_expand: true})});
            button.connect('clicked', () => {
                this._hideLayer();
                item.activate();
            });
            first ??= button;
            menu.add_child(button);
        }
        this._showLayer(menu, x, y);
        first?.grab_key_focus();
    }

    /** Uma pasta dos fixados: nome (clique para renomear) e os apps dela. */
    showFolder(folderId) {
        const folder = this.data.folders.find(f => f.id === folderId);
        if (!folder) {
            this._hideLayer();
            return;
        }
        this._openFolderId = folderId;
        const popup = new St.BoxLayout({style_class: 'orla-start-folder', orientation: Clutter.Orientation.VERTICAL});
        const title = new St.Entry({style_class: 'orla-start-folder-title', text: folder.name, can_focus: true});
        title.clutter_text.connect('activate', () => this.data.setFolderName(folderId, title.get_text()));
        title.clutter_text.connect('key-focus-out', () => this.data.setFolderName(folderId, title.get_text()));
        popup.add_child(title);
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true})});
        const apps = folder.apps.map(id => Shell.AppSystem.get_default().lookup_app(id)).filter(Boolean);
        apps.forEach((app, i) => {
            grid.layout_manager.attach(new AppCell({
                gicon: app.get_icon(),
                name: app.get_name(),
                running: app.get_n_windows() > 0,
                activate: () => this.launch(app),
                menu: () => this.appMenu(app, {folderId}),
                owner: this,
            }), i % 4, Math.floor(i / 4), 1, 1);
        });
        popup.add_child(grid);
        this._showLayer(popup, 0, 0, {center: true});
        grid.get_first_child()?.grab_key_focus();
    }

    // ---------- Utilidades ----------

    /** Roda `fn` daqui a `ms` (cancelado se o menu for destruído). */
    later(ms, fn) {
        const timeout = new Timeout();
        this._timeouts.add(timeout);
        timeout.start(ms, () => {
            this._timeouts.delete(timeout);
            fn();
        });
    }

    destroy() {
        this.close();
        for (const timeout of this._timeouts)
            timeout.cancel();
        this._timeouts.clear();
        this._refresh.cancel();
        this.settings.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._home.destroy();
        this._allApps.destroy();
        this._search.destroy();
        this.data.destroy();
        this._overlay.destroy();
    }
}
