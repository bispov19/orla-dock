// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/startMenu.js — a "casca" do Menu Iniciar da Orla.
//
// A casca cuida do que é igual em todos os estilos:
//   - abrir e fechar, no monitor do ponteiro, saindo do botão de apps;
//   - onde o menu aparece (lib/start/placement.js, um módulo só);
//   - o tamanho, o fundo (sólido, com opacidade escolhida; vidro opcional,
//     lib/start/glass.js) e o tema claro/escuro;
//   - teclado: Esc, setas, Tab entre áreas, digitar para buscar, Super;
//   - fechar ao clicar fora, ao abrir um app e ao abrir a Visão Geral;
//   - menus de contexto e submenus (numa camada por cima do menu);
//   - as ações: abrir app, arquivo, endereço, comando, energia.
//
// O conteúdo vem do ESTILO escolhido (lib/start/styles/).
//
// Desempenho (o padrão do projeto):
//   - o menu é montado UMA vez (logo depois de a extensão ligar, sem
//     pressa) e só é mostrado/escondido; nada é construído ao abrir;
//   - o que muda (fixados, apps instalados, recentes, apps abertos) avisa
//     por sinal e o estilo atualiza só aquela parte, com o menu fechado;
//   - abrir/fechar anima só opacidade, escala e deslocamento (feito pela
//     placa de vídeo, sem refazer o layout a cada quadro).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Timeout} from '../utils.js';
import {StartData} from './data.js';
import {MenuGlass} from './glass.js';
import {anchorOf, placeMenu} from './placement.js';
import {createStyle} from './styles/index.js';

const OPEN_MS = 200;
const CLOSE_MS = 150;
const OPEN_SCALE = 0.96;
const MARGIN = 8;
const SIZES = {small: 0.86, medium: 1, large: 1.16};
// Cores do fundo (o texto por cima passa do contraste AA do WCAG mesmo
// com a opacidade mínima, 0,85, sobre um papel de parede branco ou preto).
const BASE = {dark: [32, 32, 36], light: [248, 248, 250]};

// Mudou uma destas: o menu é remontado.
const REBUILD_KEYS = ['start-menu-style', 'start-menu-size'];
// Mudou uma destas: só a aparência.
const LOOK_KEYS = ['start-menu-opacity', 'start-menu-glass'];
// Mudou uma destas: esta parte do conteúdo.
const CONTENT_KEYS = {
    'start-menu-recent-apps': 'recent',
    'start-menu-recent-app-ids': 'recent',
    'start-menu-continue': 'files',
    'start-menu-recent-files': 'files',
};
const ALL_PARTS = ['pinned', 'apps', 'recent', 'files', 'running'];

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
        this._dirty = new Set(ALL_PARTS);
        this._timeouts = new Set();
        this._refresh = new Timeout();

        // A camada que cobre o monitor: pega o clique fora e o teclado.
        this._overlay = new St.Widget({reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        Main.layoutManager.addTopChrome(this._overlay);
        this._overlay.connect('button-press-event', (_a, event) => this._onOutsidePress(event));
        this._overlay.connect('key-press-event', (_a, event) => this._onKey(event));

        // A moldura é o que anima; dentro dela, o vidro (opcional) atrás e
        // a caixa com o conteúdo na frente.
        this._frame = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        this._overlay.add_child(this._frame);
        this._glass = new MenuGlass();
        this._frame.add_child(this._glass.actor);
        this._box = new St.BoxLayout({
            style_class: 'orla-start',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: true,
        });
        this._frame.add_child(this._box);

        // Camada de cima: menus de contexto e submenus.
        this._layer = new St.Widget({reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        this._overlay.add_child(this._layer);
        this._layer.connect('button-press-event', () => {
            this.hideLayer();
            return Clutter.EVENT_STOP;
        });

        this.settings.connectObject('changed', (_s, key) => {
            if (REBUILD_KEYS.includes(key)) {
                this.close({animate: false});
                this._dropStyle();
                // Remonta já, com o menu fechado (não na hora de abrir) e
                // fora das animações da Visão Geral.
                const rebuild = () => {
                    if (Main.overview.animationInProgress)
                        this._refresh.start(300, rebuild);
                    else
                        this.prepare();
                };
                this._refresh.start(150, rebuild);
            } else if (LOOK_KEYS.includes(key)) {
                if (this._isOpen)
                    this._applyLook();
            } else if (key in CONTENT_KEYS) {
                this.markDirty(CONTENT_KEYS[key]);
            }
        }, this);
        // Fixados = favoritos do GNOME: mudaram (aqui, na dock ou no dash).
        global.settings.connectObject('changed::favorite-apps', () => this.markDirty('pinned'), this);
        const apps = Shell.AppSystem.get_default();
        apps.connectObject(
            'installed-changed', () => this.markDirty('apps', 'pinned'),
            'app-state-changed', () => this.markDirty('running'),
            this);
        this.data.onFilesChanged = () => this.markDirty('files');
        Main.overview.connectObject(
            'showing', () => this.close(),
            // Super duas vezes: o menu abriu enquanto a Visão Geral saía; no
            // fim da saída o GNOME limpa o foco do teclado. Devolvemos ao menu.
            'hidden', () => {
                const focus = global.stage.get_key_focus();
                if (this._isOpen && !(focus && this._overlay.contains(focus)))
                    this._style?.focusInitial();
            },
            this);
        Main.sessionMode.connectObject('updated', () => this.close({animate: false}), this);
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

    get animate() {
        return this.settings.get_boolean('start-menu-animate') && St.Settings.get().enable_animations;
    }

    toggle(dock = null) {
        if (this._isOpen)
            this.close();
        else
            this.open(dock);
    }

    // ---------- Montagem e atualização (fora da animação) ----------

    /**
     * Monta o menu sem mostrar (chamado com folga, logo depois de a
     * extensão ligar): a primeira abertura já encontra tudo pronto.
     */
    prepare() {
        this._ensureStyle();
        this._applyDirty();
        this._warmLayout();
    }

    /**
     * Calcula o layout uma vez, invisível e sem pegar cliques: a primeira
     * abertura de verdade não precisa medir textos nem posicionar centenas
     * de atores no primeiro quadro da animação.
     */
    _warmLayout() {
        if (this._isOpen || this._overlay.visible)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [w, h] = this._style.size;
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._frame.set_size(Math.min(w * scale, monitor.width), Math.min(h * scale, monitor.height));
        this._frame.opacity = 0;
        this._overlay.reactive = false;
        this._overlay.show();
        this.later(120, () => {
            this._overlay.reactive = true;
            if (!this._isOpen)
                this._overlay.hide();
        });
    }

    /** Partes do conteúdo mudaram: atualiza com calma (ou na hora, se aberto). */
    markDirty(...parts) {
        parts.forEach(p => this._dirty.add(p));
        this._queueRefresh();
    }

    _queueRefresh() {
        // Junta rajadas de sinais (ex.: vários apps instalados de uma vez).
        const apply = () => {
            if (!this._isOpen && Main.overview.animationInProgress) {
                this._refresh.start(300, apply);
                return;
            }
            if (this._style)
                this._applyDirty();
        };
        this._refresh.start(this._isOpen ? 60 : 250, apply);
    }

    _applyDirty() {
        if (!this._style || !this._dirty.size)
            return;
        const dirty = new Set(this._dirty);
        this._dirty.clear();
        this._style.refresh(dirty);
    }

    _dropStyle() {
        this._style?.destroy();
        this._style = null;
        this._dirty = new Set(ALL_PARTS);
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
        this._glass.cornerRadius = this._style.id === 'launchpad' ? 22 : 16;
        this._dirty = new Set(ALL_PARTS);
    }

    // ---------- Aparência ----------

    get _dark() {
        const look = this._dock?.look;
        return look ? look.dark !== false : this._manager.darkMode;
    }

    _applyLook() {
        const dark = this._dark;
        for (const actor of [this._box, this._layer]) {
            actor.remove_style_class_name(dark ? 'orla-light' : 'orla-dark');
            actor.add_style_class_name(dark ? 'orla-dark' : 'orla-light');
        }
        // Fundo sólido (ou quase), com a opacidade escolhida; com o vidro
        // ligado, um pouco mais transparente para o vidro aparecer, mas
        // nunca abaixo do que mantém o texto legível.
        const glass = this.settings.get_boolean('start-menu-glass');
        let alpha = Math.max(0.85, Math.min(1, this.settings.get_double('start-menu-opacity')));
        if (glass)
            alpha = Math.max(0.72, alpha - 0.18);
        const [r, g, b] = BASE[dark ? 'dark' : 'light'];
        this._box.set_style(`background-color: rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)});`);
        return glass;
    }

    // ---------- Abrir e fechar ----------

    /**
     * Abre o menu. Sem `dock`, no monitor do ponteiro, saindo do botão de
     * apps da dock desse monitor (o mesmo ponto do clique no botão).
     */
    open(dock = null) {
        if (this._isOpen || Main.sessionMode.isLocked)
            return;
        const monitorIndex = dock?.monitorIndex ?? global.display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._dock = dock ?? this._manager.docks.find(d => d.monitorIndex === monitor.index) ?? null;
        this._isOpen = true;
        this._dock?.resetZoom?.();

        // Pronto ANTES de aparecer: monta (se ainda não montou) e aplica
        // o que ficou pendente. Na prática já está tudo pronto.
        this._ensureStyle();
        this._refresh.cancel();
        this._applyDirty();
        this._style.reset();

        this._overlay.reactive = true;
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        const glass = this._applyLook();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [baseW, baseH] = this._style.size;
        const place = placeMenu({
            monitor,
            anchor: anchorOf(this._dock, monitor),
            mode: this._style.placement ?? this.settings.get_string('start-menu-position'),
            width: Math.round(baseW * scale),
            height: Math.round(baseH * scale),
            scale,
        });
        this._place = place;
        this._frame.set_size(place.width, place.height);
        this._frame.set_position(place.x - monitor.x, place.y - monitor.y);
        this._glass.sync(glass, monitor, place.x, place.y, this._dark);
        this._overlay.show();

        this._grab = Main.pushModal(this._overlay);
        this._style.focusInitial();
        this._animateIn();
        this._dock?.autohide?.sync();
    }

    _animateIn() {
        const frame = this._frame;
        frame.set_pivot_point(...this._place.pivot);
        // Abrindo de novo no meio do fechamento: continua de onde está.
        const resuming = frame.get_transition('opacity') !== null;
        frame.remove_all_transitions();
        if (!this.animate) {
            frame.set({opacity: 255, scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
            return;
        }
        if (!resuming) {
            const [tx, ty] = this._place.slide;
            frame.set({opacity: 0, scale_x: OPEN_SCALE, scale_y: OPEN_SCALE, translation_x: tx, translation_y: ty});
        }
        frame.ease({
            opacity: 255, scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    close({animate = true} = {}) {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this.hideLayer();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const dock = this._dock;
        const frame = this._frame;
        frame.remove_all_transitions();
        if (animate && this.animate && this._place) {
            const [tx, ty] = this._place.slide;
            frame.ease({
                opacity: 0, scale_x: OPEN_SCALE, scale_y: OPEN_SCALE,
                translation_x: tx * 0.6, translation_y: ty * 0.6,
                duration: CLOSE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: finished => {
                    if (finished && !this._isOpen)
                        this._overlay.hide();
                },
            });
        } else {
            this._overlay.hide();
        }
        if (dock && !dock.destroyed)
            dock.autohide?.sync();
    }

    // ---------- Mouse e teclado ----------

    _onOutsidePress(event) {
        const [x, y] = event.get_coords();
        const [fx, fy] = this._frame.get_transformed_position();
        const inside = x >= fx && x <= fx + this._frame.width && y >= fy && y <= fy + this._frame.height;
        // Dentro do menu, o clique segue para o botão (no GNOME 51 os botões
        // reconhecem o clique por gestos, e parar o evento aqui os calaria).
        if (inside)
            return Clutter.EVENT_PROPAGATE;
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
        this.later(this.animate ? CLOSE_MS : 0, run);
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
     * Mostra `content` na camada de cima. Com `anchor`, ao lado do menu,
     * na altura dele (um submenu); senão, no ponto (x, y).
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
            const [fx] = this._frame.get_transformed_position();
            const right = fx + this._frame.width + 4;
            // À direita do menu; sem espaço, à esquerda dele.
            left = right + w <= ox + this._overlay.width - MARGIN ? right : fx - 4 - w;
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
        this.close({animate: false});
        this._frame.remove_all_transitions();
        for (const timeout of this._timeouts)
            timeout.cancel();
        this._timeouts.clear();
        this._refresh.cancel();
        this.settings.disconnectObject(this);
        global.settings.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._style?.destroy();
        this._style = null;
        this._glass.destroy();
        this.data.destroy();
        this._overlay.destroy();
        this._dock = null;
    }
}
