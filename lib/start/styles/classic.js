// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// start/styles/classic.js — estilo "Clássico fiel", em duas colunas:
//
//   ┌────────────────────────┬──────────────┐
//   │ ▢ Fixado               │   (foto)     │
//   │ ▢ Fixado               │   Nome       │
//   │ ───────────            │ Documentos   │
//   │ ▢ Recente              │ Imagens      │
//   │ ▢ Recente              │ Música       │
//   │                        │ Downloads    │
//   │ Todos os programas  ›  │ Arquivos     │
//   │ 🔍 Pesquisar…           │ Configurações│
//   │                        │ [Desligar|›] │
//   └────────────────────────┴──────────────┘
//
// "Todos os programas" troca a lista da esquerda pela lista de A a Z, no
// mesmo lugar (como no Windows 7); "‹ Voltar" ou Esc desfazem.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlphaList, AppList, avatar, placeRows, userName} from '../parts.js';
import {Row} from '../widgets.js';
import {BaseStyle} from './base.js';

const WIDTH = 580;
const HEIGHT = 600;
const RECENT_APPS = 6;

export class ClassicStyle extends BaseStyle {
    constructor(menu, factor) {
        super(menu, factor, {id: 'classic', width: WIDTH, height: HEIGHT, vertical: false});
        this._showingAll = false;

        // ---- Coluna da esquerda: programas ----
        const left = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-classic-left',
            x_expand: true, y_expand: true});

        this._home = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        const scroll = new St.ScrollView({
            style_class: 'orla-start-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true,
        });
        const lists = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._pinned = new AppList(menu, {source: () => this.data.pinnedApps(), reorder: true, iconSize: 32,
            rowClass: 'orla-start-classic-pinned'});
        lists.add_child(this._pinned.actor);
        this._separator = new St.Widget({style_class: 'orla-start-separator'});
        lists.add_child(this._separator);
        this._recent = new AppList(menu, {
            source: () => menu.settings.get_boolean('start-menu-recent-apps')
                ? this.data.recentApps(RECENT_APPS).filter(app => !this.data.isPinned(app)) : [],
            iconSize: 24,
        });
        lists.add_child(this._recent.actor);
        scroll.set_child(lists);
        this._home.add_child(scroll);
        this._home.add_child(new St.Widget({style_class: 'orla-start-separator'}));
        this._home.add_child(new Row({
            iconActor: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 16}),
            title: _('All Programs'),
            trailing: new St.Icon({icon_name: 'pan-end-symbolic', icon_size: 16}),
            activate: () => this.showAll(true),
            owner: menu,
            styleClass: 'orla-start-classic-more',
        }));
        left.add_child(this._home);

        this._all = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true,
            visible: false});
        this._alpha = new AlphaList(menu, {rail: false});
        this._all.add_child(this._alpha.actor);
        this._all.add_child(new St.Widget({style_class: 'orla-start-separator'}));
        this._all.add_child(new Row({
            iconActor: new St.Icon({icon_name: 'pan-start-symbolic', icon_size: 16}),
            title: _('Back'),
            activate: () => this.showAll(false),
            owner: menu,
            styleClass: 'orla-start-classic-more',
        }));
        left.add_child(this._all);

        left.add_child(this.results.actor);
        left.add_child(this.makeEntry(_('Search programs and files')));
        this.actor.add_child(left);

        // ---- Coluna da direita: usuário, pastas e energia ----
        const right = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-classic-right',
            y_expand: true});
        right.width = Math.round(200 * factor);
        const user = new St.Button({style_class: 'orla-start-classic-user', can_focus: true, accessible_name: userName()});
        const userBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-user-box'});
        const photo = avatar(Math.round(52 * factor));
        photo.x_align = Clutter.ActorAlign.CENTER;
        userBox.add_child(photo);
        userBox.add_child(new St.Label({text: userName(), x_align: Clutter.ActorAlign.CENTER}));
        user.set_child(userBox);
        user.connect('clicked', () => menu.launchId('gnome-users-panel.desktop'));
        right.add_child(user);
        right.add_child(new St.Widget({style_class: 'orla-start-separator'}));
        const places = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        placeRows(menu, {iconSize: 18}).forEach(row => places.add_child(row));
        right.add_child(places);
        right.add_child(new St.Widget({y_expand: true}));
        right.add_child(this._powerSplit());
        this.actor.add_child(right);

        this.hideWhileSearching(this._home, this._all);
        this._areas = [this._home, this._all, this.entry, places, this._power];
    }

    /** [Desligar | ›]: o botão desliga; a seta abre as outras opções. */
    _powerSplit() {
        const actions = this.menu.systemActions;
        const box = new St.BoxLayout({style_class: 'orla-start-classic-power', x_align: Clutter.ActorAlign.END});
        const off = new St.Button({style_class: 'orla-start-classic-power-main', can_focus: true, label: _('Shut Down')});
        off.connect('clicked', () => this.menu.afterClose(() => actions.activatePowerOff()));
        off.visible = actions.canPowerOff;
        const more = new St.Button({
            style_class: 'orla-start-classic-power-more',
            can_focus: true,
            accessible_name: _('More power options'),
            child: new St.Icon({icon_name: 'pan-end-symbolic', icon_size: 14}),
        });
        more.connect('clicked', () => {
            const [x, y] = more.get_transformed_position();
            this.menu.showContextMenu(this._powerMenu(), x + more.width, y);
        });
        box.add_child(off);
        box.add_child(more);
        this._power = box;
        return box;
    }

    /** Suspender, Reiniciar, Bloquear e Sair (e o que mais houver). */
    _powerMenu() {
        const actions = this.menu.systemActions;
        const items = [];
        const add = (when, label, run) => {
            if (when)
                items.push({label, activate: () => this.menu.afterClose(run)});
        };
        add(actions.canSuspend, _('Suspend'), () => actions.activateSuspend());
        add(actions.canRestart, _('Restart'), () => actions.activateRestart());
        add(actions.canLockScreen, _('Lock'), () => actions.activateLockScreen());
        add(actions.canLogout, _('Log Out'), () => actions.activateLogout());
        add(actions.canSwitchUser, _('Switch User'), () => actions.activateSwitchUser());
        return items;
    }

    showAll(on, {focus = true} = {}) {
        this._showingAll = on;
        this.setWanted(this._home, !on);
        this.setWanted(this._all, on);
        if (on) {
            this._alpha.refresh();      // só refaz se um app entrou/saiu
            this._alpha.reset();
        }
        if (focus) {
            if (on)
                this._alpha.focusFirst();
            else
                this._pinned.focusFirst();
        }
    }

    onReset() {
        if (this._showingAll)
            this.showAll(false, {focus: false});
    }

    refresh(parts) {
        if (parts.has('pinned') || parts.has('apps'))
            this._pinned.refresh();
        if (parts.has('recent') || parts.has('pinned'))
            this._recent.refresh();
        this._separator.visible = !this._pinned.isEmpty && !this._recent.isEmpty;
        if (parts.has('apps') && this._showingAll)
            this._alpha.refresh();
    }

    escape() {
        if (super.escape())
            return true;
        if (this._showingAll) {
            this.showAll(false);
            return true;
        }
        return false;
    }

    focusContent() {
        if (this._showingAll)
            this._alpha.focusFirst();
        else
            this._pinned.focusFirst() || this._recent.focusFirst();
    }
}
