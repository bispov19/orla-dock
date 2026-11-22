// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// utils.js — utilidades compartilhadas, principalmente a lógica de "eixos".
//
// A dock pode ficar em 4 bordas. Em vez de escrever "se for embaixo faça X,
// se for na esquerda faça Y…" em todo lugar, pensamos em dois eixos:
//
//   - eixo PRINCIPAL ("main"): a direção em que os ícones ficam enfileirados
//     (horizontal na dock inferior/superior, vertical na esquerda/direita);
//   - eixo CRUZADO ("cross"): perpendicular ao principal; é a "espessura"
//     da dock e a direção em que o ícone cresce na ampliação.
//
// A classe Axis converte (principal, cruzado) <-> (x, y). Assim, a matemática
// da ampliação, do arrastar e do auto-ocultar é escrita uma vez só e
// funciona nas 4 posições.

import GLib from 'gi://GLib';
import St from 'gi://St';

export const Position = Object.freeze({
    BOTTOM: 0,
    TOP: 1,
    LEFT: 2,
    RIGHT: 3,
});

export class Axis {
    constructor(position) {
        this.position = position;
        this.vertical = position === Position.LEFT || position === Position.RIGHT;
        // A borda "de fora" (colada na tela) está no fim do eixo cruzado
        // para inferior/direita e no começo para superior/esquerda.
        this.edgeAtEnd = position === Position.BOTTOM || position === Position.RIGHT;
        // Sinal da direção "para longe da borda" (para onde o ícone cresce).
        this.awaySign = this.edgeAtEnd ? -1 : 1;
    }

    /** Lado do St (usado por menus e popups para posicionar a "setinha"). */
    get side() {
        return [St.Side.BOTTOM, St.Side.TOP, St.Side.LEFT, St.Side.RIGHT][this.position];
    }

    main(x, y) {
        return this.vertical ? y : x;
    }

    cross(x, y) {
        return this.vertical ? x : y;
    }

    /** Converte (principal, cruzado) em [x, y]. */
    toXY(main, cross) {
        return this.vertical ? [cross, main] : [main, cross];
    }

    /** Propriedade de translação do eixo principal/cruzado. */
    get mainTranslation() {
        return this.vertical ? 'translation_y' : 'translation_x';
    }

    get crossTranslation() {
        return this.vertical ? 'translation_x' : 'translation_y';
    }

    /**
     * Ponto de pivô (0..1) no lado colado à borda, centralizado no eixo
     * principal. É em volta dele que o ícone escala, para crescer "para
     * cima" (ou para o lado oposto à borda).
     */
    get edgePivot() {
        const crossPivot = this.edgeAtEnd ? 1 : 0;
        return this.vertical ? [crossPivot, 0.5] : [0.5, crossPivot];
    }
}

/**
 * Agenda `callback` para rodar uma vez só no próximo momento ocioso, mesmo
 * que seja pedido várias vezes seguidas ("debounce"). Útil quando vários
 * sinais chegam juntos e queremos reagir uma única vez.
 */
export class IdleRunner {
    constructor(callback, priority = GLib.PRIORITY_DEFAULT_IDLE) {
        this._callback = callback;
        this._priority = priority;
        this._id = 0;
    }

    queue() {
        if (this._id)
            return;
        this._id = GLib.idle_add(this._priority, () => {
            this._id = 0;
            this._callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}

/**
 * Um timeout (em ms) que pode ser reiniciado e cancelado com segurança.
 * Sempre cancelar no destroy() para não deixar callbacks soltos depois que
 * a extensão foi desativada.
 */
export class Timeout {
    constructor() {
        this._id = 0;
    }

    start(ms, callback) {
        this.cancel();
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._id = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Variante que repete enquanto o callback retornar true. */
    startRepeating(ms, callback) {
        this.cancel();
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (callback() === true)
                return GLib.SOURCE_CONTINUE;
            this._id = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    get active() {
        return this._id !== 0;
    }

    cancel() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}

/** Respeita a opção "Reduzir animações" de acessibilidade do GNOME. */
export function animationsEnabled() {
    const settings = St.Settings.get();
    return settings.enable_animations &&
        settings.reduced_motion !== St.ReducedMotion.REDUCE;
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// ---------- "Depois" (no próximo momento ocioso) ----------

const _later = new Set();

/**
 * Roda `fn` no próximo momento ocioso — por exemplo, para uma ação de menu
 * acontecer depois que o menu termina de fechar. Cada pedido fica
 * registrado para que cancelAllLater() (chamado no disable) não deixe nada
 * pendente no laço principal.
 */
export function later(fn) {
    const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        _later.delete(id);
        fn();
        return GLib.SOURCE_REMOVE;
    });
    _later.add(id);
}

/** Cancela tudo o que ainda estava esperando em later(). */
export function cancelAllLater() {
    for (const id of _later)
        GLib.source_remove(id);
    _later.clear();
}
