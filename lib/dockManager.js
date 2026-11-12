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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppIcon, WindowItem} from './appIcon.js';
import {AppTracker} from './appTracker.js';
import {isCalendarApp, todayKey} from './calendarIcon.js';
import {Autohide} from './autohide.js';
import {Dock} from './dock.js';
import {LauncherEntry} from './launcherEntry.js';
import {MinimizeEffects} from './minimizeEffects.js';
import {downloadsUri} from './stacks.js';
import {IdleRunner, Position} from './utils.js';
import {WallpaperColor} from './wallpaperColor.js';

const SHORTCUT_KEY = 'orla-toggle-autohide';

// Quais chaves exigem o quê.
const RECREATE_KEYS = ['position', 'multi-monitor', 'layout-mode', 'taskbar-clock'];
const RELAYOUT_KEYS = [
    'icon-size', 'taskbar-icon-size', 'magnification', 'dock-margin', 'icon-reflection',
    'icon-spacing', 'dock-padding', 'indicator-size', 'show-indicators',
];
const ITEMS_KEYS = ['show-apps-button', 'show-trash', 'show-downloads', 'stack-folders', 'minimize-to-app'];
const STYLE_KEYS = [
    'background-opacity', 'blur-radius', 'corner-radius', 'theme', 'background-color',
    'use-gradient', 'gradient-color', 'gradient-direction', 'border-width', 'border-color',
    'border-opacity', 'blur-brightness', 'blur-vibrancy', 'glass-glow', 'indicator-style',
    'indicator-color-mode', 'indicator-color', 'indicator-glow', 'badge-color-mode',
    'badge-color', 'popup-opacity', 'separator-thickness', 'separator-length',
    'separator-color', 'separator-opacity', 'show-indicators', 'indicator-size',
];
const APPS_BUTTON_KEYS = ['apps-button-icon', 'apps-button-color', 'apps-button-custom-icon', 'apps-button-icon-scale'];

export class DockManager {
    constructor(extension) {
        this._extension = extension;
        this.settings = extension.getSettings();
        this._docks = [];
        this._watchedWindows = new Set();
        this._minimizeStamps = new Map();   // janela → ordem em que minimizou
        this._minimizeCounter = 0;

        this.appTracker = new AppTracker(this.settings);
        this.launcherEntry = new LauncherEntry();
        this.minimizeEffects = new MinimizeEffects(this.settings);
        // Fim do Gênio: revela a miniatura da janela (se houver).
        this.minimizeEffects.onFinished = actor => this._revealThumbnail(actor.meta_window);
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
        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => {
            if (todayKey() !== this._today) {
                this._today = todayKey();
                this._refreshCalendarIcons();
            }
        }, this);

        this._createDocks();
        this._syncOverviewDash();
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
        this.appTracker.disconnectObject(this);
        this.settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        this.wallpaperColor.disconnectObject(this);
        this.wallpaperColor.destroy();

        this.minimizeEffects.destroy();
        this.launcherEntry.destroy();
        this.appTracker.destroy();
        this.settings = null;
    }

    // ---------- Docks ----------

    _createDocks() {
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
        if (key === 'dynamic-calendar-icon')
            this._refreshCalendarIcons();
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

    getStackUris() {
        const uris = [];
        if (this.settings.get_boolean('show-downloads'))
            uris.push(downloadsUri());
        for (const uri of this.settings.get_strv('stack-folders')) {
            if (!uris.includes(uri))
                uris.push(uri);
        }
        return uris;
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
            .filter(w => w.minimized && !w.skip_taskbar &&
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

    _onMinimizedChanged(win) {
        if (win.minimized)
            this._minimizeStamps.set(win, ++this._minimizeCounter);
        if (this.settings.get_boolean('minimize-to-app'))
            return;
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
