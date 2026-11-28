// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// appTracker.js — o "modelo" da dock: decide QUAIS apps aparecem e em que
// ordem. Não desenha nada (isso é trabalho do dock.js); só observa o sistema
// e avisa (sinal 'changed') quando a lista muda.
//
// APIs do GNOME usadas:
//   - Shell.AppSystem: catálogo de apps instalados e em execução.
//     Sinais: 'app-state-changed' (abriu/fechou), 'installed-changed'.
//   - Shell.AppUsage: histórico de uso que o próprio GNOME mantém (é o que
//     alimenta os "Frequentes" da grade de apps). Usamos para sugerir apps.
//   - global.settings: o GSettings "org.gnome.shell", onde fica a lista
//     'favorite-apps' — os apps fixados, compartilhados com o Dash do GNOME.
//
// Seções da dock (separadas por divisórias):
//   [fixados] | [abertos não fixados + recentes] | [stacks, lixeira]

import Shell from 'gi://Shell';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {IdleRunner} from './utils.js';
import {isHiddenWindow} from './windowFilter.js';

const FAVORITES_KEY = 'favorite-apps';
const MAX_RECENT = 3;

export class AppTracker extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        // Ordem estável dos apps abertos não fixados: o primeiro que abriu
        // fica à esquerda, como no Mac (get_running() reordena por uso).
        this._runningOrder = [];

        // Vários sinais costumam chegar juntos (ex.: um app abre 2 janelas);
        // o IdleRunner junta tudo num único 'changed'.
        this._changed = new IdleRunner(() => this.emit('changed'));

        this._favorites.connectObject('changed', () => this._changed.queue(), this);
        this._appSystem.connectObject(
            'installed-changed', () => this._changed.queue(),
            'app-state-changed', (_sys, app) => this._onAppStateChanged(app),
            this);
        this._settings.connectObject(
            'changed::show-recent', () => this._changed.queue(),
            'changed::recent-apps', () => this._changed.queue(),
            this);
    }

    destroy() {
        this._changed.cancel();
        this._favorites.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        this._settings.disconnectObject(this);
    }

    _onAppStateChanged(app) {
        // Quando um app não fixado é fechado, ele vira "recente".
        if (app.state === Shell.AppState.STOPPED && !this.isPinned(app))
            this._pushRecent(app.get_id());
        this._changed.queue();
    }

    _pushRecent(appId) {
        const recent = this._settings.get_strv('recent-apps')
            .filter(id => id !== appId);
        recent.unshift(appId);
        this._settings.set_strv('recent-apps', recent.slice(0, MAX_RECENT));
    }

    // ---------- Consultas ----------

    isPinned(app) {
        return this._favorites.isFavorite(app.get_id());
    }

    getPinned() {
        return this._favorites.getFavorites();
    }

    /** Pede para a dock se refazer (ex.: uma janela ganhou a sua classe). */
    queueChanged() {
        this._changed.queue();
    }

    /** Apps abertos que não estão fixados, em ordem estável. */
    getRunningUnpinned() {
        // Só conta um app se ele tiver ao menos uma janela que a dock "vê"
        // (as Janelas ocultas não fazem um ícone aparecer).
        const running = this._appSystem.get_running()
            .filter(app => !this.isPinned(app) && getAppWindows(app).length > 0);
        const ids = running.map(app => app.get_id());
        // Mantém a ordem antiga e acrescenta os novos no fim.
        this._runningOrder = this._runningOrder.filter(id => ids.includes(id));
        for (const id of ids) {
            if (!this._runningOrder.includes(id))
                this._runningOrder.push(id);
        }
        return this._runningOrder.map(id => running.find(a => a.get_id() === id));
    }

    /**
     * Apps recentes/sugeridos: os últimos fechados; se ainda não houver
     * histórico, usamos os mais usados segundo o próprio GNOME.
     */
    getRecent() {
        if (!this._settings.get_boolean('show-recent'))
            return [];

        const isCandidate = app => app && !this.isPinned(app) &&
            app.state === Shell.AppState.STOPPED;

        let apps = this._settings.get_strv('recent-apps')
            .map(id => this._appSystem.lookup_app(id))
            .filter(isCandidate);

        if (apps.length === 0) {
            apps = Shell.AppUsage.get_default().get_most_used()
                .filter(isCandidate);
        }
        return apps.slice(0, MAX_RECENT);
    }

    // ---------- Fixar / desafixar ----------
    //
    // Escrevemos direto na lista 'favorite-apps' do GSettings do Shell em vez
    // de usar AppFavorites.addFavorite(): o método público mostra uma
    // notificação ("Fixado no Dash"), e no Mac isso é silencioso.

    /** Fixa (ou move) `appId` para a posição `index` entre os fixados. */
    pinAt(appId, index) {
        const ids = global.settings.get_strv(FAVORITES_KEY).filter(id => id !== appId);
        const visible = this.getPinned()
            .map(app => app.get_id())
            .filter(id => id !== appId);

        let insertAt = ids.length;
        if (index >= 0 && index < visible.length)
            insertAt = ids.indexOf(visible[index]);
        ids.splice(insertAt, 0, appId);
        global.settings.set_strv(FAVORITES_KEY, ids);
    }

    pin(appId) {
        this.pinAt(appId, -1);
    }

    unpin(appId) {
        const ids = global.settings.get_strv(FAVORITES_KEY).filter(id => id !== appId);
        global.settings.set_strv(FAVORITES_KEY, ids);
    }
}

/**
 * Janelas de um app que a dock mostra, em ordem estável (de criação).
 * Ficam de fora as que não aparecem na barra de tarefas e as "Janelas
 * ocultas" das preferências.
 */
export function getAppWindows(app) {
    return app.get_windows()
        .filter(w => !w.skip_taskbar && !isHiddenWindow(w))
        .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
}
