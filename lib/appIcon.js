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
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppMenu} from './appMenu.js';
import {getAppWindows} from './appTracker.js';
import {DockItem} from './dockItem.js';
import {Timeout} from './utils.js';

const LAUNCH_TIMEOUT_US = 8 * GLib.USEC_PER_SEC;
const ATTENTION_MAX_ROUNDS = 12;
const PREVIEW_DELAY_MS = 650;
const SPRING_LOAD_MS = 700;

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
        dock.settings.connectObject(
            'changed::show-indicators', () => this._sync(),
            'changed::show-badges', () => this._syncBadge(),
            this);

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
        return this.app.create_icon_texture(size);
    }

    onBinSizeChanged(binSize) {
        // Tamanhos relativos ao _iconBin (que está no tamanho ampliado).
        const badge = Math.round(binSize * 0.36);
        this._badge.set_style(`font-size: ${Math.round(binSize * 0.2)}px;` +
            `min-width: ${badge}px; height: ${badge}px; border-radius: ${badge}px;`);
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

    _sync() {
        const running = this.app.state !== Shell.AppState.STOPPED;
        this.setIndicatorVisible(running && this.dock.settings.get_boolean('show-indicators'));
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
        const focusApp = Shell.WindowTracker.get_default().focus_app;

        if (this.app.state === Shell.AppState.STOPPED || windows.length === 0) {
            // Não está aberto (ou está aberto sem janela): abre/ativa.
            this.animateLaunch();
            this.app.activate();
        } else if (focusApp === this.app) {
            // Já está em foco: com várias janelas, alterna entre elas;
            // com uma só, minimiza (e ela "entra" no ícone).
            if (windows.length > 1)
                this._cycleWindows(windows, 1);
            else
                windows[0].minimize();
        } else {
            // Aberto, mas em segundo plano: traz para a frente.
            // activate() levanta todas as janelas do app, como no Mac.
            this.app.activate();
        }
    }

    _openNewWindow() {
        if (this.app.can_open_new_window()) {
            this.animateLaunch();
            this.app.open_new_window(-1);
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
        if (!this.dock.settings.get_boolean('animate-launch') || this._launching)
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
        const entry = this.dock.manager.launcherEntry.get(this.app.get_id());
        const enabled = this.dock.settings.get_boolean('show-badges') &&
            this.app.state !== Shell.AppState.STOPPED;

        const count = entry?.count ?? 0;
        this._badge.visible = enabled && Boolean(entry?.countVisible) && count > 0;
        this._badge.text = count > 99 ? '99+' : `${count}`;

        const progress = Math.min(1, Math.max(0, entry?.progress ?? 0));
        this._progress.visible = enabled && Boolean(entry?.progressVisible);
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
            if (Main.overview.visible && Main.overview.dash.showAppsButton.checked)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
    }

    get labelText() {
        return _('Applications');
    }

    createIcon(size) {
        const tile = new St.Bin({
            style_class: 'orla-showapps-tile',
            style: `border-radius: ${Math.round(size * 0.24)}px;`,
            child: new St.Icon({
                icon_name: 'view-app-grid-symbolic',
                icon_size: Math.round(size * 0.52),
                style_class: 'orla-showapps-icon',
            }),
        });
        // Margem interna para o "quadradinho" ter o mesmo tamanho visual dos
        // ícones de apps (que costumam ter ~6% de respiro nas bordas).
        tile.set_style(`${tile.style} margin: ${Math.round(size * 0.07)}px;`);
        return tile;
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
        this.key = `win:${metaWindow.get_stable_sequence()}`;
        this.connect('clicked', () => Main.activateWindow(this.metaWindow));
        this.metaWindow.connectObject('notify::title', () => this.dock.onItemHoverChanged(this), this);
    }

    get labelText() {
        return this.metaWindow.get_title();
    }

    createIcon(size) {
        const box = new Clutter.Actor({width: size, height: size});
        const windowActor = this.metaWindow.get_compositor_private();
        if (windowActor) {
            // Clutter.Clone desenha a janela "ao vivo", sem copiar a imagem.
            const [w, h] = windowActor.get_size();
            const scale = Math.min(size / w, size / h) * 0.92;
            const clone = new Clutter.Clone({
                source: windowActor,
                width: Math.round(w * scale),
                height: Math.round(h * scale),
            });
            clone.set_position(Math.round((size - clone.width) / 2),
                Math.round((size - clone.height) / 2));
            box.add_child(clone);
        }
        const app = Shell.WindowTracker.get_default().get_window_app(this.metaWindow);
        if (app) {
            const badgeSize = Math.round(size * 0.42);
            const icon = app.create_icon_texture(badgeSize);
            icon.set_position(size - badgeSize, size - badgeSize);
            box.add_child(icon);
        }
        return box;
    }

    destroy() {
        this.metaWindow.disconnectObject(this);
        super.destroy();
    }
});

export {makeItemDraggable};
