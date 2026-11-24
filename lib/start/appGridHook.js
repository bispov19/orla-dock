// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/appGridHook.js — faz tudo o que abriria a App Grid do GNOME abrir
// o Menu Iniciar da Orla (opção "Usar menu iniciar no lugar da App Grid").
//
// Como o GNOME Shell 51 abre a App Grid (lido em overviewControls.js e
// overview.js deste GNOME):
//   - duplo Super: o 2º aperto, com a Visão Geral ainda abrindo, chama
//     _shiftState(UP) → _stateAdjustment.ease(APP_GRID);
//   - botão de grade do dash: ao marcar o botão, _onShowAppsButtonToggled
//     → _stateAdjustment.ease(APP_GRID);
//   - Super+A (atalho toggle-application-view): com a Visão Geral aberta,
//     marca o botão (caminho acima); fechada, Main.overview.show(APP_GRID);
//   - Main.overview.showApps() (usado também pelo botão da própria Orla)
//     → Main.overview.show(APP_GRID).
// Todos terminam em DOIS pontos: Main.overview.show(APP_GRID) e
// _stateAdjustment.ease(APP_GRID). Interceptamos só esses dois, e só na
// INSTÂNCIA (nada no protótipo das classes do GNOME). Para qualquer outro
// destino (ex.: a Visão Geral com as janelas), chamamos o original: um
// aperto de Super continua igual. Os sinais e atalhos do GNOME não são
// tocados — eles foram ligados com .bind() e seguiriam chamando o código
// antigo de qualquer forma.
//
// disable() devolve as duas funções exatamente como estavam.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

export class AppGridHook {
    /** @param {Function} openMenu - abre o Menu Iniciar */
    constructor(openMenu) {
        this._openMenu = openMenu;
        this._patches = [];     // {target, name, ours, hadOwn, previous}
        this._waiting = false;
    }

    get active() {
        return this._patches.length > 0;
    }

    enable() {
        if (this.active)
            return;
        const overview = Main.overview;
        const controls = overview._overview?.controls;
        const adjustment = controls?._stateAdjustment;
        if (!controls || !adjustment) {
            console.log('[Orla Dock] Visão Geral diferente do esperado; a App Grid continua a do GNOME.');
            return;
        }
        const hook = this;
        this._controls = controls;

        // Main.overview.show(estado): Super+A com a Visão Geral fechada,
        // showApps() e o botão de apps da própria Orla.
        this._patch(overview, 'show', original => function (state, ...rest) {
            if (state === ControlsState.APP_GRID) {
                hook._redirect();
                return undefined;
            }
            return original.call(this, state, ...rest);
        });

        // A "régua" de estados da Visão Geral: duplo Super e o botão de
        // grade do dash a animam até APP_GRID.
        this._patch(adjustment, 'ease', original => function (value, params) {
            if (value === ControlsState.APP_GRID) {
                hook._redirect();
                return undefined;
            }
            return original.call(this, value, params);
        });
    }

    /**
     * Troca `target[name]` por uma função nossa, guardando o que havia
     * (inclusive se outra extensão já tinha trocado antes de nós).
     */
    _patch(target, name, make) {
        const hadOwn = Object.prototype.hasOwnProperty.call(target, name);
        const previous = target[name];
        const ours = make(previous);
        target[name] = ours;
        this._patches.push({target, name, ours, hadOwn, previous});
    }

    /** Em vez da App Grid: fecha a Visão Geral (se aberta) e abre o menu. */
    _redirect() {
        // O botão de grade do dash ficou marcado; desmarcamos sem disparar
        // de novo a troca de estado (o GNOME tem essa trava para isso).
        const button = this._controls?.dash?.showAppsButton;
        if (button?.checked) {
            const before = this._controls._ignoreShowAppsButtonToggle;
            this._controls._ignoreShowAppsButtonToggle = true;
            button.checked = false;
            this._controls._ignoreShowAppsButtonToggle = before;
        }
        if (!Main.overview.visible) {
            this._openMenu();
            return;
        }
        // Com a Visão Geral aberta, o menu abre quando ela termina de sair
        // (as duas não podem segurar o teclado ao mesmo tempo).
        if (this._waiting)
            return;
        this._waiting = true;
        Main.overview.connectObject('hidden', () => {
            Main.overview.disconnectObject(this);
            this._waiting = false;
            if (this.active)
                this._openMenu();
        }, this);
        Main.overview.hide();
    }

    disable() {
        if (this._waiting) {
            Main.overview.disconnectObject(this);
            this._waiting = false;
        }
        for (const {target, name, ours, hadOwn, previous} of this._patches.reverse()) {
            if (target[name] !== ours) {
                // Outra extensão trocou depois de nós: não desfazemos a dela.
                console.log(`[Orla Dock] ${name} foi trocado por outra extensão depois da Orla; mantido.`);
                continue;
            }
            if (hadOwn)
                target[name] = previous;
            else
                delete target[name];
        }
        this._patches = [];
        this._controls = null;
    }
}
