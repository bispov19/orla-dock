// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// notificationCounter.js — quantas notificações do GNOME cada app tem em
// aberto, para a bolinha com o número no ícone.
//
// Na central de notificações (Main.messageTray), cada app que notifica tem
// uma "fonte". Montamos um placar: app → conjunto das notificações dele que
// ainda não foram dispensadas. O placar muda em três momentos:
//   - uma fonte aparece: entram as notificações que ela já tem;
//   - uma notificação nova chega: entra no conjunto do app;
//   - uma notificação some (lida, dispensada, expirada): sai do conjunto.
// Quando o placar de um app muda, avisamos com o sinal 'changed' (id do app).

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {IdleRunner} from './utils.js';

export class NotificationCounter extends EventEmitter {
    constructor() {
        super();
        this._board = new Map();        // id do app → Set de notificações
        this._watched = new Set();      // fontes que já estamos ouvindo
        // Vários avisos seguidos (ex.: "limpar tudo") viram um só por app.
        this._dirty = new Set();
        this._announce = new IdleRunner(() => {
            const apps = [...this._dirty];
            this._dirty.clear();
            for (const app of apps)
                this.emit('changed', app);
        });

        const tray = Main.messageTray;
        tray.connectObject(
            'source-added', (_t, source) => this._listen(source),
            'source-removed', (_t, source) => this._forget(source),
            this);
        for (const source of tray.getSources())
            this._listen(source);
    }

    /** Notificações em aberto do app (id do .desktop). */
    count(appId) {
        return this._board.get(appId.toLowerCase())?.size ?? 0;
    }

    /**
     * O app dono da fonte, em minúsculas, ou '' se a fonte não for de um
     * app (o GNOME usa uma política "genérica" para essas).
     */
    _owner(source) {
        const app = source.app?.get_id();
        if (app)
            return app.toLowerCase();
        const policy = source.policy?.id;
        return policy && policy !== 'generic' ? `${policy}.desktop`.toLowerCase() : '';
    }

    _listen(source) {
        if (this._watched.has(source))
            return;
        this._watched.add(source);
        source.connectObject('notification-added', (_s, note) => this._add(source, note), this);
        for (const note of source.notifications)
            this._add(source, note);
    }

    _forget(source) {
        if (!this._watched.delete(source))
            return;
        source.disconnectObject(this);
        for (const note of source.notifications)
            this._remove(source, note);
    }

    _add(source, note) {
        const owner = this._owner(source);
        if (!owner)
            return;
        if (!this._board.has(owner))
            this._board.set(owner, new Set());
        this._board.get(owner).add(note);
        note.connectObject('destroy', () => this._remove(source, note), this);
        this._touch(owner);
    }

    _remove(source, note) {
        const owner = this._owner(source);
        const notes = this._board.get(owner);
        if (!notes?.delete(note))
            return;
        if (!notes.size)
            this._board.delete(owner);
        this._touch(owner);
    }

    _touch(owner) {
        this._dirty.add(owner);
        this._announce.queue();
    }

    destroy() {
        this._announce.cancel();
        Main.messageTray.disconnectObject(this);
        for (const source of this._watched) {
            source.disconnectObject(this);
            for (const note of source.notifications)
                note.disconnectObject?.(this);
        }
        this._watched.clear();
        this._board.clear();
    }
}
