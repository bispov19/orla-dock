// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// appIcon.js — o ícone de um aplicativo na dock, e outros itens simples
// (botão da grade de apps e janelas minimizadas).
//
// Um Shell.App representa um aplicativo (ligado a um arquivo .desktop).
// Ele sabe seu nome, ícone, estado (parado / iniciando / rodando) e lista
// de janelas (Meta.Window). O Meta é a biblioteca do Mutter, o gerenciador
// de janelas; Meta.Window é uma janela de verdade na tela.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppMenu} from './appMenu.js';
import {createCalendarIcon, createThemeCalendarIcon, isCalendarApp} from './calendarIcon.js';
import {getAppWindows} from './appTracker.js';
import {DockItem} from './dockItem.js';
import {logoPath} from './logos.js';
import {Timeout} from './utils.js';

const LAUNCH_TIMEOUT_US = 8 * GLib.USEC_PER_SEC;
const ATTENTION_MAX_ROUNDS = 12;
const PREVIEW_DELAY_MS = 650;
const SPRING_LOAD_MS = 700;
// Miniatura de janela minimizada: a janela ocupa a célula com uma margem e
// o ícone do app fica num selo redondo, por cima, no canto de baixo.
const THUMB_MARGIN = 0.07;  // margem em volta da janela (fração do ícone)
const SEAL_SIZE = 0.38;     // diâmetro do selo (fração do ícone)

/**
 * Base para itens que podem ser arrastados (apps e arquivos das stacks).
 */
function makeItemDraggable(item) {
    // DND.makeDraggable (do GNOME Shell) começa um arraste quando o mouse se
    // move um pouco com o botão pressionado. Ele cria um "ator de arraste"
    // (getDragActor) que segue o cursor e avisa quem está embaixo.
    const draggable = DND.makeDraggable(item, {timeoutThreshold: 200});
    draggable.connect('drag-begin', () => item.dock.onDragBegin(item));
    draggable.connect('drag-cancelled', () => item.dock.onDragCancelled(item));
    draggable.connect('drag-end', () => item.dock.onDragEnd(item));
    return draggable;
}

export const AppIcon = GObject.registerClass(
class OrlaAppIcon extends DockItem {
    _init(dock, app) {
        super._init(dock);
        this.app = app;
        this.key = `app:${app.get_id()}`;
        this._attention = new Timeout();
        this._previewTimeout = new Timeout();
        this._springLoad = new Timeout();
        this._attentionRounds = 0;
        this._launching = false;

        // Bolinha de notificação (contador) e barra de progresso. Ficam
        // dentro do _iconBin, então crescem junto com a ampliação.
        this._badge = new St.Label({style_class: 'orla-badge', visible: false});
        this._badge.clutter_text.x_align = Clutter.ActorAlign.CENTER;
        this._iconBin.add_child(this._badge);
        this._progress = new St.Widget({style_class: 'orla-progress', visible: false});
        this._progressFill = new St.Widget({style_class: 'orla-progress-fill'});
        this._progress.add_child(this._progressFill);
        this._iconBin.add_child(this._progress);

        this.app.connectObject(
            'windows-changed', () => this._onWindowsChanged(),
            'notify::state', () => this._sync(),
            this);
        dock.manager.launcherEntry.connectObject('changed', (_le, appId) => {
            if (appId === this.app.get_id())
                this._syncBadge();
        }, this);
        dock.manager.notificationCounter.connectObject('changed', (_c, appId) => {
            if (appId === this.app.get_id().toLowerCase())
                this._syncBadge();
        }, this);
        dock.settings.connectObject('changed::show-badges', () => this._syncBadge(), this);

        this.connect('clicked', (_actor, button) => this._onClicked(button));
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this.dock.openMenu(this, new AppMenu(this));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('notify::hover', () => this._onHoverChanged());

        this._draggable = makeItemDraggable(this);
        this._sync();
        this._syncBadge();
    }

    get labelText() {
        return this.app.get_name();
    }

    createIcon(size) {
        // Calendário: o desenho da Dock com o dia de hoje, ou o ícone do tema
        // lido do arquivo (para pegar a data se o tema a atualiza).
        if (isCalendarApp(this.app)) {
            if (this.dock.settings.get_string('calendar-icon-style') === 'dock')
                return createCalendarIcon(size);
            const icon = createThemeCalendarIcon(this.app, size);
            if (icon)
                return icon;
        }
        return this.app.create_icon_texture(size);
    }

    onBinSizeChanged(binSize) {
        // Tamanhos relativos ao _iconBin (que está no tamanho ampliado).
        const badge = Math.round(binSize * 0.36);
        this._badgeStyle = `font-size: ${Math.round(binSize * 0.2)}px;` +
            `min-width: ${badge}px; height: ${badge}px; border-radius: ${badge}px;`;
        this._syncBadgeColor();
        this._badge.set_position(binSize - badge * 0.9, -badge * 0.1);
        const barH = Math.max(3, Math.round(binSize * 0.08));
        this._progressWidth = Math.round(binSize * 0.8);
        this._progressHeight = barH;
        this._progress.set_size(this._progressWidth, barH);
        this._progress.set_position(Math.round(binSize * 0.1), Math.round(binSize * 0.86));
        this._progress.set_style(`border-radius: ${barH}px;`);
        this._progressFill.set_style(`border-radius: ${barH}px;`);
        this._syncBadge();
    }

    _onWindowsChanged() {
        this._sync();
        this.dock.manager.queueIconGeometry();
    }

    syncAppearance() {
        super.syncAppearance();
        this._syncBadgeColor();
    }

    _syncBadgeColor() {
        const color = this.dock.look?.badgeColor ?? '#ff3b30';
        this._badge.set_style(`${this._badgeStyle ?? ''} background-color: ${color};`);
    }

    _sync() {
        // Um app cujas janelas são todas "ocultas" não conta como aberto.
        const allHidden = this.app.get_n_windows() > 0 && getAppWindows(this.app).length === 0;
        const running = this.app.state !== Shell.AppState.STOPPED && !allHidden;
        // Quantas janelas (o estilo "Janelas" desenha um ponto por janela).
        this.setIndicatorCount(running ? Math.max(1, getAppWindows(this.app).length) : 0);
        // Ao terminar de abrir, para de quicar.
        if (this._launching && this._launchFinished())
            this._launching = false;
    }

    // ---------- Clique ----------

    _onClicked(button) {
        this.dock.hidePreviews();
        if (button === Clutter.BUTTON_MIDDLE) {
            this._openNewWindow();
            return;
        }

        const windows = getAppWindows(this.app);
        // Conferimos a JANELA focada (e não só o "app focado"): quando a
        // única janela é minimizada, o GNOME continua considerando o app em
        // foco, mesmo sem nenhuma janela dele visível.
        const focusWindow = global.display.focus_window;
        const appFocused = focusWindow && !focusWindow.minimized &&
            Shell.WindowTracker.get_default().get_window_app(focusWindow) === this.app;

        if (this.app.state === Shell.AppState.STOPPED || windows.length === 0) {
            // Não está aberto (ou está aberto sem janela): abre/ativa.
            this.animateLaunch();
            this.app.activate();
        } else if (appFocused) {
            // Já está em foco: com várias janelas, alterna entre elas;
            // com uma só, minimiza (e ela "entra" no ícone).
            if (windows.length > 1)
                this._cycleWindows(windows, 1);
            else
                windows[0].minimize();
        } else {
            this._bringToFront();
        }
    }

    /**
     * App aberto, mas em segundo plano: traz para a frente todas as janelas
     * visíveis dele (como no Mac) e foca a mais recente. Se todas estiverem
     * minimizadas, restaura a mais recente. (No GNOME 51, app.activate()
     * não restaura janelas minimizadas, por isso fazemos à mão.)
     */
    _bringToFront() {
        // get_windows() vem ordenado da mais recente para a mais antiga.
        const windows = this.app.get_windows().filter(w => getAppWindows(this.app).includes(w));
        const visible = windows.filter(w => !w.minimized);
        const target = visible[0] ?? windows[0];
        for (const win of visible.slice(1).reverse())
            win.raise();
        Main.activateWindow(target);
    }

    _openNewWindow() {
        if (this.app.can_open_new_window()) {
            this.animateLaunch();
            this.app.open_new_window(-1);
        } else if (this.app.get_n_windows() > 0) {
            this._bringToFront();
        } else {
            this.app.activate();
        }
    }

    _cycleWindows(windows, direction) {
        const focused = global.display.focus_window;
        const index = windows.indexOf(focused);
        const next = windows[(index + direction + windows.length) % windows.length];
        Main.activateWindow(next);
    }

    // Rolar a roda do mouse sobre o ícone alterna entre as janelas.
    onScroll(event) {
        const windows = getAppWindows(this.app);
        if (windows.length === 0)
            return;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            this._cycleWindows(windows, -1);
        else if (direction === Clutter.ScrollDirection.DOWN)
            this._cycleWindows(windows, 1);
    }

    // ---------- Quique ao abrir ----------

    /** Começa a quicar até o app terminar de abrir (máx. 8 s). */
    animateLaunch() {
        // Alguns estilos (ex.: barra de tarefas do Windows) não quicam.
        if (!this.dock.style.bounce || !this.dock.settings.get_boolean('animate-launch') || this._launching)
            return;
        this._launching = true;
        this._launchWindows = this.app.get_n_windows();
        this._launchDeadline = GLib.get_monotonic_time() + LAUNCH_TIMEOUT_US;
        const loop = () => {
            if (!this._launching || this._launchFinished()) {
                this._launching = false;
                return;
            }
            this.bounce({
                height: this.geometry.iconSize * 0.55,
                duration: 600,
                onComplete: loop,
            });
        };
        loop();
    }

    _launchFinished() {
        return this.app.get_n_windows() > this._launchWindows ||
            GLib.get_monotonic_time() > this._launchDeadline;
    }

    // ---------- Atenção ----------

    /** Uma janela do app pediu atenção: quica alto, repetidamente. */
    requestAttention() {
        if (!this.dock.settings.get_boolean('bounce-on-attention') || this._attention.active)
            return;
        this._attentionRounds = 0;
        if (this.dock.style.attention === 'highlight') {
            // Estilo Windows: a célula fica laranja até o app receber foco.
            this.setAttention(true);
            this._attention.startRepeating(500, () => {
                if (this._needsAttention())
                    return true;
                this.setAttention(false);
                return false;
            });
            return;
        }
        const round = () => {
            if (!this._needsAttention() || this._attentionRounds++ >= ATTENTION_MAX_ROUNDS) {
                this._attention.cancel();
                return;
            }
            this.bounce({height: this.geometry.iconSize * 0.9, duration: 480, times: 2});
            this._attention.start(1600, round);
        };
        round();
    }

    _needsAttention() {
        if (Shell.WindowTracker.get_default().focus_app === this.app)
            return false;
        const entry = this.dock.manager.launcherEntry.get(this.app.get_id());
        return entry?.urgent ||
            this.app.get_windows().some(w => w.demands_attention || w.urgent);
    }

    // ---------- Bolinha e progresso (Unity LauncherEntry) ----------

    _syncBadge() {
        const manager = this.dock.manager;
        const entry = manager.launcherEntry.get(this.app.get_id());
        const enabled = this.dock.settings.get_boolean('show-badges');

        // Vale o número que o próprio app informa (Unity
        // LauncherEntry); se ele não informar, contamos as notificações dele
        // que ainda estão na central de notificações do GNOME. Funciona
        // inclusive para apps fixados que nem estão abertos.
        const reported = entry?.countVisible ? entry.count : 0;
        const count = reported > 0 ? reported : manager.notificationCounter.count(this.app.get_id());
        this._badge.visible = enabled && count > 0;
        this._badge.text = count > 99 ? '99+' : `${count}`;
        this.dock.queueGlassRedraw();

        const progress = Math.min(1, Math.max(0, entry?.progress ?? 0));
        this._progress.visible = enabled && this.app.state !== Shell.AppState.STOPPED &&
            Boolean(entry?.progressVisible);
        // Usamos os tamanhos que nós mesmos definimos: ler .width aqui
        // forçaria um cálculo de layout antes de o ator estar na tela.
        if (this._progressWidth)
            this._progressFill.set_size(Math.round(this._progressWidth * progress), this._progressHeight);

        if (entry?.urgent)
            this.requestAttention();
    }

    // ---------- Miniaturas ao passar o mouse ----------

    _onHoverChanged() {
        if (this.hover && this.dock.settings.get_boolean('window-previews') &&
            getAppWindows(this.app).length > 0) {
            this._previewTimeout.start(PREVIEW_DELAY_MS, () => {
                if (this.hover && !this.dock.dragging)
                    this.dock.showPreviews(this, false);
            });
        } else {
            this._previewTimeout.cancel();
        }
    }

    // ---------- Arrastar e soltar ----------

    getDragActor() {
        const size = Math.round(this.geometry.iconSize * this.waveScale);
        return this.app.create_icon_texture(size);
    }

    getDragActorSource() {
        return this._iconBin;
    }

    /**
     * Algo está sendo arrastado por cima do ícone.
     * - Arquivo vindo de uma Stack: "abrir com este app".
     * - Arquivo vindo de outro programa (Main.xdndHandler): no Wayland o
     *   Shell não recebe o arquivo, mas recebe o movimento. Então, como no
     *   Mac, se o cursor parar um tempo sobre o ícone, trazemos o app para
     *   a frente ("spring-loading") e o usuário solta direto na janela dele.
     */
    handleDragOver(source, _actor, _x, _y, _time) {
        if (source?.file)
            return DND.DragMotionResult.COPY_DROP;
        if (source === Main.xdndHandler) {
            if (!this._springLoad.active) {
                this._springLoad.start(SPRING_LOAD_MS, () => {
                    if (this.hover || this.dock.isPointerOver(this))
                        this.app.activate();
                });
            }
        }
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
        if (!source?.file)
            return false;
        const appInfo = this.app.get_app_info();
        if (!appInfo)
            return false;
        this.animateLaunch();
        const context = global.create_app_launch_context(0, -1);
        appInfo.launch([source.file], context);
        return true;
    }

    destroy() {
        this._attention.cancel();
        this._previewTimeout.cancel();
        this._springLoad.cancel();
        this._launching = false;
        this.app.disconnectObject(this);
        this.dock.manager.launcherEntry.disconnectObject(this);
        this.dock.manager.notificationCounter.disconnectObject(this);
        this.dock.settings.disconnectObject(this);
        super.destroy();
    }
});

/** Botão da grade de aplicativos (o "Launchpad" do Mac). */
export const ShowAppsItem = GObject.registerClass(
class OrlaShowAppsItem extends DockItem {
    _init(dock) {
        super._init(dock);
        this.key = 'show-apps';
        this.connect('clicked', () => {
            // Barras de tarefas: o Menu Iniciar (lib/start/).
            if (this.dock.toggleStartMenu())
                return;
            // Menu iniciar no lugar da App Grid: abre junto desta dock.
            if (this.dock.settings.get_boolean('start-menu-replace-grid')) {
                this.dock.manager.toggleStartMenu(this.dock);
                return;
            }
            if (Main.overview.visible && Main.overview.dash.showAppsButton.checked)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
    }

    get labelText() {
        return _('Applications');
    }

    /**
     * O ícone pode ser:
     *   - logo (padrão): o escolhido em apps-button-logo — o da Orla Dock
     *     (padrão), o de uma distro (icons/logos/) ou "Do sistema", que é o
     *     do /etc/os-release (LOGO=…) e mostra o Fedora no Fedora etc.;
     *   - grade: o ícone simbólico de grade, na cor escolhida;
     *   - bloco: a grade sobre um quadradinho colorido (estilo Launchpad);
     *   - imagem: um arquivo escolhido nas preferências.
     * A escala (%) vale para todos — útil para imagens com bordas vazias.
     */
    createIcon(size) {
        const s = this.dock.settings;
        const mode = s.get_enum('apps-button-icon');
        const iconSize = Math.round(size * s.get_int('apps-button-icon-scale') / 100);
        let icon, dim;

        if (mode === 3 && GLib.file_test(s.get_string('apps-button-custom-icon'), GLib.FileTest.EXISTS)) {
            icon = new St.Icon({
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(s.get_string('apps-button-custom-icon'))),
                icon_size: iconSize,
            });
            dim = iconSize;
        } else if (mode === 1) {
            icon = new St.Icon({
                icon_name: 'view-app-grid-symbolic',
                icon_size: Math.round(iconSize * 0.8),
                style: `color: ${s.get_string('apps-button-color')};`,
            });
            dim = Math.round(iconSize * 0.8);
        } else if (mode === 2) {
            icon = new St.Bin({
                style_class: 'orla-showapps-tile',
                style: `border-radius: ${Math.round(iconSize * 0.24)}px;`,
                width: Math.round(iconSize * 0.86),
                height: Math.round(iconSize * 0.86),
                child: new St.Icon({
                    icon_name: 'view-app-grid-symbolic',
                    icon_size: Math.round(iconSize * 0.48),
                    style_class: 'orla-showapps-icon',
                }),
            });
            dim = Math.round(iconSize * 0.86);
        } else {
            const path = logoPath(this.dock.manager.extensionPath, s.get_string('apps-button-logo'));
            const props = {
                fallback_icon_name: 'view-app-grid-symbolic',
                icon_size: Math.round(iconSize * 0.9),
            };
            if (path && GLib.file_test(path, GLib.FileTest.EXISTS))
                props.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
            else // "Do sistema": GLib.get_os_info lê o /etc/os-release (arquivo minúsculo).
                props.icon_name = GLib.get_os_info('LOGO') || 'start-here';
            icon = new St.Icon(props);
            dim = Math.round(iconSize * 0.9);
        }

        // Centraliza num contêiner do tamanho do item. Se a escala passar de
        // 100%, o ícone "vaza" para fora — de propósito (nada é cortado).
        const box = new Clutter.Actor({width: size, height: size});
        box.add_child(icon);
        // Usamos o tamanho que nós mesmos pedimos: perguntar ao St antes de
        // o ator estar na tela gera aviso crítico.
        icon.set_size(dim, dim);
        icon.set_position(Math.round((size - dim) / 2), Math.round((size - dim) / 2));
        return box;
    }
});

/**
 * Janela minimizada com "Minimizar janelas ao ícone do aplicativo"
 * DESLIGADO: como no Mac, cada janela minimizada ganha sua própria
 * miniatura viva, perto da lixeira.
 */
export const WindowItem = GObject.registerClass(
class OrlaWindowItem extends DockItem {
    _init(dock, metaWindow) {
        super._init(dock);
        this.metaWindow = metaWindow;
        this.app = Shell.WindowTracker.get_default().get_window_app(metaWindow);
        this.key = `win:${metaWindow.get_stable_sequence()}`;
        // Durante o Gênio a miniatura fica invisível; ela aparece (com fade)
        // quando a janela termina de "entrar" nela.
        this._thumbHidden = dock.manager.willAnimateMinimize(metaWindow);
        // Rede de segurança: se o Gênio não rodar, revela mesmo assim.
        this._revealFallback = new Timeout();
        if (this._thumbHidden) {
            const ms = dock.settings.get_int('minimize-duration') * St.Settings.get().slow_down_factor;
            this._revealFallback.start(ms + 400, () => this.revealThumbnail());
        }

        this.connect('clicked', () => {
            Main.overview.hide();
            Main.activateWindow(this.metaWindow);
        });
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY && this.app) {
                this.dock.openMenu(this, new AppMenu(this));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.metaWindow.connectObject(
            'notify::title', () => this.dock.onItemHoverChanged(this),
            // A janela mudou de tamanho: refaz a miniatura com a nova proporção.
            'size-changed', () => this.refreshIcon(),
            this);
    }

    get labelText() {
        return this.metaWindow.get_title() || this.app?.get_name() || '';
    }

    /** Usado pelo AppMenu; janelas minimizadas não "quicam". */
    animateLaunch() {
    }

    /**
     * A miniatura: a janela ao vivo (um Clutter.Clone dela) encaixada na
     * célula, e o ícone do app num selo no canto.
     *
     * A imagem da janela (o "buffer") é maior que a janela em si: inclui as
     * sombras em volta. Por isso o clone fica dentro de uma moldura do
     * tamanho do QUADRO da janela, que recorta as sombras.
     */
    createIcon(size) {
        const box = new Clutter.Actor({width: size, height: size});
        const live = this.metaWindow.get_compositor_private();
        const frame = this.metaWindow.get_frame_rect();
        const buffer = this.metaWindow.get_buffer_rect();
        if (live && frame.width > 0 && frame.height > 0) {
            const room = size * (1 - 2 * THUMB_MARGIN);
            const k = Math.min(room / frame.width, room / frame.height);
            const width = Math.round(frame.width * k);
            const height = Math.round(frame.height * k);
            this._frame = new Clutter.Actor({
                x: Math.round((size - width) / 2),
                y: Math.round((size - height) / 2),
                width, height,
                clip_to_allocation: true,
                opacity: this._thumbHidden ? 0 : 255,
            });
            this._frame.add_child(new Clutter.Clone({
                source: live,
                // Desloca o buffer para o canto do quadro cair no (0, 0).
                x: (buffer.x - frame.x) * k,
                y: (buffer.y - frame.y) * k,
                width: buffer.width * k,
                height: buffer.height * k,
            }));
            box.add_child(this._frame);
        }
        if (this.app) {
            const seal = Math.round(size * SEAL_SIZE);
            const badge = new St.Bin({
                style_class: 'orla-window-seal',
                width: seal, height: seal,
                x: size - seal, y: size - seal,
                child: this.app.create_icon_texture(Math.round(seal * 0.8)),
            });
            box.add_child(badge);
        }
        return box;
    }

    /**
     * A janela foi restaurada: a miniatura some NA HORA, para
     * não haver duas cópias da janela enquanto o espaço dela encolhe.
     */
    hideThumbnail() {
        this._revealFallback.cancel();
        this._thumbHidden = true;
        if (this._frame) {
            this._frame.remove_all_transitions();
            this._frame.opacity = 0;
        }
    }

    /** Fim do Gênio: a miniatura surge suavemente. */
    revealThumbnail() {
        this._revealFallback.cancel();
        if (!this._thumbHidden)
            return;
        this._thumbHidden = false;
        this._frame?.remove_all_transitions();
        this._frame?.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    destroy() {
        this._revealFallback.cancel();
        this.metaWindow.disconnectObject(this);
        super.destroy();
    }
});

export {makeItemDraggable};
