// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// maximizeWatcher.js — "tem janela ocupando a altura/largura da tela, do
// lado da dock, neste monitor?"
//
// Usado pela opção "encostar na borda quando houver janela maximizada".
// Vigiamos o que pode mudar a resposta — maximizar/restaurar, pôr lado a
// lado, minimizar, fechar, mudar de monitor e trocar de workspace.
//
// O aviso é IMEDIATO (no mesmo instante do sinal): a dock começa a deslizar
// no mesmo quadro em que a janela maximiza. Só o que acontece muitas vezes
// seguidas (a janela mudando de tamanho num arraste) passa pela fila
// ociosa (IdleRunner), que junta tudo num aviso só.

import Meta from 'gi://Meta';

import {IdleRunner, Position} from './utils.js';

export class MaximizeWatcher {
    /** @param {Function} onChanged - chamado quando a resposta pode ter mudado */
    constructor(onChanged) {
        this._windows = new Set();
        // Janelas que JÁ apareceram na tela. Uma janela pode nascer
        // maximizada: se a dock encostar antes de ela aparecer, o Mutter não
        // a estica depois (ela ficaria com o vão da margem). Por isso só
        // contamos a janela a partir do primeiro 'shown'.
        this._shown = new Set();
        this._changed = new IdleRunner(onChanged);
        // `now`: avisa já (e descarta um aviso atrasado que estivesse na fila).
        this._now = () => {
            this._changed.cancel();
            onChanged();
        };
        const now = this._now;

        global.display.connectObject(
            'window-created', (_d, win) => {
                this._watch(win);
                this._changed.queue();
            },
            'window-entered-monitor', now,
            'window-left-monitor', now,
            this);
        global.workspace_manager.connectObject('active-workspace-changed', now, this);
        for (const actor of global.get_window_actors()) {
            this._watch(actor.meta_window);
            this._shown.add(actor.meta_window);
        }
    }

    _watch(win) {
        if (!win || this._windows.has(win))
            return;
        this._windows.add(win);
        const now = this._now;
        win.connectObject(
            'notify::maximized-horizontally', now,
            'notify::maximized-vertically', now,
            'notify::minimized', now,
            'workspace-changed', now,
            // Lado a lado numa dock lateral depende de qual lado a janela
            // ocupa (geometria): reavaliamos quando ela muda de tamanho.
            'size-changed', () => this._changed.queue(),
            'shown', () => {
                this._shown.add(win);
                now();
            },
            'unmanaged', () => {
                win.disconnectObject(this);
                this._windows.delete(win);
                this._shown.delete(win);
                now();
            },
            this);
    }

    /**
     * Há, no monitor e no workspace atual, uma janela visível que vai até o
     * lado da dock? Vale a maximizada e também a lado a lado (Super+←/→):
     * ela ocupa a altura inteira, então encosta numa dock embaixo ou em
     * cima; numa dock lateral, só se estiver do mesmo lado.
     */
    hasMaximized(monitorIndex, position = Position.BOTTOM) {
        const workspace = global.workspace_manager.get_active_workspace();
        const side = position === Position.LEFT || position === Position.RIGHT;
        for (const win of this._windows) {
            if (!this._shown.has(win) || win.minimized || win.get_monitor() !== monitorIndex ||
                win.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            if (!win.is_on_all_workspaces() && win.get_workspace() !== workspace)
                continue;
            if (win.is_maximized())
                return true;
            if (!win.maximized_vertically)
                continue;
            if (!side || this._touchesSide(win, workspace, monitorIndex, position))
                return true;
        }
        return false;
    }

    _touchesSide(win, workspace, monitorIndex, position) {
        const area = workspace.get_work_area_for_monitor(monitorIndex);
        const rect = win.get_frame_rect();
        return position === Position.LEFT
            ? rect.x <= area.x + 1
            : rect.x + rect.width >= area.x + area.width - 1;
    }

    destroy() {
        this._changed.cancel();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const win of this._windows)
            win.disconnectObject(this);
        this._windows.clear();
        this._shown.clear();
    }
}
