// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/startMenu.js — a "casca" do Menu Iniciar da Orla.
//
// A casca cuida do que é igual em todos os estilos:
//   - abrir e fechar (com ou sem animação), no monitor do ponteiro;
//   - onde o menu aparece: junto da dock, num canto ou no centro;
//   - o tamanho (pequeno, médio, grande) e o tema claro/escuro;
//   - teclado: Esc, setas, Tab entre áreas, digitar para buscar, Super;
//   - fechar ao clicar fora, ao abrir um app e ao abrir a Visão Geral;
//   - menus de contexto e submenus (numa camada por cima do menu);
//   - as ações: abrir app, arquivo, endereço, comando, energia.
//
// O conteúdo vem do ESTILO escolhido (lib/start/styles/). Só existe um
// menu, que pertence ao DockManager; ele é montado na primeira vez que
// abre e remontado quando o estilo ou o tamanho mudam.
//
// Enquanto aberto, o menu fica com o teclado e o mouse (Main.pushModal).

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
import {Position, Timeout} from '../utils.js';
import {StartData} from './data.js';
import {createStyle} from './styles/index.js';

const GAP = 8;
const MARGIN = 8;
const OPEN_MS = 170;
const RADIUS = 16;
const SIZES = {small: 0.86, medium: 1, large: 1.16};

// Mudou uma destas: o menu é remontado na próxima vez que abrir.
const REBUILD_KEYS = ['start-menu-style', 'start-menu-size'];
// Mudou uma destas: o conteúdo é refeito (se estiver aberto).
const REFRESH_KEYS = ['start-menu-recent-apps', 'start-menu-continue', 'start-menu-recent-files'];

// Terminais conhecidos e como pedir "rode este comando".
const TERMINALS = [
    ['ptyxis', ['--', 'sh', '-c']],
    ['kgx', ['--', 'sh', '-c']],
    ['gnome-terminal', ['--', 'sh', '-c']],
    ['konsole', ['-e', 'sh', '-c']],
    ['xterm', ['-e', 'sh', '-c']],
];

export class StartMenu {
    /** @param {object} manager - o DockManager (lib/dockManager.js) */
    constructor(manager) {
        this._manager = manager;
        this.settings = manager.settings;
        this.data = new StartData(manager.settings, manager.appTracker);
        this.data.warmUp();
        this._checkHibernate();
        this._isOpen = false;
        this._grab = null;
        this._dock = null;
        this._style = null;
        this._timeouts = new Set();
        this._refresh = new Timeout();

        // A camada que cobre o monitor: pega o clique fora e o teclado.
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

        // Camada de cima: menus de contexto e submenus.
        this._layer = new St.Widget({reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        this._overlay.add_child(this._layer);
        this._layer.connect('button-press-event', () => {
            this.hideLayer();
            return Clutter.EVENT_STOP;
        });

        this.settings.connectObject('changed', (_s, key) => {
            if (REBUILD_KEYS.includes(key)) {
                this.close();
                this._dropStyle();
            } else if (REFRESH_KEYS.includes(key)) {
                this._queueRefresh();
            }
        }, this);
        // Fixados = favoritos do GNOME: mudaram (aqui, na dock ou no dash).
        global.settings.connectObject('changed::favorite-apps', () => this._queueRefresh(), this);
        Shell.AppSystem.get_default().connectObject('installed-changed', () => this._queueRefresh(), this);
        Main.overview.connectObject('showing', () => this.close(), this);
        Main.sessionMode.connectObject('updated', () => this.close(), this);
    }

    get isOpen() {
        return this._isOpen;
    }

    /** A dock junto da qual o menu está aberto (ou null). */
    get dock() {
        return this._isOpen ? this._dock : null;
    }

    get manager() {
        return this._manager;
    }

    /** O estilo montado agora (para testes e capturas). */
    get style() {
        return this._style;
    }

    toggle(dock = null) {
        if (this._isOpen)
            this.close();
        else
            this.open(dock);
    }

    _queueRefresh() {
        // Os favoritos do GNOME se atualizam no mesmo sinal; esperar um
        // pouco garante que lemos a lista nova.
        this._refresh.start(60, () => {
            if (this._isOpen)
                this._style?.refresh();
        });
    }

    // ---------- Estilo e tamanho ----------

    _dropStyle() {
        this._style?.destroy();
        this._style = null;
    }

    _ensureStyle() {
        if (this._style)
            return;
        const id = this.settings.get_string('start-menu-style');
        const factor = SIZES[this.settings.get_string('start-menu-size')] ?? 1;
        this._style = createStyle(id, this, factor);
        for (const name of this._box.get_style_class_name()?.split(' ') ?? []) {
            if (name.startsWith('orla-start-style-'))
                this._box.remove_style_class_name(name);
        }
        this._box.add_style_class_name(`orla-start-style-${this._style.id}`);
        this._box.add_child(this._style.actor);
    }

    // ---------- Aparência ----------

    _applyLook() {
        const look = this._dock?.look;
        const dark = look ? look.dark !== false : this._manager.darkMode;
        for (const actor of [this._box, this._layer]) {
            actor.remove_style_class_name(dark ? 'orla-light' : 'orla-dark');
            actor.add_style_class_name(dark ? 'orla-dark' : 'orla-light');
        }
        // Vidro só se a dock usa vidro (é a escolha do usuário para a Orla);
        // sem ele, o fundo é uma cor lisa, o mais leve possível.
        const glass = this.settings.get_boolean('blur-enabled') && Boolean(look);
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
        this._box.set_style(glass ? 'background-color: transparent;' : look?.popupCss ?? '');
    }

    get animate() {
        return this.settings.get_boolean('start-menu-animate') && St.Settings.get().enable_animations;
    }

    // ---------- Abrir e fechar ----------

    /**
     * Abre o menu. Sem `dock`, abre no monitor onde está o ponteiro (junto
     * da dock desse monitor, se houver).
     */
    open(dock = null) {
        if (this._isOpen || Main.sessionMode.isLocked)
            return;
        const monitorIndex = dock?.monitorIndex ?? global.display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._dock = dock ?? this._manager.docks.find(d => d.monitorIndex === monitorIndex) ?? null;
        this._monitorIndex = monitor.index ?? monitorIndex;
        this._isOpen = true;
        this._dock?.resetZoom?.();

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._overlay.show();
        this._ensureStyle();
        this._applyLook();
        this._style.reset();
        this._place(monitor);
        this._grab = Main.pushModal(this._overlay);
        this._style.focusInitial();

        this._box.remove_all_transitions();
        if (this.animate) {
            const [tx, ty, scale] = this._entrance();
            this._box.opacity = 0;
            this._box.set_pivot_point(0.5, 0.5);
            this._box.set_translation(tx, ty, 0);
            this._box.set_scale(scale, scale);
            this._box.ease({
                opacity: 255, translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1,
                duration: OPEN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._box.opacity = 255;
            this._box.set_translation(0, 0, 0);
            this._box.set_scale(1, 1);
        }
        this._dock?.autohide?.sync();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this.hideLayer();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const dock = this._dock;
        this._box.remove_all_transitions();
        if (this.animate) {
            const [tx, ty, scale] = this._entrance();
            this._box.ease({
                opacity: 0, translation_x: tx / 2, translation_y: ty / 2,
                scale_x: (1 + scale) / 2, scale_y: (1 + scale) / 2,
                duration: OPEN_MS * 0.7,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    if (!this._isOpen)
                        this._overlay.hide();
                },
            });
        } else {
            this._overlay.hide();
        }
        if (dock && !dock.destroyed)
            dock.autohide?.sync();
    }

    /** De onde o menu "entra": desliza da dock, ou cresce um pouco no centro. */
    _entrance() {
        if (this._placement !== 'dock' || !this._dock)
            return [0, 0, 0.96];
        const d = 14;
        const [tx, ty] = [[0, d], [0, -d], [-d, 0], [d, 0]][this._dock.axis.position] ?? [0, d];
        return [tx, ty, 1];
    }

    // ---------- Posição ----------

    /**
     * A área livre do monitor: a área de trabalho do GNOME (sem a barra de
     * cima) e, se a dock não reserva espaço (auto-ocultar), sem ela também.
     */
    _freeArea(monitor) {
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index ?? this._monitorIndex);
        let {x, y, width, height} = area;
        const bar = this._dock?.backgroundActor;
        if (bar?.get_stage() && bar.visible) {
            const [bx, by] = bar.get_transformed_position();
            const [bw, bh] = bar.get_transformed_size();
            switch (this._dock.axis.position) {
            case Position.TOP: {
                const bottom = by + bh;
                if (bottom > y) {
                    height -= bottom - y;
                    y = bottom;
                }
                break;
            }
            case Position.LEFT: {
                const right = bx + bw;
                if (right > x) {
                    width -= right - x;
                    x = right;
                }
                break;
            }
            case Position.RIGHT:
                width = Math.min(width, bx - x);
                break;
            default:
                height = Math.min(height, by - y);
            }
        }
        return {x: x + MARGIN, y: y + MARGIN, width: width - 2 * MARGIN, height: height - 2 * MARGIN};
    }

    _place(monitor) {
        const free = this._freeArea(monitor);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // O tamanho pedido pelo estilo, sem passar da área livre.
        const [baseW, baseH] = this._style.size;
        const width = Math.min(Math.round(baseW * scale), free.width);
        const height = Math.min(Math.round(baseH * scale), free.height);
        this._box.set_size(width, height);

        let placement = this._style.placement ?? this.settings.get_string('start-menu-position');
        if (placement === 'dock' && !this._dock)
            placement = 'corner';
        this._placement = placement;

        let x, y;
        const position = this._dock?.axis.position ?? Position.BOTTOM;
        if (placement === 'center') {
            x = free.x + (free.width - width) / 2;
            y = free.y + (free.height - height) / 2;
        } else if (placement === 'corner') {
            // O canto do lado onde começa a dock (o "Iniciar" do Windows).
            x = position === Position.RIGHT ? free.x + free.width - width : free.x;
            y = position === Position.TOP ? free.y : free.y + free.height - height;
            if (position === Position.LEFT || position === Position.RIGHT)
                y = free.y;
        } else {
            // Junto do botão Iniciar/aplicativos (ou do meio da dock).
            const bar = this._dock.backgroundActor;
            const [bx, by] = bar.get_transformed_position();
            const [bw, bh] = bar.get_transformed_size();
            const anchor = this._dock.startButton?.get_stage() ? this._dock.startButton : bar;
            const [sx, sy] = anchor.get_transformed_position();
            const [sw, sh] = anchor.get_transformed_size();
            switch (position) {
            case Position.TOP:
                x = sx + sw / 2 - width / 2;
                y = by + bh + GAP;
                break;
            case Position.LEFT:
                x = bx + bw + GAP;
                y = sy + sh / 2 - height / 2;
                break;
            case Position.RIGHT:
                x = bx - GAP - width;
                y = sy + sh / 2 - height / 2;
                break;
            default:
                x = sx + sw / 2 - width / 2;
                y = by - GAP - height;
            }
        }
        // Nunca sai do monitor.
        x = Math.max(monitor.x + MARGIN, Math.min(x, monitor.x + monitor.width - width - MARGIN));
        y = Math.max(monitor.y + MARGIN, Math.min(y, monitor.y + monitor.height - height - MARGIN));
        // O menu mora dentro da camada, que começa no canto do monitor.
        this._box.set_position(Math.round(x - monitor.x), Math.round(y - monitor.y));
    }

    // ---------- Mouse e teclado ----------

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
                this.hideLayer();
            else if (!this._style?.escape())
                this.close();
            return Clutter.EVENT_STOP;
        }
        // Super com o menu aberto fecha (como no Windows).
        if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (!this._layer.visible && this._style?.handleKey(event))
            return Clutter.EVENT_STOP;

        // Tab: pula para a próxima ÁREA do estilo (busca, fixados, lista…).
        if (key === Clutter.KEY_Tab || key === Clutter.KEY_ISO_Left_Tab) {
            const back = key === Clutter.KEY_ISO_Left_Tab ||
                Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
            this._nextArea(back);
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
        const entry = this._style?.entry;
        if (entry && char && char.length === 1 && char >= ' ' && !this._layer.visible &&
            global.stage.get_key_focus() !== entry.clutter_text) {
            entry.grab_key_focus();
            entry.clutter_text.insert_text(char, -1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _nextArea(back) {
        const areas = (this._style?.areas ?? []).filter(a => a.visible && a.mapped);
        if (!areas.length)
            return;
        const focus = global.stage.get_key_focus();
        const current = areas.findIndex(a => focus && (a === focus || a.contains(focus)));
        const step = back ? -1 : 1;
        for (let i = 1; i <= areas.length; i++) {
            const area = areas[(current + step * i + areas.length * 2) % areas.length];
            if (area instanceof St.Entry || area.can_focus) {
                area.grab_key_focus();
                return;
            }
            if (area.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
                return;
        }
    }

    // ---------- Ações ----------

    /** Fecha o menu e, terminada a animação, roda `run`. */
    afterClose(run) {
        this.close();
        this.later(this.animate ? OPEN_MS : 0, run);
    }

    launch(app) {
        this.afterClose(() => app.open_new_window(-1));
    }

    launchId(id) {
        const app = Shell.AppSystem.get_default().lookup_app(id);
        if (app)
            this.launch(app);
    }

    openFile(file) {
        this.openUri(file.get_uri());
    }

    openUri(uri) {
        this.afterClose(() => {
            Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, null);
        });
    }

    /** Abre o gerenciador de arquivos com `file` selecionado. */
    showInFiles(file) {
        this.afterClose(() => {
            Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
                'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        });
    }

    runCommand(command, inTerminal) {
        this.afterClose(() => {
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

    /** Itens do menu de contexto de um app. */
    appMenu(app) {
        const items = [{label: _('Open'), activate: () => this.launch(app)}];
        if (app.can_open_new_window() && app.get_n_windows() > 0)
            items.push({label: _('New Window'), activate: () => this.afterClose(() => app.open_new_window(-1))});
        const info = app.get_app_info();
        for (const action of info?.list_actions?.() ?? []) {
            items.push({
                label: info.get_action_name(action),
                activate: () => this.afterClose(() => app.launch_action(action, 0, -1)),
            });
        }
        items.push(null);
        items.push(this.data.isPinned(app)
            ? {label: _('Unpin'), activate: () => this.data.unpin(app)}
            : {label: _('Pin'), activate: () => this.data.pin(app)});
        const path = info?.get_filename?.();
        if (path)
            items.push({label: _('Show in Files'), activate: () => this.showInFiles(Gio.File.new_for_path(path))});
        return items;
    }

    fileMenu(file) {
        return [
            {label: _('Open'), activate: () => this.openFile(file)},
            {label: _('Show in Files'), activate: () => this.showInFiles(file)},
        ];
    }

    // ---------- Energia ----------

    get systemActions() {
        return SystemActions.getDefault();
    }

    /** Todas as opções de energia que este computador permite. */
    powerItems() {
        const actions = SystemActions.getDefault();
        const items = [];
        const add = (when, label, run) => {
            if (when)
                items.push({label, activate: () => this.afterClose(run)});
        };
        add(actions.canLockScreen, _('Lock'), () => actions.activateLockScreen());
        add(actions.canSwitchUser, _('Switch User'), () => actions.activateSwitchUser());
        add(actions.canLogout, _('Log Out'), () => actions.activateLogout());
        add(actions.canSuspend, _('Suspend'), () => actions.activateSuspend());
        add(this._hibernateOk, _('Hibernate'), () => this._hibernate());
        add(actions.canRestart, _('Restart'), () => actions.activateRestart());
        add(actions.canPowerOff, _('Power Off'), () => actions.activatePowerOff());
        return items;
    }

    /**
     * Hibernar não está nas ações do GNOME: perguntamos ao systemd-logind,
     * de forma assíncrona (uma chamada síncrona travaria o Shell).
     */
    _checkHibernate() {
        this._hibernateOk = false;
        Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'CanHibernate', null, new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE, 2000, null, (bus, result) => {
                try {
                    this._hibernateOk = bus.call_finish(result).deepUnpack()[0] === 'yes';
                } catch {
                    this._hibernateOk = false;
                }
            });
    }

    _hibernate() {
        Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'Hibernate', new GLib.Variant('(b)', [true]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    // ---------- Camada de cima: menu de contexto e submenus ----------

    /**
     * Mostra `content` na camada de cima. Com `anchor`, ao lado dele (um
     * submenu); senão, no ponto (x, y) (um menu de contexto).
     */
    _showLayer(content, x, y, anchor = null) {
        this._layer.destroy_all_children();
        this._layer.set_size(this._overlay.width, this._overlay.height);
        this._layer.add_child(content);
        this._layer.show();
        const [, , w, h] = content.get_preferred_size();
        const [ox, oy] = this._overlay.get_transformed_position();
        let left, top;
        if (anchor) {
            const [, ay] = anchor.get_transformed_position();
            const [bx] = this._box.get_transformed_position();
            const right = bx + this._box.width + 4;
            // À direita do menu; sem espaço, à esquerda dele.
            left = right + w <= ox + this._overlay.width - MARGIN ? right : bx - 4 - w;
            top = ay;
        } else {
            left = x;
            top = y - h > oy + MARGIN ? y - h : y;
        }
        left = Math.max(ox + MARGIN, Math.min(left, ox + this._overlay.width - w - MARGIN));
        top = Math.max(oy + MARGIN, Math.min(top, oy + this._overlay.height - h - MARGIN));
        content.set_position(Math.round(left - ox), Math.round(top - oy));
        if (this.animate) {
            content.opacity = 0;
            content.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        content.connect('button-press-event', () => Clutter.EVENT_STOP);
    }

    get layerVisible() {
        return this._layer.visible;
    }

    hideLayer() {
        const had = this._layer.visible;
        this._layer.hide();
        this._layer.destroy_all_children();
        const back = this._layerReturn;
        this._layerReturn = null;
        if (!had || !this._isOpen)
            return;
        if (back?.get_stage())
            back.grab_key_focus();
        else if (global.stage.get_key_focus() === null)
            this._style?.focusInitial();
    }

    /** Menu de contexto: itens {label, activate}; null = separador. */
    showContextMenu(items, x, y) {
        this._layerReturn = global.stage.get_key_focus();
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
                this.hideLayer();
                item.activate();
            });
            first ??= button;
            menu.add_child(button);
        }
        this._showLayer(menu, x, y);
        first?.grab_key_focus();
    }

    /**
     * Submenu ao lado do menu, alinhado com `anchor` (ex.: os apps de uma
     * categoria). Seta para a esquerda ou Esc voltam para o `anchor`.
     */
    showFlyout(content, anchor) {
        this._layerReturn = anchor;
        content.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Left)
                return Clutter.EVENT_PROPAGATE;
            this.hideLayer();
            return Clutter.EVENT_STOP;
        });
        this._showLayer(content, 0, 0, anchor);
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
        global.settings.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._dropStyle();
        this.data.destroy();
        this._overlay.destroy();
        this._dock = null;
    }
}
