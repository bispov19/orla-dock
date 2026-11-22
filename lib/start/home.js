// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/home.js — a tela inicial do Menu Iniciar:
//   Fixados      grade em páginas (a rodinha ou os pontinhos trocam de
//                página); arrastar muda a ordem, soltar um app em cima de
//                outro cria uma pasta;
//   Recentes     os últimos apps abertos (opção start-menu-recent-apps);
//   Continuar    arquivos abertos recentemente (start-menu-continue).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppCell, ICON_GRID, Row, friendlyTime, sectionHeader} from './widgets.js';

const COLUMNS = 6;
const ROWS = 3;
const PER_PAGE = COLUMNS * ROWS;
const RECENT_APPS = 6;

/**
 * Ícone de pasta: os ícones de até três apps dela, sobrepostos em leque
 * (o primeiro na frente), sobre um fundo arredondado.
 */
function folderIcon(apps) {
    const plate = new St.Widget({
        style_class: 'orla-start-folder-icon',
        width: ICON_GRID, height: ICON_GRID,
        x_align: Clutter.ActorAlign.CENTER,
    });
    const shown = apps.slice(0, 3);
    const size = Math.round(ICON_GRID * 0.55);
    // Inclinação de cada ícone, conforme quantos são.
    const tilt = [[0], [-9, 9], [-12, 0, 12]][shown.length - 1] ?? [];
    // Os de trás entram primeiro, para o primeiro app ficar por cima.
    shown.slice().reverse().forEach((app, back) => {
        const i = shown.length - 1 - back;
        const icon = new St.Icon({gicon: app.get_icon(), icon_size: size});
        const offset = (i - (shown.length - 1) / 2) * size * 0.42;
        icon.set_position(Math.round((ICON_GRID - size) / 2 + offset), Math.round((ICON_GRID - size) / 2 + Math.abs(offset) * 0.25));
        icon.set_pivot_point(0.5, 1);
        icon.rotation_angle_z = tilt[i] ?? 0;
        plate.add_child(icon);
    });
    return plate;
}

export class HomeView {
    constructor(menu) {
        this._menu = menu;
        this._data = menu.data;
        this._page = 0;
        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'orla-start-view',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        this.actor.add_child(sectionHeader(_('Pinned'), {label: _('All apps'), activate: () => menu.showAllApps()}));
        this._grid = new St.Widget({
            style_class: 'orla-start-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true}),
            reactive: true,
        });
        this._grid._delegate = this;
        this._grid.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.actor.add_child(this._grid);
        this._dots = new St.BoxLayout({style_class: 'orla-start-dots', x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._dots);

        this._recent = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this.actor.add_child(this._recent);
        this._continue = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this.actor.add_child(this._continue);
    }

    /** Refaz tudo (ao abrir o menu e quando os fixados mudam). */
    refresh() {
        this._buildPinned();
        this._buildRecent();
        this._buildContinue();
    }

    focusFirst() {
        this._grid.get_first_child()?.grab_key_focus();
    }

    // ---------- Fixados ----------

    _buildPinned() {
        const items = this._data.pinnedItems();
        this._items = items;
        const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
        this._page = Math.min(this._page, pages - 1);
        this._grid.destroy_all_children();
        const layout = this._grid.layout_manager;
        items.slice(this._page * PER_PAGE, (this._page + 1) * PER_PAGE).forEach((item, i) => {
            const cell = item.folder ? this._folderCell(item) : this._appCell(item);
            cell._orlaKey = item.key;
            layout.attach(cell, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1);
        });
        // Mantém a altura da grade mesmo com a página incompleta.
        for (let i = items.length - this._page * PER_PAGE; i < PER_PAGE && i >= 0; i++) {
            const spacer = new St.Widget({style_class: 'orla-start-cell orla-start-spacer'});
            layout.attach(spacer, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1);
        }
        this._buildDots(pages);
    }

    _appCell({key, app}) {
        const cell = new AppCell({
            gicon: app.get_icon(),
            name: app.get_name(),
            running: app.get_n_windows() > 0,
            activate: () => this._menu.launch(app),
            menu: () => this._menu.appMenu(app, {pinnedKey: key}),
            owner: this._menu,
        });
        this._makeDraggable(cell, key, app.get_icon());
        return cell;
    }

    _folderCell({key, folder, apps}) {
        const cell = new AppCell({
            iconActor: folderIcon(apps),
            name: folder.name,
            running: apps.some(app => app.get_n_windows() > 0),
            activate: () => this._menu.showFolder(folder.id),
            menu: () => [{label: _('Unpin from Start'), activate: () => this._data.unpin(key)}],
            owner: this._menu,
        });
        this._makeDraggable(cell, key, null, folderIcon(apps));
        return cell;
    }

    _buildDots(pages) {
        this._dots.destroy_all_children();
        this._dots.visible = pages > 1;
        for (let i = 0; i < pages; i++) {
            const dot = new St.Button({
                style_class: 'orla-start-dot',
                can_focus: true,
                accessible_name: _('Page %d').format(i + 1),
            });
            if (i === this._page)
                dot.add_style_pseudo_class('checked');
            dot.connect('clicked', () => this._setPage(i));
            this._dots.add_child(dot);
        }
    }

    _setPage(page) {
        const pages = Math.max(1, Math.ceil(this._items.length / PER_PAGE));
        const next = Math.max(0, Math.min(page, pages - 1));
        if (next === this._page)
            return;
        this._page = next;
        this._buildPinned();
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
            this._setPage(this._page + 1);
        else if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            this._setPage(this._page - 1);
        return Clutter.EVENT_STOP;
    }

    // ---------- Arrastar para reordenar e criar pastas ----------

    _makeDraggable(cell, key, gicon, iconActor = null) {
        cell._delegate = {
            orlaStartKey: key,
            getDragActor: () => iconActor ?? new St.Icon({gicon, icon_size: ICON_GRID}),
            getDragActorSource: () => cell,
        };
        const draggable = DND.makeDraggable(cell);
        draggable.connect('drag-begin', () => {
            cell.opacity = 80;
        });
        draggable.connect('drag-end', () => {
            cell.opacity = 255;
            this._clearTarget();
        });
    }

    /** A célula embaixo do ponto (x, y em coordenadas da grade), e onde. */
    _cellAt(x, y) {
        for (const cell of this._grid.get_children()) {
            const box = cell.get_allocation_box();
            if (x >= box.x1 && x < box.x2 && y >= box.y1 && y < box.y2) {
                const cx = (box.x1 + box.x2) / 2;
                const cy = (box.y1 + box.y2) / 2;
                // Perto do centro = "em cima" (pasta); nas bordas = "entre".
                const center = Math.abs(x - cx) < box.get_width() * 0.25 && Math.abs(y - cy) < box.get_height() * 0.3;
                return {cell, center, after: x > cx};
            }
        }
        return null;
    }

    _clearTarget() {
        this._target?.remove_style_pseudo_class('drop');
        this._target = null;
    }

    handleDragOver(source, _actor, x, y) {
        if (!source?.orlaStartKey)
            return DND.DragMotionResult.CONTINUE;
        const hit = this._cellAt(x, y);
        this._clearTarget();
        if (hit?.cell?._orlaKey && hit.cell._orlaKey !== source.orlaStartKey) {
            this._target = hit.cell;
            hit.cell.add_style_pseudo_class('drop');
        }
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, x, y) {
        const key = source?.orlaStartKey;
        if (!key)
            return false;
        this._clearTarget();
        const hit = this._cellAt(x, y);
        const keys = this._data.pinnedKeys;
        if (!hit?.cell?._orlaKey) {
            this._data.movePinned(key, keys.length);
            return true;
        }
        const target = hit.cell._orlaKey;
        if (target === key)
            return true;
        if (hit.center && !key.startsWith('folder:')) {
            if (target.startsWith('folder:'))
                this._data.putInFolder(target, key);
            else
                this._data.groupApps(target, key, this._menu.newFolderName());
            return true;
        }
        let index = keys.indexOf(target) + (hit.after ? 1 : 0);
        if (keys.indexOf(key) < index)
            index--;
        this._data.movePinned(key, index);
        return true;
    }

    // ---------- Recentes e arquivos ----------

    _buildRecent() {
        this._recent.destroy_all_children();
        const apps = this._menu.settings.get_boolean('start-menu-recent-apps')
            ? this._data.recentApps(RECENT_APPS) : [];
        this._recent.visible = apps.length > 0;
        if (!apps.length)
            return;
        this._recent.add_child(sectionHeader(_('Recent apps')));
        const row = new St.BoxLayout({style_class: 'orla-start-recent-row'});
        for (const app of apps) {
            row.add_child(new AppCell({
                gicon: app.get_icon(),
                name: app.get_name(),
                running: app.get_n_windows() > 0,
                activate: () => this._menu.launch(app),
                menu: () => this._menu.appMenu(app),
                owner: this._menu,
            }));
        }
        this._recent.add_child(row);
    }

    async _buildContinue() {
        const token = this._continueToken = {};
        const show = this._menu.settings.get_boolean('start-menu-continue');
        const limit = Math.max(0, this._menu.settings.get_int('start-menu-recent-files'));
        const files = show && limit ? await this._data.recentFiles(limit) : [];
        if (token !== this._continueToken || !this._continue.get_stage())
            return;
        this._continue.destroy_all_children();
        this._continue.visible = files.length > 0;
        if (!files.length)
            return;
        this._continue.add_child(sectionHeader(_('Continue where you left off')));
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
            }), i % 2, Math.floor(i / 2), 1, 1);
        });
        this._continue.add_child(grid);
    }

    destroy() {
        this._continueToken = null;
        this.actor.destroy();
    }
}
