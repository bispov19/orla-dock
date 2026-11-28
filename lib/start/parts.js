// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// start/parts.js — peças do Menu Iniciar usadas por mais de um estilo:
//
//   AppGrid        grade em páginas (fixados ou todos os apps); arrastar
//                  um fixado muda a ordem dele (nos favoritos do GNOME)
//   AppList        lista vertical de apps (fixados ou recentes)
//   AlphaList      todos os apps de A a Z, com as letras como índice
//   RecentFiles    "Continuar de onde parou" (arquivos recentes)
//   userButton, avatar, powerButton, lockButton, suspendButton,
//   placeRows      atalhos de usuário, energia e pastas
//
// Leveza: cada célula/linha é criada UMA vez por app e guardada; mudar de
// página ou reabrir o menu só reorganiza as que já existem. A grade só
// cria as células das páginas que já foram vistas; a lista de A a Z é
// montada uma vez e refeita só quando um app é instalado/removido.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppCell, ICON_GRID, Row, friendlyTime, iconButton, sectionHeader} from './widgets.js';

/** A letra do grupo: A–Z sem acento; números e símbolos em "#". */
export function letterOf(name) {
    const first = name.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : '#';
}

export const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

// ---------- Arrastar para reordenar os fixados ----------

/**
 * Deixa os filhos de `container` (cada um com `_orlaApp` e `_orlaIndex`)
 * serem arrastados para mudar a ordem dos fixados. `axis` diz se o "antes
 * ou depois" se decide pela horizontal (grade) ou pela vertical (lista).
 */
function makeReorderable(container, menu, axis) {
    let target = null;
    const clear = () => {
        target?.remove_style_pseudo_class('drop');
        target = null;
    };
    const childAt = (x, y) => {
        for (const child of container.get_children()) {
            if (!child._orlaApp)
                continue;
            const box = child.get_allocation_box();
            if (x >= box.x1 && x < box.x2 && y >= box.y1 && y < box.y2) {
                const after = axis === 'x' ? x > (box.x1 + box.x2) / 2 : y > (box.y1 + box.y2) / 2;
                return {child, after};
            }
        }
        return null;
    };
    container._delegate = {
        handleDragOver(source, _actor, x, y) {
            if (!source?.orlaStartApp)
                return DND.DragMotionResult.CONTINUE;
            clear();
            const hit = childAt(x, y);
            if (hit && hit.child._orlaApp !== source.orlaStartApp) {
                target = hit.child;
                target.add_style_pseudo_class('drop');
            }
            return DND.DragMotionResult.MOVE_DROP;
        },
        acceptDrop(source, _actor, x, y) {
            const app = source?.orlaStartApp;
            if (!app)
                return false;
            clear();
            const hit = childAt(x, y);
            if (!hit) {
                menu.data.movePinned(app, -1);
                return true;
            }
            if (hit.child._orlaApp === app)
                return true;
            let index = hit.child._orlaIndex + (hit.after ? 1 : 0);
            if (source.orlaStartIndex < index)
                index--;
            menu.data.movePinned(app, index);
            return true;
        },
    };
    return clear;
}

/** Torna uma célula/linha de app arrastável (para reordenar). */
function makeDraggable(actor, app, index, iconSize, onEnd) {
    actor._orlaApp = app;
    actor._orlaIndex = index;
    actor._delegate = {
        orlaStartApp: app,
        orlaStartIndex: index,
        getDragActor: () => app.create_icon_texture(iconSize),
        getDragActorSource: () => actor,
    };
    const draggable = DND.makeDraggable(actor);
    draggable.connect('drag-begin', () => {
        actor.opacity = 80;
    });
    draggable.connect('drag-end', () => {
        actor.opacity = 255;
        onEnd();
    });
}

// ---------- Grade em páginas ----------

export class AppGrid {
    /**
     * @param {object} menu - a casca (startMenu.js)
     * @param {object} params
     * @param {Function} params.source - devolve os apps a mostrar
     * @param {number} params.columns
     * @param {number} params.rows
     * @param {boolean} [params.reorder] - arrastar muda a ordem (fixados)
     * @param {number} [params.iconSize]
     * @param {string} [params.cellClass] - classe extra das células
     */
    constructor(menu, {source, columns, rows, reorder = false, iconSize = ICON_GRID, cellClass = ''}) {
        this._menu = menu;
        this._source = source;
        this._columns = columns;
        this._perPage = columns * rows;
        this._reorder = reorder;
        this._iconSize = iconSize;
        this._cellClass = cellClass;
        this._page = 0;
        this._apps = [];
        this._cells = new Map();    // id do app → célula (criada uma vez)

        this.actor = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._grid = new St.Widget({
            style_class: 'orla-start-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true}),
            reactive: true,
            x_expand: true,
        });
        this._grid.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.actor.add_child(this._grid);
        this._dots = new St.BoxLayout({style_class: 'orla-start-dots', x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._dots);
        this._clearDrop = reorder ? makeReorderable(this._grid, menu, 'x') : () => {};
    }

    get pages() {
        return Math.max(1, Math.ceil(this._apps.length / this._perPage));
    }

    get page() {
        return this._page;
    }

    get isEmpty() {
        return this._apps.length === 0;
    }

    refresh({resetPage = false} = {}) {
        this._apps = this._source();
        if (resetPage)
            this._page = 0;
        this._page = Math.min(this._page, this.pages - 1);
        // Células de apps que sumiram (desinstalados, desafixados) saem do cache.
        const ids = new Set(this._apps.map(app => app.get_id()));
        for (const [id, cell] of this._cells) {
            if (!ids.has(id)) {
                cell.destroy();
                this._cells.delete(id);
            }
        }
        this._build();
    }

    /** Volta à primeira página (ao abrir o menu), sem recriar nada. */
    reset() {
        if (this._page !== 0) {
            this._page = 0;
            this._build();
        }
    }

    /** Atualiza só os pontinhos de "aberto" das células que existem. */
    updateRunning() {
        for (const [, cell] of this._cells)
            cell.setRunning(cell._orlaApp.get_n_windows() > 0);
    }

    _cellFor(app, index) {
        let cell = this._cells.get(app.get_id());
        if (!cell) {
            cell = new AppCell({
                app,
                running: app.get_n_windows() > 0,
                iconSize: this._iconSize,
                styleClass: this._cellClass,
                activate: () => this._menu.launch(app),
                menu: () => this._menu.appMenu(app),
                owner: this._menu,
            });
            cell._orlaApp = app;
            if (this._reorder)
                makeDraggable(cell, app, index, this._iconSize, this._clearDrop);
            this._cells.set(app.get_id(), cell);
        }
        // A posição muda quando os fixados são reordenados.
        cell._orlaIndex = index;
        if (cell._delegate?.orlaStartApp)
            cell._delegate.orlaStartIndex = index;
        return cell;
    }

    _build() {
        // Tira as células da grade SEM destruir (elas voltam do cache).
        for (const child of this._grid.get_children()) {
            if (child._orlaApp)
                this._grid.remove_child(child);
            else
                child.destroy();
        }
        const layout = this._grid.layout_manager;
        const start = this._page * this._perPage;
        const shown = this._apps.slice(start, start + this._perPage);
        shown.forEach((app, i) => {
            layout.attach(this._cellFor(app, start + i), i % this._columns, Math.floor(i / this._columns), 1, 1);
        });
        // A grade mantém a altura mesmo com a página incompleta.
        for (let i = shown.length; i < this._perPage; i++) {
            layout.attach(new St.Widget({style_class: `orla-start-cell orla-start-spacer ${this._cellClass}`.trim()}),
                i % this._columns, Math.floor(i / this._columns), 1, 1);
        }
        this._buildDots();
    }

    _buildDots() {
        this._dots.destroy_all_children();
        this._dots.visible = this.pages > 1;
        for (let i = 0; i < this.pages; i++) {
            const dot = new St.Button({
                style_class: 'orla-start-dot',
                can_focus: false,
                accessible_name: _('Page %d').format(i + 1),
            });
            if (i === this._page)
                dot.add_style_pseudo_class('checked');
            dot.connect('clicked', () => this.setPage(i));
            this._dots.add_child(dot);
        }
    }

    setPage(page, {focus = false} = {}) {
        const next = Math.max(0, Math.min(page, this.pages - 1));
        if (next === this._page)
            return false;
        const forward = next > this._page;
        this._page = next;
        this._build();
        if (this._menu.animate) {
            // Troca de página: um deslize curto (barato até em GPU integrada).
            this._grid.translation_x = forward ? 24 : -24;
            this._grid.opacity = 120;
            this._grid.ease({translation_x: 0, opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        if (focus)
            this.focusFirst();
        return true;
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
            this.setPage(this._page + 1);
        else if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            this.setPage(this._page - 1);
        return Clutter.EVENT_STOP;
    }

    focusFirst() {
        const first = this._grid.get_children().find(c => c._orlaApp || c.can_focus);
        first?.grab_key_focus();
        return Boolean(first);
    }

    /** PageUp/PageDown trocam de página; as setas na borda também. */
    handleKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Page_Down)
            return this.setPage(this._page + 1, {focus: true});
        if (key === Clutter.KEY_Page_Up)
            return this.setPage(this._page - 1, {focus: true});
        const focus = global.stage.get_key_focus();
        if (!focus || focus.get_parent() !== this._grid)
            return false;
        const children = this._grid.get_children().filter(c => c.can_focus);
        const index = children.indexOf(focus);
        if (key === Clutter.KEY_Right && index === children.length - 1)
            return this.setPage(this._page + 1, {focus: true});
        if (key === Clutter.KEY_Left && index === 0)
            return this.setPage(this._page - 1, {focus: true});
        return false;
    }

    destroy() {
        // As do cache que não estão na página atual também.
        for (const [, cell] of this._cells) {
            if (!cell.get_parent())
                cell.destroy();
        }
        this._cells.clear();
        this.actor.destroy();
    }
}

// ---------- Lista de apps ----------

export class AppList {
    /**
     * @param {object} menu
     * @param {object} params
     * @param {Function} params.source - devolve os apps
     * @param {boolean} [params.reorder]
     * @param {number} [params.iconSize]
     * @param {string} [params.rowClass]
     */
    constructor(menu, {source, reorder = false, iconSize = 24, rowClass = ''}) {
        this._menu = menu;
        this._source = source;
        this._reorder = reorder;
        this._iconSize = iconSize;
        this._rowClass = rowClass;
        this._rows = new Map();     // id do app → linha (criada uma vez)
        this.actor = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, reactive: true});
        this._clearDrop = reorder ? makeReorderable(this.actor, menu, 'y') : () => {};
    }

    get isEmpty() {
        return this.actor.get_n_children() === 0;
    }

    refresh() {
        const apps = this._source();
        const ids = new Set(apps.map(app => app.get_id()));
        for (const child of this.actor.get_children())
            this.actor.remove_child(child);
        for (const [id, row] of this._rows) {
            if (!ids.has(id)) {
                row.destroy();
                this._rows.delete(id);
            }
        }
        apps.forEach((app, i) => {
            let row = this._rows.get(app.get_id());
            if (!row) {
                row = new Row({
                    app,
                    iconSize: this._iconSize,
                    styleClass: this._rowClass,
                    activate: () => this._menu.launch(app),
                    menu: () => this._menu.appMenu(app),
                    owner: this._menu,
                });
                row._orlaApp = app;
                if (this._reorder)
                    makeDraggable(row, app, i, this._iconSize, this._clearDrop);
                this._rows.set(app.get_id(), row);
            }
            row._orlaIndex = i;
            if (row._delegate?.orlaStartApp)
                row._delegate.orlaStartIndex = i;
            this.actor.add_child(row);
        });
    }

    focusFirst() {
        const first = this.actor.get_first_child();
        first?.grab_key_focus();
        return Boolean(first);
    }

    destroy() {
        for (const [, row] of this._rows) {
            if (!row.get_parent())
                row.destroy();
        }
        this._rows.clear();
        this.actor.destroy();
    }
}

// ---------- De A a Z ----------

export class AlphaList {
    /**
     * @param {object} menu
     * @param {object} [params]
     * @param {boolean} [params.rail] - índice de letras ao lado
     * @param {Function} [params.onLetter] - clicar numa letra-título
     *   (o estilo Lista alfabética abre a grade de letras)
     * @param {boolean} [params.grid] - em grade em vez de lista
     * @param {number} [params.columns]
     */
    constructor(menu, {rail = true, onLetter = null, grid = false, columns = 6} = {}) {
        this._menu = menu;
        this._onLetter = onLetter;
        this._gridMode = grid;
        this._columns = columns;
        this._built = null;     // a lista de apps usada na última montagem
        this._headers = new Map();

        this.actor = new St.BoxLayout({x_expand: true, y_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'orla-start-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true,
        });
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-all-list'});
        this._scroll.set_child(this._list);
        this.actor.add_child(this._scroll);
        this._rail = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-rail',
            visible: rail});
        this.actor.add_child(this._rail);
    }

    /** As letras que têm algum app. */
    get letters() {
        return [...this._headers.keys()];
    }

    refresh() {
        const apps = this._menu.data.allApps();
        // Mesma lista de antes (nada instalado/removido): só volta ao topo.
        if (apps !== this._built) {
            this._built = apps;
            this._build(apps);
        }
    }

    /** Volta ao topo (ao abrir o menu). */
    reset() {
        this._scroll.vadjustment.value = 0;
    }

    _build(apps) {
        this._list.destroy_all_children();
        this._rail.destroy_all_children();
        this._headers.clear();
        const groups = new Map();
        for (const app of apps) {
            const key = letterOf(app.get_name());
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(app);
        }
        const keys = [...groups.keys()].sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b));
        for (const key of keys) {
            const header = new St.Button({
                style_class: 'orla-start-letter',
                label: key,
                can_focus: Boolean(this._onLetter),
                x_align: Clutter.ActorAlign.START,
                accessible_name: _('Apps starting with %s').format(key),
            });
            if (this._onLetter)
                header.connect('clicked', () => this._onLetter(key));
            else
                header.reactive = false;
            this._headers.set(key, header);
            this._list.add_child(header);
            this._list.add_child(this._gridMode ? this._gridOf(groups.get(key)) : this._listOf(groups.get(key)));

            const jump = new St.Button({style_class: 'orla-start-rail-key', label: key, can_focus: false});
            jump.connect('clicked', () => this.scrollTo(key));
            this._rail.add_child(jump);
        }
    }

    _listOf(apps) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        for (const app of apps) {
            box.add_child(new Row({
                app,
                activate: () => this._menu.launch(app),
                menu: () => this._menu.appMenu(app),
                owner: this._menu,
            }));
        }
        return box;
    }

    _gridOf(apps) {
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true})});
        apps.forEach((app, i) => {
            grid.layout_manager.attach(new AppCell({
                app,
                activate: () => this._menu.launch(app),
                menu: () => this._menu.appMenu(app),
                owner: this._menu,
            }), i % this._columns, Math.floor(i / this._columns), 1, 1);
        });
        return grid;
    }

    /** Rola até a letra e põe o foco no primeiro app dela. */
    scrollTo(key, {focus = false} = {}) {
        const header = this._headers.get(key);
        if (!header)
            return;
        const adjustment = this._scroll.vadjustment;
        const value = Math.min(header.y, adjustment.upper - adjustment.page_size);
        if (this._menu.animate)
            adjustment.ease(value, {duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            adjustment.value = value;
        if (focus) {
            const block = this._list.get_child_at_index(this._list.get_children().indexOf(header) + 1);
            (block?.get_first_child() ?? header).grab_key_focus();
        }
    }

    focusFirst() {
        const block = this._list.get_child_at_index(1);
        const first = block?.get_first_child();
        first?.grab_key_focus();
        return Boolean(first);
    }

    destroy() {
        this.actor.destroy();
    }
}

// ---------- Arquivos recentes ----------

export class RecentFiles {
    /**
     * @param {object} menu
     * @param {object} [params]
     * @param {number} [params.columns]
     * @param {string} [params.title]
     */
    constructor(menu, {columns = 2, title = null} = {}) {
        this._menu = menu;
        this._columns = columns;
        this._title = title ?? _('Continue where you left off');
        this.actor = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, visible: false});
    }

    /** Assíncrono: o histórico de arquivos é lido do disco. */
    async refresh(limit = null) {
        const token = this._token = {};
        const settings = this._menu.settings;
        const max = limit ?? Math.max(0, settings.get_int('start-menu-recent-files'));
        const files = settings.get_boolean('start-menu-continue') && max
            ? await this._menu.data.recentFiles(max) : [];
        if (token !== this._token || !this.actor.get_stage())
            return;
        this.actor.destroy_all_children();
        this.actor.visible = files.length > 0;
        if (!files.length)
            return;
        this.actor.add_child(sectionHeader(this._title));
        const grid = new St.Widget({
            style_class: 'orla-start-files',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: 6, row_spacing: 2}),
        });
        files.forEach((entry, i) => {
            grid.layout_manager.attach(new Row({
                gicon: entry.gicon ?? Gio.ThemedIcon.new('text-x-generic'),
                title: entry.name,
                subtitle: friendlyTime(entry.time, _),
                activate: () => this._menu.openFile(entry.file),
                menu: () => this._menu.fileMenu(entry.file),
                owner: this._menu,
            }), i % this._columns, Math.floor(i / this._columns), 1, 1);
        });
        this.actor.add_child(grid);
    }

    destroy() {
        this._token = null;
        this.actor.destroy();
    }
}

// ---------- Usuário, energia e pastas ----------

/** A foto do usuário (a das Configurações) ou o avatar padrão. */
export function avatar(size) {
    const path = GLib.build_filenamev(['/var/lib/AccountsService/icons', GLib.get_user_name()]);
    const gicon = GLib.file_test(path, GLib.FileTest.EXISTS)
        ? Gio.FileIcon.new(Gio.File.new_for_path(path))
        : Gio.ThemedIcon.new('avatar-default-symbolic');
    return new St.Icon({gicon, icon_size: size, style_class: 'orla-start-avatar'});
}

export function userName() {
    return GLib.get_real_name() || GLib.get_user_name();
}

/** Foto + nome; abre "Usuários" nas Configurações. */
export function userButton(menu, {size = 28, vertical = false} = {}) {
    const button = new St.Button({style_class: 'orla-start-user', can_focus: true, accessible_name: userName()});
    const box = new St.BoxLayout({
        style_class: 'orla-start-user-box',
        orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
    });
    const icon = avatar(size);
    icon.x_align = Clutter.ActorAlign.CENTER;
    box.add_child(icon);
    box.add_child(new St.Label({text: userName(), y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER}));
    button.set_child(box);
    button.connect('clicked', () => menu.launchId('gnome-users-panel.desktop'));
    return button;
}

/** Botão redondo de energia: abre o menu com todas as opções. */
export function powerButton(menu) {
    const button = iconButton('system-shutdown-symbolic', _('Power Off / Log Out'), () => {
        const [x, y] = button.get_transformed_position();
        menu.showContextMenu(menu.powerItems(), x + button.width / 2, y);
    });
    return button;
}

export function lockButton(menu) {
    const actions = menu.systemActions;
    const button = iconButton('system-lock-screen-symbolic', _('Lock'),
        () => menu.afterClose(() => actions.activateLockScreen()));
    button.visible = actions.canLockScreen;
    return button;
}

export function suspendButton(menu) {
    const actions = menu.systemActions;
    const button = iconButton('media-playback-pause-symbolic', _('Suspend'),
        () => menu.afterClose(() => actions.activateSuspend()));
    button.visible = actions.canSuspend;
    return button;
}

export function settingsButton(menu) {
    return iconButton('emblem-system-symbolic', _('Settings'), () => menu.launchId('org.gnome.Settings.desktop'));
}

/**
 * Atalhos de pastas (Documentos, Imagens, Música, Downloads), a pasta
 * pessoal no Arquivos e as Configurações, como linhas.
 */
export function placeRows(menu, {iconSize = 20} = {}) {
    const rows = menu.data.places().map(place => new Row({
        iconActor: new St.Icon({icon_name: place.iconName, icon_size: iconSize}),
        title: place.name,
        activate: () => menu.openFile(place.file),
        menu: () => menu.fileMenu(place.file),
        owner: menu,
        styleClass: 'orla-start-place',
    }));
    rows.push(new Row({
        iconActor: new St.Icon({icon_name: 'system-file-manager-symbolic', icon_size: iconSize}),
        title: _('Files'),
        activate: () => menu.openFile(Gio.File.new_for_path(GLib.get_home_dir())),
        owner: menu,
        styleClass: 'orla-start-place',
    }));
    rows.push(new Row({
        iconActor: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: iconSize}),
        title: _('Settings'),
        activate: () => menu.launchId('org.gnome.Settings.desktop'),
        owner: menu,
        styleClass: 'orla-start-place',
    }));
    return rows;
}
