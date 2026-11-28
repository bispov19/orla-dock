// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// launcherEntry.js — bolinhas de notificação e barras de progresso.
//
// Muitos apps (Telegram, Thunderbird, Firefox ao baixar, Nautilus ao
// copiar…) anunciam um contador e um progresso usando a API "Unity
// LauncherEntry": eles emitem um SINAL no barramento D-Bus da sessão:
//
//   interface: com.canonical.Unity.LauncherEntry
//   sinal:     Update(s app_uri, a{sv} propriedades)
//   ex.:       Update("application://org.telegram.desktop.desktop",
//                     {"count": <int64 3>, "count-visible": <true>})
//
// D-Bus é o "sistema de mensagens" entre programas no Linux. Aqui a
// extensão só ESCUTA esses sinais (signal_subscribe) — nenhum processo
// extra é criado.

import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const IFACE = 'com.canonical.Unity.LauncherEntry';

export class LauncherEntry extends EventEmitter {
    constructor() {
        super();
        this._entries = new Map();   // appId → {count, countVisible, ...}
        this._subscription = Gio.DBus.session.signal_subscribe(
            null, IFACE, 'Update', null, null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => this._onUpdate(params));
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._subscription);
        this._entries.clear();
    }

    get(appId) {
        return this._entries.get(appId) ?? null;
    }

    _onUpdate(params) {
        let uri, props;
        try {
            [uri, props] = params.deepUnpack();
        } catch {
            return;
        }
        let appId = uri.replace(/^application:\/\//, '');
        if (!appId.endsWith('.desktop'))
            appId += '.desktop';

        const entry = this._entries.get(appId) ?? {
            count: 0, countVisible: false,
            progress: 0, progressVisible: false,
            urgent: false,
        };
        // Cada valor chega "embrulhado" num GLib.Variant; unpack() desembrulha.
        const read = key => props[key]?.unpack();
        if ('count' in props)
            entry.count = Number(read('count'));
        if ('count-visible' in props)
            entry.countVisible = read('count-visible');
        if ('progress' in props)
            entry.progress = read('progress');
        if ('progress-visible' in props)
            entry.progressVisible = read('progress-visible');
        if ('urgent' in props)
            entry.urgent = read('urgent');

        this._entries.set(appId, entry);
        this.emit('changed', appId);
    }
}
