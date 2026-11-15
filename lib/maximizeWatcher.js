// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// maximizeWatcher.js — "tem janela maximizada neste monitor?"
//
// Usado pela opção "encostar na borda quando houver janela maximizada".
// Vigiamos o que pode mudar a resposta — maximizar/restaurar, minimizar,
// fechar, mudar de monitor e trocar de workspace — e avisamos (no máximo
// uma vez por ciclo, com IdleRunner) para cada dock se reavaliar.

import Meta from 'gi://Meta';

import {IdleRunner} from './utils.js';

export class MaximizeWatcher {
    /** @param {Function} onChanged - chamado quando a resposta pode ter mudado */
    constructor(onChanged) {
        this._windows = new Set();
        this._changed = new IdleRunner(onChanged);
        const queue = () => this._changed.queue();

        global.display.connectObject(
            'window-created', (_d, win) => {
                this._watch(win);
                queue();
            },
            'window-entered-monitor', queue,
            'window-left-monitor', queue,
            this);
        global.workspace_manager.connectObject('active-workspace-changed', queue, this);
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    _watch(win) {
        if (!win || this._windows.has(win))
            return;
        this._windows.add(win);
        const queue = () => this._changed.queue();
        win.connectObject(
            'notify::maximized-horizontally', queue,
            'notify::maximized-vertically', queue,
            'notify::minimized', queue,
            'workspace-changed', queue,
            'unmanaged', () => {
                win.disconnectObject(this);
                this._windows.delete(win);
                queue();
            },
            this);
    }

    /** Há uma janela maximizada e visível no monitor, no workspace atual? */
    hasMaximized(monitorIndex) {
        const workspace = global.workspace_manager.get_active_workspace();
        for (const win of this._windows) {
            if (win.minimized || win.get_monitor() !== monitorIndex ||
                win.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            if (!win.is_on_all_workspaces() && win.get_workspace() !== workspace)
                continue;
            if (win.is_maximized())
                return true;
        }
        return false;
    }

    destroy() {
        this._changed.cancel();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const win of this._windows)
            win.disconnectObject(this);
        this._windows.clear();
    }
}
