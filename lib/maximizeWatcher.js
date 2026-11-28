// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
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
//
// Também CONFERE se cada janela maximizada ocupa mesmo a área útil do lado
// da dock. Apps Chromium/Electron no Wayland (Brave, VS Code, Discord…) às
// vezes ignoram o tamanho novo quando a área útil muda com a janela já
// maximizada, e ficam com um vão até a dock. Nesse caso refazemos o
// "maximizar" uma vez — o mesmo que desmaximizar e maximizar à mão.

import Meta from 'gi://Meta';

import {IdleRunner, Position} from './utils.js';

// Folga (px) para arredondamentos de escala fracionária.
const FILL_TOLERANCE = 2;

export class MaximizeWatcher {
    /**
     * @param {Function} onChanged - chamado quando a resposta pode ter mudado
     * @param {Function} dockSide - (monitor) → posição da dock nele, ou null
     */
    constructor(onChanged, dockSide = () => null) {
        this._dockSide = dockSide;
        this._nudged = new Set();       // já refeitas nesta maximização
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
        const maximizeChanged = () => {
            // Desmaximizou de verdade (não é a nossa "refação"): a próxima
            // maximização pode ser conferida de novo.
            if (!win.is_maximized() && this._nudging !== win)
                this._nudged.delete(win);
            now();
        };
        win.connectObject(
            'notify::maximized-horizontally', maximizeChanged,
            'notify::maximized-vertically', maximizeChanged,
            'notify::minimized', now,
            'workspace-changed', now,
            // Lado a lado numa dock lateral depende de qual lado a janela
            // ocupa (geometria): reavaliamos quando ela muda de tamanho.
            // O app entregou um tamanho novo: se está maximizada e não chegou
            // até a dock, corrigimos NA HORA (sem esperar).
            'size-changed', () => {
                this._changed.queue();
                this._checkFill(win);
            },
            'shown', () => {
                this._shown.add(win);
                this._checkFill(win);
                now();
            },
            'unmanaged', () => {
                win.disconnectObject(this);
                this._windows.delete(win);
                this._shown.delete(win);
                this._nudged.delete(win);
                now();
            },
            this);
    }

    // ---------- Janela maximizada que não ocupa a área útil ----------

    /** Quantos px faltam para a janela chegar à borda da área útil da dock. */
    _gapToDock(win) {
        const monitor = win.get_monitor();
        const side = this._dockSide(monitor);
        if (side === null || side === undefined)
            return 0;
        const area = win.get_work_area_for_monitor(monitor);
        const rect = win.get_frame_rect();
        switch (side) {
        case Position.BOTTOM: return (area.y + area.height) - (rect.y + rect.height);
        case Position.TOP: return rect.y - area.y;
        case Position.LEFT: return rect.x - area.x;
        default: return (area.x + area.width) - (rect.x + rect.width);
        }
    }

    _checkFill(win) {
        if (!this._windows.has(win) || !this._shown.has(win) || this._nudged.has(win) ||
            win.minimized || !win.is_maximized())
            return;
        const gap = this._gapToDock(win);
        if (gap <= FILL_TOLERANCE)
            return;
        // Uma vez por maximização (um app que não consegue ocupar o espaço,
        // por ter tamanho fixo, não entra num vai e vem).
        this._nudged.add(win);
        console.debug(`Orla Dock: "${win.get_wm_class() ?? win.get_title()}" maximizada a ${gap}px da dock; ` +
            'refazendo o maximizar para o app pegar o tamanho certo');
        this._nudging = win;
        try {
            win.unmaximize();
            win.maximize();
        } finally {
            this._nudging = null;
        }
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
        this._nudged.clear();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const win of this._windows)
            win.disconnectObject(this);
        this._windows.clear();
        this._shown.clear();
    }
}
