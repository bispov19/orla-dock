// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// dockManager.js — o "gerente": cria uma dock por monitor e guarda os
// serviços compartilhados entre elas (modelo de apps, contadores D-Bus,
// efeitos de minimizar, atalho de teclado…).
//
// Também reage a mudanças globais:
//   - monitores conectados/desconectados → recria as docks;
//   - opções do GSettings → aplica na hora (sem reiniciar nada);
//   - tema claro/escuro do sistema → troca as cores.

import Gio from 'gi://Gio';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppIcon, WindowItem} from './appIcon.js';
import {AppTracker} from './appTracker.js';
import {iconThemeRoot, isCalendarApp, releaseCalendarCaches, themeCalendarFile, todayKey} from './calendarIcon.js';
import {Autohide} from './autohide.js';
import {Dock} from './dock.js';
import {LauncherEntry} from './launcherEntry.js';
import {resetDisposedActors} from './luma/core/ActorState.js';
import {unbindSettings} from './luma/core/SettingsManager.js';
import {destroyUtils as destroyLumaUtils} from './luma/core/Utils.js';
import {MaximizeWatcher} from './maximizeWatcher.js';
import {MinimizeEffects} from './minimizeEffects.js';
import {NotificationCounter} from './notificationCounter.js';
import {mountKey} from './mounts.js';
import {PLACES, placeUri} from './stacks.js';
import {STYLES} from './styles.js';
import {cancelAllLater, IdleRunner, Position, Timeout} from './utils.js';
import {isHiddenWindow, setHiddenPatterns} from './windowFilter.js';
import {WallpaperColor} from './wallpaperColor.js';
import {WindowMotionWatcher} from './windowMotion.js';

const SHORTCUT_KEY = 'orla-toggle-autohide';

// Quais chaves exigem o quê.
const RECREATE_KEYS = ['position', 'multi-monitor', 'bar-style', 'taskbar-clock', 'taskbar-merge-panel'];
const RELAYOUT_KEYS = [
    'icon-size', 'taskbar-icon-size', 'magnification', 'dock-margin', 'icon-reflection',
    'icon-spacing', 'dock-padding', 'indicator-size', 'show-indicators',
];
const ITEMS_KEYS = [
    'show-apps-button', 'apps-button-separator', 'show-trash', 'stack-folders', 'minimize-to-app', 'show-mounts',
    ...PLACES.map(place => place.key),
];
const STYLE_KEYS = [
    'background-opacity', 'corner-radius', 'theme', 'background-color',
    'use-gradient', 'gradient-color', 'gradient-direction', 'border-width', 'border-color',
    'border-opacity', 'indicator-style',
    'indicator-color-mode', 'indicator-color', 'indicator-glow', 'badge-color-mode',
    'badge-color', 'popup-opacity', 'separator-thickness', 'separator-length',
    'separator-color', 'separator-opacity', 'show-indicators', 'indicator-size',
    // vidro
    'blur-enabled', 'blur-mode', 'blur-static-source', 'blur-static-preset',
    'blur-custom-photo', 'blur-intensity', 'blur-vibrancy', 'blur-brightness',
    'blur-tint-color', 'blur-tint-opacity', 'blur-border-glow', 'blur-highlight-angle',
];
const APPS_BUTTON_KEYS = ['apps-button-icon', 'apps-button-logo', 'apps-button-color', 'apps-button-custom-icon', 'apps-button-icon-scale'];

/**
 * A antiga chave booleana dynamic-calendar-icon virou calendar-icon-style.
 * Quem tinha desligado a data no ícone passa a seguir o tema de ícones.
 */
function migrateCalendarSetting(settings) {
    if (settings.get_user_value('dynamic-calendar-icon') === null)
        return;
    if (!settings.get_boolean('dynamic-calendar-icon') &&
        settings.get_user_value('calendar-icon-style') === null)
        settings.set_string('calendar-icon-style', 'theme');
    settings.reset('dynamic-calendar-icon');
}

/**
 * Estilo de barra salvo que não existe mais (ex.: a barra de tarefas do
 * Windows 7, removida): volta para a dock do macOS em vez de quebrar.
 */
function migrateBarStyle(settings) {
    const id = settings.get_string('bar-style');
    if (!STYLES.some(style => style.id === id))
        settings.set_string('bar-style', 'dock');
}

export class DockManager {
    constructor(extension) {
        this._extension = extension;
        this.extensionPath = extension.path;
        this.settings = extension.getSettings();
        migrateCalendarSetting(this.settings);
        migrateBarStyle(this.settings);
        // PRIMEIRA coisa: esconder o Dash do GNOME/Fedora. No login a Visão
        // Geral já está animando enquanto as extensões ligam; quanto antes
        // escondermos, menos ele aparece. (A altura é acertada no fim.)
        this._docks = [];
        this._syncOverviewDash();
        setHiddenPatterns(this.settings.get_string('ignored-window-classes'));
        this._watchedWindows = new Set();
        this._minimizeStamps = new Map();   // janela → ordem em que minimizou
        this._minimizeCounter = 0;

        this.appTracker = new AppTracker(this.settings);
        this.launcherEntry = new LauncherEntry();
        // Notificações do GNOME por app (bolinhas nos ícones, como na Luma).
        this.notificationCounter = new NotificationCounter();
        // Janela maximizada no monitor → a dock pode encostar na borda.
        this.maximizeWatcher = new MaximizeWatcher(
            () => this._docks.forEach(d => d.syncHug()),
            // De que lado fica a dock deste monitor (para conferir se as
            // janelas maximizadas chegam até ela).
            monitor => this._docks.find(d => d.monitorIndex === monitor)?.axis.position ?? null);
        this.minimizeEffects = new MinimizeEffects(this.settings);
        // Fim do Gênio: revela a miniatura da janela (se houver).
        this.minimizeEffects.onFinished = actor => this._revealThumbnail(actor.meta_window);
        // O Gênio pergunta a cada quadro onde está o ícone de destino.
        this.minimizeEffects.iconTracker = win => this._iconTracker(win);
        this._iconGeometry = new IdleRunner(() => this._updateIconGeometry());

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.wallpaperColor = new WallpaperColor(() => this.darkMode);
        this.wallpaperColor.connectObject('changed', () => this._syncStyleAll(), this);
        this._interfaceSettings.connectObject(
            'changed::color-scheme', () => {
                this.wallpaperColor.refresh();
                this._syncStyleAll();
            },
            'changed::accent-color', () => this._syncStyleAll(),
            this);

        this.settings.connectObject('changed', (_s, key) => this._onSettingChanged(key), this);
        this.appTracker.connectObject('changed', () => this._rebuildAll(), this);

        // Pendrives e outras unidades: aparecem/somem em tempo real.
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._volumeMonitor.connectObject(
            'mount-added', (_m, mount) => this._onMountAdded(mount),
            'mount-removed', () => this._rebuildAll(),
            'mount-changed', () => this._rebuildAll(),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._recreateDocks(),
            // No login, reaplica quando o Shell termina de iniciar.
            'startup-complete', () => this._syncOverviewDash(),
            this);

        // Janelas pedindo atenção → o ícone quica.
        global.display.connectObject(
            'window-demands-attention', (_d, win) => this._onAttention(win),
            'window-marked-urgent', (_d, win) => this._onAttention(win),
            'window-created', (_d, win) => this._watchWindow(win),
            this);
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);

        // Arrastes vindos de fora da dock: grade de apps do GNOME e arquivos
        // de outros programas (Xdnd).
        Main.overview.connectObject(
            'item-drag-begin', () => this._docks.forEach(d => d.onExternalDragBegin()),
            'item-drag-end', () => this._docks.forEach(d => d.onExternalDragEnd()),
            'item-drag-cancelled', () => this._docks.forEach(d => d.onExternalDragEnd()),
            this);
        Main.xdndHandler.connectObject(
            'drag-begin', () => this._docks.forEach(d => d.onExternalDragBegin()),
            'drag-end', () => this._docks.forEach(d => d.onExternalDragEnd()),
            this);

        // Atalho de teclado (padrão Super+Alt+D) para ligar/desligar o
        // auto-ocultar. ActionMode diz em que situações o atalho vale.
        Main.wm.addKeybinding(SHORTCUT_KEY, this.settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => Autohide.toggle(this.settings));

        // Quando o dia vira, o ícone do Calendário é redesenhado.
        // WallClock avisa a cada minuto; só agimos se a data mudou.
        this._today = todayKey();
        this._calendarRetry = new Timeout();
        this._calendarDebounce = new Timeout();
        this._calendarMonitors = [];
        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => {
            if (todayKey() !== this._today) {
                this._today = todayKey();
                this._refreshCalendarIcons();
                // Temas que atualizam a data (como o Brisa) regravam o ícone
                // logo depois da meia-noite: confere de novo um pouco depois.
                this._calendarRetry.start(90 * 1000, () => this._refreshCalendarIcons());
            }
        }, this);
        // Trocou o tema de ícones: o ícone do Calendário e o que vigiar mudam.
        St.TextureCache.get_default().connectObject('icon-theme-changed', () => {
            this._watchThemeCalendar();
            this._refreshCalendarIcons();
        }, this);
        this._watchThemeCalendar();

        // Com "session-modes": ["user", "unlock-dialog"] no metadata.json, a
        // Orla NÃO é desligada ao bloquear a tela (senão o Dash do Fedora
        // voltaria e apareceria ao desbloquear). Em troca, enquanto a tela
        // está bloqueada a dock não existe; ela volta ao desbloquear.
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);

        // Janela passando por trás da dock (arrastando, balançando, animando):
        // o vidro dinâmico é refeito inteiro a cada quadro, senão fica um
        // rastro de vidro no caminho dela. Ver windowMotion.js.
        this._windowMotion = new WindowMotionWatcher(
            () => this._docks.forEach(d => d.queueGlassRedraw()));

        this._createDocks();
        this._syncOverviewDash();
    }

    _syncSessionMode() {
        if (Main.sessionMode.isLocked)
            this._destroyDocks();
        else if (this._docks.length === 0)
            this._createDocks();
        this._syncOverviewDash();
    }

    /**
     * No modo "seguir o tema", vigia o ícone do Calendário do tema: quando o
     * tema o regrava (o Brisa troca a data à meia-noite), a Dock recarrega.
     * Vigia a pasta do ícone (tema que regrava o arquivo) e a pasta dos temas
     * (tema que troca a própria pasta de uma vez).
     */
    _watchThemeCalendar() {
        this._calendarMonitors.forEach(m => m.cancel());
        this._calendarMonitors = [];
        if (this.settings.get_string('calendar-icon-style') !== 'theme')
            return;
        const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
        const path = themeCalendarFile(app);
        const root = iconThemeRoot(path);
        if (!path || !root)
            return;
        for (const dir of [Gio.File.new_for_path(path).get_parent(), root.get_parent()]) {
            try {
                const monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                monitor.connect('changed', () => this._calendarDebounce.start(2000, () => {
                    this._watchThemeCalendar();
                    this._refreshCalendarIcons();
                }));
                this._calendarMonitors.push(monitor);
            } catch {}
        }
    }

    _refreshCalendarIcons() {
        for (const dock of this._docks) {
            for (const item of dock.getItems()) {
                if (item.app && isCalendarApp(item.app))
                    item.refreshIcon();
            }
        }
    }

    destroy() {
        Main.wm.removeKeybinding(SHORTCUT_KEY);
        this._wallClock.disconnectObject(this);
        this._wallClock = null;
        St.TextureCache.get_default().disconnectObject(this);
        this._calendarRetry.cancel();
        this._calendarDebounce.cancel();
        this._calendarMonitors.forEach(m => m.cancel());
        this._calendarMonitors = [];
        this._iconGeometry.cancel();
        this._destroyDocks();
        this._restoreOverviewDash();
        this._resetIconGeometry();

        for (const win of this._watchedWindows)
            win.disconnectObject(this);
        this._watchedWindows.clear();

        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.xdndHandler.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this.appTracker.disconnectObject(this);
        this._volumeMonitor.disconnectObject(this);
        this.settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        setHiddenPatterns('');
        this.wallpaperColor.disconnectObject(this);
        this.wallpaperColor.destroy();

        this._windowMotion.destroy();
        this.minimizeEffects.destroy();
        this.launcherEntry.destroy();
        this.notificationCounter.destroy();
        this.maximizeWatcher.destroy();
        // Os módulos da Luma (barras de tarefas) param de ler as configurações.
        unbindSettings();
        // Nada pode sobrar entre um disable() e o próximo enable(): ações de
        // menu ainda na fila e os caches de módulo (calendário e Luma).
        cancelAllLater();
        releaseCalendarCaches();
        destroyLumaUtils();
        resetDisposedActors();
        this.appTracker.destroy();
        this.settings = null;
    }

    // ---------- Docks ----------

    _createDocks() {
        if (Main.sessionMode.isLocked)
            return;
        const multi = this.settings.get_boolean('multi-monitor');
        const monitors = Main.layoutManager.monitors;
        const primary = Main.layoutManager.primaryIndex;
        for (let i = 0; i < monitors.length; i++) {
            if (multi || i === primary)
                this._docks.push(new Dock(this, i));
        }
        this.queueIconGeometry();
    }

    _destroyDocks() {
        this._docks.forEach(dock => dock.destroy());
        this._docks = [];
    }

    _recreateDocks() {
        this._destroyDocks();
        this._createDocks();
        this._syncOverviewDash();
    }

    _rebuildAll() {
        this._docks.forEach(dock => dock.rebuild());
    }

    get docks() {
        return this._docks;
    }

    _onSettingChanged(key) {
        if (RECREATE_KEYS.includes(key)) {
            this._recreateDocks();
            return;
        }
        // Uma chave pode pedir estilo E layout (ex.: tamanho do indicador).
        if (STYLE_KEYS.includes(key))
            this._syncStyleAll();
        if (RELAYOUT_KEYS.includes(key)) {
            this._docks.forEach(dock => dock.relayout());
            this._syncOverviewDash();
        }
        if (ITEMS_KEYS.includes(key)) {
            this._rebuildAll();
            this.queueIconGeometry();
        }
        if (APPS_BUTTON_KEYS.includes(key))
            this._docks.forEach(dock => dock.findItem('show-apps')?.refreshIcon());
        if (key === 'hide-overview-dash')
            this._syncOverviewDash();
        if (key === 'ignored-window-classes') {
            setHiddenPatterns(this.settings.get_string(key));
            this._rebuildAll();
            // Os indicadores/contagens de janelas dos apps também mudam.
            this._docks.forEach(dock => dock.getItems().forEach(item => item._sync?.()));
        }
        if (key === 'calendar-icon-style') {
            this._watchThemeCalendar();
            this._refreshCalendarIcons();
        }
        if (key === 'trash-icon-style')
            this._docks.forEach(dock => dock.getItems().forEach(item => item.key === 'trash' && item.refreshIcon()));
        // Muda também a reserva de espaço: o relayout refaz as duas coisas.
        if (key === 'hug-edge-when-maximized')
            this._docks.forEach(dock => dock.relayout());
    }

    /** Abre a janela de preferências da extensão. */
    openPreferences() {
        this._extension.openPreferences();
    }

    _syncStyleAll() {
        this._docks.forEach(dock => dock.syncStyle());
    }

    /** Cor de destaque do sistema (GNOME 47+): 'blue', 'purple'… */
    get accentName() {
        try {
            return this._interfaceSettings.get_string('accent-color');
        } catch {
            return 'blue';
        }
    }

    /** Segue o "Estilo" do sistema (Configurações → Aparência), como no Mac. */
    get darkMode() {
        return this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
    }

    /** Locais ligados (Pasta pessoal, Downloads, Documentos…), na ordem da Luma. */
    getPlaceUris() {
        return PLACES.filter(place => this.settings.get_boolean(place.key)).map(placeUri);
    }

    /** Pastas extras escolhidas nas preferências (sem repetir os Locais). */
    getCustomFolderUris() {
        const places = PLACES.map(placeUri);
        return [...new Set(this.settings.get_strv('stack-folders'))]
            .filter(uri => !places.includes(uri));
    }

    /** Unidades montadas agora (pendrives, HDs externos, rede). */
    getMounts() {
        if (!this.settings.get_boolean('show-mounts'))
            return [];
        // is_shadowed(): unidades "escondidas" atrás de outra (o próprio GIO
        // recomenda não mostrá-las).
        return this._volumeMonitor.get_mounts().filter(mount => !mount.is_shadowed());
    }

    _onMountAdded(mount) {
        this._rebuildAll();
        // Como na Luma: a unidade nova "chama atenção" com um quique.
        if (this.settings.get_boolean('show-mounts')) {
            for (const dock of this._docks) {
                const item = dock.findItem(mountKey(mount));
                if (item?.geometry)
                    item.bounce({height: item.geometry.iconSize * 0.5, duration: 500, times: 2});
            }
        }
    }

    // ---------- Dash da Visão Geral ----------
    //
    // Escondemos o Dash nativo e ajustamos a altura reservada para ele:
    // com a dock embaixo, a Visão Geral continua deixando espaço para a
    // Orla (que fica visível por cima); nas outras posições, nada é reservado.

    _syncOverviewDash() {
        const dash = Main.overview.dash;
        if (!this.settings.get_boolean('hide-overview-dash')) {
            this._restoreOverviewDash();
            return;
        }
        if (!this._dashHidden) {
            this._dashHidden = true;
            // Outras extensões (ex.: Just Perfection com "Dash" ligado) podem
            // mostrar o Dash de novo depois de nós — inclusive no login, se
            // forem ligadas depois da Orla. Vigiamos e escondemos outra vez.
            dash.connectObject('notify::visible', () => {
                if (this._dashHidden && dash.visible)
                    dash.hide();
            }, this);
        }
        dash.hide();
        const dock = this._docks.find(d => d.monitorIndex === Main.layoutManager.primaryIndex);
        const g = dock?.geometry;
        const bottom = this.settings.get_enum('position') === Position.BOTTOM;
        dash.set_height(bottom && g ? g.thickness + g.margin : 0);
    }

    _restoreOverviewDash() {
        if (!this._dashHidden)
            return;
        this._dashHidden = false;
        const dash = Main.overview.dash;
        dash.disconnectObject(this);
        dash.set_height(-1);
        dash.show();
    }

    // ---------- Janelas ----------

    _watchWindow(win) {
        if (!win || this._watchedWindows.has(win))
            return;
        this._watchedWindows.add(win);
        win.connectObject(
            'notify::minimized', () => this._onMinimizedChanged(win),
            // No Wayland a classe pode chegar depois da janela: aí ela pode
            // deixar (ou passar) de ser uma "janela oculta".
            'notify::wm-class', () => this.appTracker.queueChanged(),
            'shown', () => this.appTracker.queueChanged(),
            'unmanaged', () => {
                win.disconnectObject(this);
                this._watchedWindows.delete(win);
                this._minimizeStamps.delete(win);
                if (!this.settings.get_boolean('minimize-to-app'))
                    this._rebuildAll();
            },
            this);
    }

    getMinimizedWindows() {
        const stamp = w => this._minimizeStamps.get(w) ?? 0;
        return [...this._watchedWindows]
            .filter(w => w.minimized && !w.skip_taskbar && !isHiddenWindow(w) &&
                w.get_window_type() === Meta.WindowType.NORMAL)
            .sort((a, b) => stamp(a) - stamp(b));
    }

    /** O Gênio vai animar o minimizar desta janela? */
    willAnimateMinimize(win) {
        return this.minimizeEffects.isAnimating(win) ||
            (this._justMinimized === win && this.settings.get_enum('minimize-effect') === 0);
    }

    _revealThumbnail(win) {
        for (const dock of this._docks)
            dock.findItem(`win:${win.get_stable_sequence()}`)?.revealThumbnail?.();
    }

    /**
     * Devolve uma função que diz, quando chamada, o retângulo atual do
     * destino da janela: a miniatura dela (se houver) ou o ícone do app.
     * Se o destino está saindo da dock (miniatura de uma janela que acabou
     * de ser restaurada), fica valendo o último retângulo conhecido.
     */
    _iconTracker(win) {
        let last = null;
        let fromThumbnail = false;
        return () => {
            const dock = this._dockForWindow(win);
            if (!dock)
                return last;
            const thumbnail = dock.findItem(`win:${win.get_stable_sequence()}`);
            // A janela saiu da miniatura e ela já foi embora: não troca de
            // alvo no meio do caminho (iria para o ícone do app).
            if (!thumbnail && fromThumbnail && last)
                return last;
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            const item = thumbnail ?? (app ? dock.findItem(`app:${app.get_id()}`) : null);
            if (item && (!item.removing || !last)) {
                last = item.getLiveIconRect() ?? last;
                fromThumbnail = item === thumbnail;
            }
            return last;
        };
    }

    _onMinimizedChanged(win) {
        if (win.minimized)
            this._minimizeStamps.set(win, ++this._minimizeCounter);
        if (this.settings.get_boolean('minimize-to-app'))
            return;
        if (!win.minimized) {
            for (const dock of this._docks)
                dock.findItem(`win:${win.get_stable_sequence()}`)?.hideThumbnail?.();
        }
        this._justMinimized = win.minimized ? win : null;
        // Síncrono de propósito: o item da janela precisa existir ANTES de o
        // Shell ler a geometria do ícone para animar o minimizar.
        this._rebuildAll();
        this._updateIconGeometry();
    }

    _onAttention(win) {
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app)
            return;
        for (const dock of this._docks)
            dock.findItem(`app:${app.get_id()}`)?.requestAttention?.();
    }

    // ---------- Geometria do ícone (para onde a janela minimiza) ----------

    queueIconGeometry() {
        this._iconGeometry.queue();
    }

    _dockForWindow(win) {
        return this._docks.find(d => d.monitorIndex === win.get_monitor()) ??
            this._docks.find(d => d.monitorIndex === Main.layoutManager.primaryIndex) ??
            this._docks[0];
    }

    _updateIconGeometry() {
        for (const dock of this._docks) {
            for (const item of dock.getItems()) {
                if (!(item instanceof AppIcon) && !(item instanceof WindowItem))
                    continue;
                const rect = dock.getItemIconRect(item);
                if (!rect)
                    continue;
                const mtkRect = new Mtk.Rectangle({
                    x: Math.round(rect.x), y: Math.round(rect.y),
                    width: Math.round(rect.width), height: Math.round(rect.height),
                });
                const windows = item instanceof WindowItem
                    ? [item.metaWindow] : item.app.get_windows();
                for (const win of windows) {
                    if (this._dockForWindow(win) === dock)
                        win.set_icon_geometry(mtkRect);
                }
            }
        }
    }

    _resetIconGeometry() {
        for (const actor of global.get_window_actors())
            actor.meta_window.set_icon_geometry(null);
    }
}
