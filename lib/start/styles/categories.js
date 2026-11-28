// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// start/styles/categories.js — estilo "Compacto por categorias", uma
// coluna só:
//
//   ┌────────────────────┐
//   │ [1] [2] [3]  [+]   │  áreas de trabalho: clicar troca; + cria outra
//   │ 🔍 Pesquisar…       │
//   │ ★ Fixados        › │  cada categoria abre um submenu ao lado
//   │ 🌐 Internet      › │  (clique, Enter ou seta para a direita;
//   │ 🎵 Som e vídeo   › │   seta para a esquerda ou Esc voltam)
//   │ …                  │
//   │ 👤 Nome         ⏻  │
//   └────────────────────┘
//
// As categorias vêm do campo Categories do .desktop de cada app (o padrão
// do freedesktop.org); um app sem categoria conhecida vai para "Outros".

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {powerButton, userButton} from '../parts.js';
import {Row} from '../widgets.js';
import {BaseStyle} from './base.js';

const WIDTH = 330;
const HEIGHT = 580;
const FLYOUT_MAX_HEIGHT = 460;

// As categorias principais do freedesktop.org, na ordem do menu. Um app
// entra na PRIMEIRA que combinar.
const CATEGORIES = [
    {id: 'Network', name: () => _('Internet'), icon: 'web-browser-symbolic', match: ['Network', 'WebBrowser', 'Email', 'Chat']},
    {id: 'Office', name: () => _('Office'), icon: 'x-office-document-symbolic', match: ['Office']},
    {id: 'Graphics', name: () => _('Graphics'), icon: 'applications-graphics-symbolic', match: ['Graphics', 'Photography']},
    {id: 'AudioVideo', name: () => _('Sound & Video'), icon: 'applications-multimedia-symbolic', match: ['AudioVideo', 'Audio', 'Video']},
    {id: 'Game', name: () => _('Games'), icon: 'applications-games-symbolic', match: ['Game']},
    {id: 'Development', name: () => _('Development'), icon: 'applications-engineering-symbolic', match: ['Development']},
    {id: 'Education', name: () => _('Education & Science'), icon: 'applications-science-symbolic', match: ['Education', 'Science']},
    {id: 'Utility', name: () => _('Accessories'), icon: 'applications-utilities-symbolic', match: ['Utility', 'Accessibility', 'TextEditor']},
    {id: 'System', name: () => _('System'), icon: 'applications-system-symbolic', match: ['System', 'Settings', 'Monitor', 'Security']},
];

export class CategoriesStyle extends BaseStyle {
    constructor(menu, factor) {
        super(menu, factor, {id: 'categories', width: WIDTH, height: HEIGHT});

        this._workspaces = new St.BoxLayout({style_class: 'orla-start-workspaces'});
        this.actor.add_child(this._workspaces);
        this.actor.add_child(this.makeEntry(_('Search')));

        const scroll = new St.ScrollView({
            style_class: 'orla-start-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true,
        });
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        scroll.set_child(this._list);
        this._scroll = scroll;
        this.actor.add_child(scroll);
        this.actor.add_child(this.results.actor);

        const footer = new St.BoxLayout({style_class: 'orla-start-footer'});
        footer.add_child(userButton(menu, {size: 24}));
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(powerButton(menu));
        this.actor.add_child(footer);

        this.hideWhileSearching(scroll);
        this._areas = [this._workspaces, this.entry, scroll, footer];
    }

    onReset() {
        // Poucos botões, e o número de áreas muda a toda hora: refeito ao abrir.
        this._buildWorkspaces();
        this._scroll.vadjustment.value = 0;
    }

    refresh(parts) {
        if (parts.has('apps') || parts.has('pinned'))
            this._buildCategories();
    }

    // ---------- Áreas de trabalho ----------

    _buildWorkspaces() {
        this._workspaces.destroy_all_children();
        const manager = global.workspace_manager;
        const active = manager.get_active_workspace_index();
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            const button = new St.Button({
                style_class: 'orla-start-workspace',
                label: String(i + 1),
                can_focus: true,
                accessible_name: _('Workspace %d').format(i + 1),
            });
            if (i === active)
                button.add_style_pseudo_class('checked');
            button.connect('clicked', () => this.menu.afterClose(() =>
                manager.get_workspace_by_index(i)?.activate(global.get_current_time())));
            this._workspaces.add_child(button);
        }
        this._workspaces.add_child(new St.Widget({x_expand: true}));
        const add = new St.Button({
            style_class: 'orla-start-workspace orla-start-workspace-add',
            can_focus: true,
            accessible_name: _('New workspace'),
            child: new St.Icon({icon_name: 'list-add-symbolic', icon_size: 14}),
        });
        // Áreas dinâmicas do GNOME: sempre existe uma vazia no fim; "+" vai
        // para ela. Áreas fixas: cria mais uma.
        add.connect('clicked', () => this.menu.afterClose(() => {
            const dynamic = Meta.prefs_get_dynamic_workspaces();
            const last = manager.get_workspace_by_index(manager.get_n_workspaces() - 1);
            const empty = dynamic && last && last.list_windows().length === 0 &&
                last !== manager.get_active_workspace();
            if (empty)
                last.activate(global.get_current_time());
            else
                manager.append_new_workspace(true, global.get_current_time());
        }));
        this._workspaces.add_child(add);
    }

    // ---------- Categorias ----------

    _groups() {
        const groups = new Map(CATEGORIES.map(c => [c.id, []]));
        const other = [];
        for (const app of this.data.allApps()) {
            const own = this.data.categoriesOf(app);
            const category = CATEGORIES.find(c => c.match.some(m => own.includes(m)));
            (category ? groups.get(category.id) : other).push(app);
        }
        const out = [];
        const pinned = this.data.pinnedApps();
        if (pinned.length)
            out.push({name: _('Pinned'), icon: 'starred-symbolic', apps: pinned});
        for (const category of CATEGORIES) {
            const apps = groups.get(category.id);
            if (apps.length)
                out.push({name: category.name(), icon: category.icon, apps});
        }
        if (other.length)
            out.push({name: _('Other'), icon: 'applications-other-symbolic', apps: other});
        return out;
    }

    _buildCategories() {
        this._list.destroy_all_children();
        for (const group of this._groups()) {
            const row = new Row({
                iconActor: new St.Icon({icon_name: group.icon, icon_size: 18}),
                title: group.name,
                subtitle: _('%d apps').format(group.apps.length),
                trailing: new St.Icon({icon_name: 'pan-end-symbolic', icon_size: 14}),
                activate: () => this._openCategory(group, row),
                owner: this.menu,
                styleClass: 'orla-start-category',
            });
            row._orlaGroup = group;
            this._list.add_child(row);
        }
    }

    /** O submenu com os apps da categoria, ao lado do menu. */
    _openCategory(group, row) {
        const popup = new St.BoxLayout({style_class: 'orla-start-flyout', orientation: Clutter.Orientation.VERTICAL});
        popup.add_child(new St.Label({text: group.name, style_class: 'orla-start-section-title orla-start-flyout-title'}));
        const scroll = new St.ScrollView({
            style_class: 'orla-start-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        for (const app of group.apps) {
            list.add_child(new Row({
                app,
                activate: () => this.menu.launch(app),
                menu: () => this.menu.appMenu(app),
                owner: this.menu,
            }));
        }
        scroll.set_child(list);
        popup.add_child(scroll);
        // Lista longa rola; curta fica do tamanho dela.
        scroll.set_style(`max-height: ${Math.round(FLYOUT_MAX_HEIGHT * this.factor)}px;`);
        this.menu.showFlyout(popup, row);
        list.get_first_child()?.grab_key_focus();
    }

    handleKey(event) {
        // Seta para a direita numa categoria abre o submenu dela.
        if (event.get_key_symbol() !== Clutter.KEY_Right)
            return false;
        const focus = global.stage.get_key_focus();
        if (!focus?._orlaGroup)
            return false;
        this._openCategory(focus._orlaGroup, focus);
        return true;
    }

    focusContent() {
        this._list.get_first_child()?.grab_key_focus();
    }
}
