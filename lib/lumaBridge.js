// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// lumaBridge.js — a "ponte" entre a Orla e os módulos vindos da Luma Dock.
//
// O modo painel das barras de tarefas (bandeja com seta, relógio, indicador
// de workspaces, configurações rápidas, calendário) e o Menu Iniciar vêm da
// Luma Dock (lib/luma/). Esses módulos conversam com "a dock" por um objeto
// chamado `dockUI`: perguntam a posição, o fundo, pedem para reorganizar a
// barra, para o auto-ocultar segurar a dock visível etc.
//
// Esta classe É esse objeto, só que por dentro ela responde com as peças da
// Orla. Assim os módulos da Luma ficam praticamente como eram lá.

import {hexToRgb, rgba} from './themes.js';
import {IdleRunner} from './utils.js';

const POSITIONS = ['BOTTOM', 'TOP', 'LEFT', 'RIGHT'];

export class LumaBridge {
    /** @param {Dock} dock - a dock da Orla (lib/dock.js) */
    constructor(dock) {
        this._dock = dock;
        this.settings = dock.settings;
        this.activeTrayMenu = null;     // a Luma guarda aqui o menu da bandeja aberto
        this._trayDragging = false;
        // Os módulos pedem "reorganize a barra" várias vezes seguidas (cada
        // item que muda de tamanho): juntamos tudo num relayout só.
        this._relayout = new IdleRunner(() => {
            if (!dock.destroyed)
                dock.relayout();
        });

        const autohide = () => dock.autohide;
        this.autoHideManager = {
            show: () => autohide()?.show(),
            scheduleCheck: () => autohide()?.sync(),
            setTrayDragging: dragging => {
                this._trayDragging = dragging;
                autohide()?.sync();
            },
        };
        this.monitorManager = {getCurrentMonitor: () => dock.monitor};

        // Os "Fixados" do Menu Iniciar partem dos apps fixados da dock, e o
        // menu de contexto dele fixa/desafixa na dock.
        const tracker = dock.manager.appTracker;
        this.appManager = {
            getDockOrder: () => tracker.getPinned().map(app => app.get_id()),
            getFolders: () => [],
            hasApp: app => tracker.isPinned(app),
            addApp: app => tracker.pin(app.get_id()),
            removeApp: app => tracker.unpin(app.get_id()),
        };

        // Com o Menu Iniciar aberto, a ampliação da dock fica parada.
        dock.root._orlaPauseZoom = paused => {
            if (paused)
                dock.resetZoom();
        };
    }

    get dockPosition() {
        return POSITIONS[this._dock.axis.position];
    }

    /** O ator da dock inteira. */
    get actor() {
        return this._dock.root;
    }

    /** O fundo visível da barra: menus e o Menu Iniciar se alinham a ele. */
    get bgActor() {
        return this._dock.backgroundActor;
    }

    /** A bandeja está com o menu aberto ou arrastando um ícone? */
    get busy() {
        return this._trayDragging || Boolean(this.activeTrayMenu);
    }

    syncPanelSpace() {
        this._relayout.queue();
    }

    updateLayout() {
        this._relayout.queue();
    }

    checkPanelOverflow() {
        this._relayout.queue();
    }

    queueRender() {
        this._dock.rebuild();
    }

    /**
     * Cores do "balão" dos menus da Luma (Menu Iniciar e bandeja), com o
     * tema da Orla: o mesmo fundo dos rótulos e Stacks e o contorno da dock.
     */
    popupBubbleColors() {
        const s = this.settings;
        const css = this._dock.look?.popupCss ?? '';
        const match = css.match(/background-color:\s*([^;]+);/);
        const fill = s.get_boolean('blur-enabled')
            ? 'rgba(0, 0, 0, 0)'
            : (match ? match[1].trim() : 'rgba(24, 24, 31, 0.92)');
        return {
            fill,
            stroke: rgba(hexToRgb(s.get_string('border-color')), s.get_double('border-opacity')),
            strokeWidth: Math.max(1, s.get_int('border-width')),
        };
    }

    destroy() {
        this._relayout.cancel();
        delete this._dock.root._orlaPauseZoom;
        this._dock = null;
    }
}
