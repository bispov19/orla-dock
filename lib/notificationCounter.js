// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// notificationCounter.js — conta as notificações do GNOME de cada app,
// para mostrar a bolinha com o número no ícone.
//
// Cada app que manda notificações tem uma "fonte" (MessageTray.Source) na
// central de notificações (Main.messageTray). Cada fonte guarda a lista das
// notificações ainda não dispensadas. Nós:
//   - escutamos fontes novas/removidas ('source-added', 'source-removed');
//   - em cada fonte, escutamos notificações novas ('notification-added');
//   - em cada notificação, escutamos quando ela some ('destroy').
// A cada mudança, avisamos (sinal 'changed') com o ID do app.

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {IdleRunner} from './utils.js';

// Fontes "genéricas" não pertencem a um app específico.
const GENERIC_POLICY_ID = 'generic';

export class NotificationCounter extends EventEmitter {
    constructor() {
        super();
        this._sources = new Set();
        // Quando uma notificação some, a fonte ainda pode estar tirando-a da
        // lista; por isso juntamos os avisos e emitimos no momento ocioso.
        this._pending = new Set();
        this._flush = new IdleRunner(() => {
            const ids = [...this._pending];
            this._pending.clear();
            ids.forEach(id => this.emit('changed', id));
        });
        Main.messageTray.connectObject(
            'source-added', (_tray, source) => this._trackSource(source),
            'source-removed', (_tray, source) => this._untrackSource(source),
            this);
        Main.messageTray.getSources().forEach(source => this._trackSource(source));
    }

    destroy() {
        this._flush.cancel();
        Main.messageTray.disconnectObject(this);
        for (const source of this._sources) {
            source.disconnectObject(this);
            source.notifications.forEach(n => n.disconnectObject?.(this));
        }
        this._sources.clear();
    }

    /** Quantas notificações não dispensadas o app tem. */
    count(appId) {
        const id = appId.toLowerCase();
        let total = 0;
        for (const source of this._sources) {
            if (this._appIdOf(source) === id)
                total += source.notifications.length;
        }
        return total;
    }

    /** De qual app é esta fonte? (ID do .desktop, em minúsculas) */
    _appIdOf(source) {
        if (source.app)
            return source.app.get_id().toLowerCase();
        const policyId = source.policy?.id ?? '';
        if (!policyId || policyId === GENERIC_POLICY_ID)
            return '';
        return `${policyId}.desktop`.toLowerCase();
    }

    _trackSource(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject('notification-added',
            (_s, notification) => this._trackNotification(source, notification), this);
        source.notifications.forEach(n => this._trackNotification(source, n));
    }

    _untrackSource(source) {
        if (!this._sources.delete(source))
            return;
        source.disconnectObject(this);
        this._changed(source);
    }

    _trackNotification(source, notification) {
        // 'destroy' = a notificação foi dispensada, lida ou expirou.
        notification.connectObject('destroy', () => this._changed(source), this);
        this._changed(source);
    }

    _changed(source) {
        const appId = this._appIdOf(source);
        if (appId) {
            this._pending.add(appId);
            this._flush.queue();
        }
    }
}
