// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// appMenu.js — menu de contexto (botão direito) de um app na dock.
//
// Usamos o PopupMenu do próprio GNOME Shell: é o mesmo componente dos menus
// do painel superior, então herda o tema (WhiteSur etc.) automaticamente.
// O "balãozinho" com setinha apontando para o ícone é o BoxPointer.
//
// As "ações do app" vêm do arquivo .desktop do aplicativo — por exemplo, o
// Firefox declara [Desktop Action new-private-window] → "Nova janela
// privada". Lemos essas ações com Gio.DesktopAppInfo.list_actions().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getAppWindows} from './appTracker.js';

export class AppMenu extends PopupMenu.PopupMenu {
    constructor(appIcon) {
        super(appIcon, 0.5, appIcon.dock.axis.side);
        this.actor.add_style_class_name('orla-menu');
        this._appIcon = appIcon;
        this._build();
    }

    _build() {
        const icon = this._appIcon;
        const app = icon.app;
        const tracker = icon.dock.manager.appTracker;
        const windows = getAppWindows(app);
        const running = app.state !== Shell.AppState.STOPPED;

        // --- Janelas abertas ---
        if (windows.length > 0) {
            const focused = global.display.focus_window;
            for (const win of windows) {
                const item = this.addAction(win.get_title() || app.get_name(),
                    () => Main.activateWindow(win));
                item.setOrnament(win === focused
                    ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
                item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                item.label.style = 'max-width: 28em;';
            }
            this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // --- Ações do .desktop + Nova janela ---
        const appInfo = app.get_app_info();
        const actions = appInfo?.list_actions() ?? [];
        if (app.can_open_new_window() && !actions.includes('new-window')) {
            this.addAction(_('New Window'), () => {
                icon.animateLaunch();
                app.open_new_window(-1);
            });
        }
        for (const action of actions) {
            this.addAction(appInfo.get_action_name(action), () => {
                icon.animateLaunch();
                app.launch_action(action, global.get_current_time(), -1);
            });
        }
        if (actions.length > 0 || app.can_open_new_window())
            this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Opções ---
        const options = new PopupMenu.PopupSubMenuMenuItem(_('Options'));
        this.addMenuItem(options);
        if (appInfo) {
            const pinned = tracker.isPinned(app);
            const keep = options.menu.addAction(_('Keep in Dock'), () => {
                if (pinned)
                    tracker.unpin(app.get_id());
                else
                    tracker.pin(app.get_id());
            });
            keep.setOrnament(pinned ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        const software = Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop');
        if (software && appInfo) {
            options.menu.addAction(_('App Details'), () => openAppDetails(app));
        }

        // --- Janelas / Encerrar ---
        if (windows.length > 0) {
            this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.addAction(_('Show All Windows'), () => icon.dock.showPreviews(icon, true));
            this.addAction(_('Hide'), () => windows.forEach(w => w.minimize()));
            if (windows.length > 1) {
                this.addAction(_('Close All Windows'), () => {
                    const time = global.get_current_time();
                    windows.forEach(w => w.delete(time));
                });
            }
        }
        if (running) {
            if (windows.length === 0)
                this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.addAction(_('Quit'), () => app.request_quit());
        }
    }
}

/** Menu genérico (usado por stacks e lixeira): lista de [rótulo, callback]. */
export class SimpleMenu extends PopupMenu.PopupMenu {
    constructor(item, entries) {
        super(item, 0.5, item.dock.axis.side);
        this.actor.add_style_class_name('orla-menu');
        for (const entry of entries) {
            if (entry === null) {
                this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }
            const {label, callback, sensitive = true, ornament} = entry;
            const menuItem = this.addAction(label, callback);
            menuItem.setSensitive(sensitive);
            if (ornament !== undefined)
                menuItem.setOrnament(ornament);
        }
    }
}

/**
 * Abre a página do app no GNOME Software. Ele exporta "ações" (GAction) no
 * D-Bus; chamamos a ação 'details' com o ID do app.
 */
function openAppDetails(app) {
    const params = new GLib.Variant('(ss)', [app.get_id(), '']);
    Gio.DBus.session.call(
        'org.gnome.Software', '/org/gnome/Software', 'org.gtk.Actions', 'Activate',
        new GLib.Variant('(sava{sv})', ['details', [params], {}]),
        null, Gio.DBusCallFlags.NONE, -1, null, null);
}

/**
 * Roda `fn` no próximo momento ocioso. Mudar posição/estilo RECRIA a dock
 * (e este menu); fazer isso dentro do clique destruiria o menu enquanto ele
 * ainda está terminando de processar o clique.
 */
function later(fn) {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Menu da própria dock (botão direito na divisória ou no fundo), como o do
 * macOS: posição na tela, estilo, ocultação, ampliação e configurações.
 */
export class DockMenu extends PopupMenu.PopupMenu {
    constructor(sourceActor, dock) {
        super(sourceActor, 0.5, dock.axis.side);
        this.actor.add_style_class_name('orla-menu');
        const settings = dock.settings;
        // ✓ para liga/desliga; • (rádio) para escolher uma entre várias.
        const check = on => on ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE;
        const dot = on => on ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT;

        const autohide = this.addAction(_('Turn Hiding On'),
            () => settings.set_boolean('autohide', !settings.get_boolean('autohide')));
        autohide.setOrnament(check(settings.get_boolean('autohide')));

        if (!dock.taskbar) {
            const zoomOn = settings.get_double('magnification') > 1.001;
            const zoom = this.addAction(_('Turn Magnification On'), () => {
                // Guarda o último valor para "religar" do mesmo jeito.
                if (zoomOn) {
                    dock.manager.lastMagnification = settings.get_double('magnification');
                    settings.set_double('magnification', 1.0);
                } else {
                    settings.set_double('magnification', dock.manager.lastMagnification ?? 2.0);
                }
            });
            zoom.setOrnament(check(zoomOn));
        }
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const position = new PopupMenu.PopupSubMenuMenuItem(_('Position on Screen'));
        const current = settings.get_enum('position');
        [_('Bottom'), _('Top'), _('Left'), _('Right')].forEach((label, value) => {
            const item = position.menu.addAction(label, () => later(() => settings.set_enum('position', value)));
            item.setOrnament(dot(current === value));
        });
        this.addMenuItem(position);

        const style = new PopupMenu.PopupSubMenuMenuItem(_('Style'));
        const mode = settings.get_enum('layout-mode');
        [_('Dock (macOS)'), _('Taskbar (Windows 10)')].forEach((label, value) => {
            const item = style.menu.addAction(label, () => later(() => settings.set_enum('layout-mode', value)));
            item.setOrnament(dot(mode === value));
        });
        this.addMenuItem(style);

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.addAction(_('Dock Settings…'), () => dock.manager.openPreferences());
    }
}
