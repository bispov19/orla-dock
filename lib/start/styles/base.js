// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/styles/base.js — o que todo estilo do Menu Iniciar tem: o campo de
// busca e a tela de resultados (lib/start/search.js), e as respostas que a
// casca (startMenu.js) espera de um estilo:
//
//   actor         o conteúdo, posto dentro da caixa do menu
//   size          [largura, altura] desejados, em pixels lógicos
//   placement     null (segue a opção) ou 'center' (estilo que só faz
//                 sentido no centro, como a Grade flutuante)
//   entry         o campo de busca (digitar em qualquer lugar cai nele)
//   areas         as áreas que o Tab percorre, em ordem
//   reset()       ao abrir: limpa a busca e atualiza as listas
//   refresh()     os fixados/recentes mudaram
//   escape()      Esc: devolve true se usou a tecla (ex.: limpar a busca)
//   handleKey()   teclas especiais do estilo (ex.: PageDown)
//   focusInitial()

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SearchView} from '../search.js';

export class BaseStyle {
    /**
     * @param {object} menu - a casca (startMenu.js)
     * @param {number} factor - tamanho: 0.86 pequeno, 1 médio, 1.16 grande
     * @param {object} params
     * @param {string} params.id
     * @param {number} params.width - largura no tamanho médio
     * @param {number} params.height - altura no tamanho médio
     * @param {boolean} [params.vertical]
     */
    constructor(menu, factor, {id, width, height, vertical = true}) {
        this.id = id;
        this.menu = menu;
        this.data = menu.data;
        this.factor = factor;
        this.size = [Math.round(width * factor), Math.round(height * factor)];
        this.placement = null;
        this.entry = null;
        this._areas = [];
        this._hiddenWhileSearching = [];
        this.actor = new St.BoxLayout({
            style_class: 'orla-start-layout',
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            x_expand: true, y_expand: true,
        });
        this.results = new SearchView(menu);
        this.results.actor.visible = false;
    }

    /** Quantas colunas de `cell` px cabem em `width` px (do tamanho médio). */
    columnsFor(width, cell) {
        return Math.max(3, Math.floor((width * this.factor) / cell));
    }

    get areas() {
        return this.searching ? [this.entry, this.results.actor] : this._areas;
    }

    /** O campo de busca, já ligado à tela de resultados. */
    makeEntry(hint = _('Type to search apps, files and settings')) {
        const entry = new St.Entry({
            style_class: 'orla-start-search',
            hint_text: hint,
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'orla-start-search-icon'}),
        });
        entry.clutter_text.connect('text-changed', () => this._onText(entry.get_text()));
        entry.clutter_text.connect('key-press-event', (_t, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                const ctrl = Boolean(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
                if (this.searching)
                    this.results.activateFirst(ctrl);
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Down) {
                if (this.searching)
                    this.results.focusFirst();
                else
                    this.focusContent();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.entry = entry;
        return entry;
    }

    /** Estes atores somem enquanto há uma busca (os resultados ocupam o lugar). */
    hideWhileSearching(...actors) {
        this._hiddenWhileSearching.push(...actors);
    }

    get searching() {
        return Boolean(this.entry?.get_text().trim());
    }

    _onText(text) {
        const on = Boolean(text.trim());
        this.setSearching(on);
        if (on)
            this.results.setQuery(text);
    }

    setSearching(on) {
        this.results.actor.visible = on;
        for (const actor of this._hiddenWhileSearching)
            actor.visible = !on && actor._orlaWanted !== false;
    }

    /** Mostra/esconde um ator respeitando a busca (fica escondido durante ela). */
    setWanted(actor, wanted) {
        actor._orlaWanted = wanted;
        actor.visible = wanted && !(this.searching && this._hiddenWhileSearching.includes(actor));
    }

    reset() {
        this.entry?.set_text('');
        this.setSearching(false);
        this.refresh();
    }

    refresh() {}

    escape() {
        if (this.entry?.get_text()) {
            this.entry.set_text('');
            this.entry.grab_key_focus();
            return true;
        }
        return false;
    }

    handleKey(_event) {
        return false;
    }

    focusInitial() {
        this.entry?.grab_key_focus();
    }

    focusContent() {
        const area = this._areas.find(a => a !== this.entry && a.visible);
        area?.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    destroy() {
        this.results.destroy();
        this.actor.destroy();
    }
}
