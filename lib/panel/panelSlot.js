// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// panel/panelSlot.js — "pegar emprestado" um pedaço do painel do GNOME.
//
// No modo Painel, itens da barra de cima (relógio, configurações rápidas…)
// passam a morar dentro da barra de tarefas. Isso é feito MOVENDO o próprio
// ator do GNOME, e não criando uma cópia: assim o menu dele continua
// funcionando, preso ao botão, agora na barra de baixo.
//
// Tudo o que mudamos num ator do GNOME precisa ser desfeito no disable().
// O PanelSlot anota cada mudança (de onde o ator saiu, que propriedades
// foram trocadas, que sinais ligamos) e o restore() desfaz na ordem inversa.

export class PanelSlot {
    constructor() {
        this._moves = [];       // {actor, parent, index}
        this._props = [];       // {actor, saved}
        this._signals = new Set();
        this._dead = new WeakSet();
    }

    /** Lembra quando um ator do GNOME é destruído (para não tocar nele). */
    watch(actor) {
        this._watch(actor);
        return actor;
    }

    _watch(actor) {
        if (actor._orlaSlotWatched)
            return;
        actor._orlaSlotWatched = true;
        actor.connect('destroy', () => this._dead.add(actor));
    }

    alive(actor) {
        return Boolean(actor) && !this._dead.has(actor);
    }

    /** Tira `actor` de onde está e põe dentro de `newParent`. */
    move(actor, newParent) {
        this._watch(actor);
        const parent = actor.get_parent();
        if (parent) {
            this._watch(parent);
            this._moves.push({actor, parent, index: parent.get_children().indexOf(actor)});
            parent.remove_child(actor);
        }
        newParent.add_child(actor);
    }

    /** Troca propriedades (visible, style, x_align…), guardando as originais. */
    set(actor, props) {
        this._watch(actor);
        const saved = {};
        for (const key of Object.keys(props))
            saved[key] = actor[key];
        this._props.push({actor, saved});
        Object.assign(actor, props);
    }

    /** Liga sinais num ator do GNOME; o restore() desliga. */
    connect(actor, ...args) {
        actor.connectObject(...args, this);
        this._signals.add(actor);
    }

    restore() {
        for (const actor of this._signals) {
            if (this.alive(actor))
                actor.disconnectObject(this);
        }
        this._signals.clear();

        for (const {actor, saved} of this._props.reverse()) {
            if (this.alive(actor))
                Object.assign(actor, saved);
        }
        this._props = [];

        for (const {actor, parent, index} of this._moves.reverse()) {
            if (!this.alive(actor) || !this.alive(parent))
                continue;
            actor.get_parent()?.remove_child(actor);
            parent.insert_child_at_index(actor, Math.min(index, parent.get_n_children()));
        }
        this._moves = [];
    }
}
