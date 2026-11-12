// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// genieMath.js — a matemática do efeito Gênio, sem nada do GNOME (por isso
// pode ser testada fora do Shell, com `node`).
//
// Trabalhamos num sistema de coordenadas próprio, para a mesma fórmula
// servir nas 4 posições da dock:
//   a = eixo que aponta PARA a dock (ex.: para baixo, na dock inferior)
//   c = eixo paralelo à borda da dock

export const Position = Object.freeze({BOTTOM: 0, TOP: 1, LEFT: 2, RIGHT: 3});

const BEND_END = 0.4;       // até 40% do tempo o funil se forma
const SLIDE_START = 0.18;   // a partir de 18% a janela começa a escorrer
const NECK_RATIO = 0.7;     // largura final = 70% do ícone
const MIN_NECK = 12;

const clamp01 = t => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = t => t * t * (3 - 2 * t);
const easeInOutSine = t => 0.5 - Math.cos(Math.PI * t) / 2;
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function toGenieSpace({x, y, width: w, height: h}, position) {
    switch (position) {
    case Position.TOP: return {c0: x, c1: x + w, a0: -(y + h), a1: -y};
    case Position.LEFT: return {c0: y, c1: y + h, a0: -(x + w), a1: -x};
    case Position.RIGHT: return {c0: y, c1: y + h, a0: x, a1: x + w};
    default: return {c0: x, c1: x + w, a0: y, a1: y + h};
    }
}

/**
 * Prepara os dados da animação.
 *
 * @param {number} position - borda da dock
 * @param {number} w - largura da janela
 * @param {number} h - altura da janela
 * @param {object} icon - retângulo do ícone RELATIVO à janela
 * @returns {object}
 */
export function genieSetup(position, w, h, icon) {
    const win = toGenieSpace({x: 0, y: 0, width: w, height: h}, position);
    const ic = toGenieSpace(icon, position);
    const iconA = (ic.a0 + ic.a1) / 2;
    return {
        position, w, h, win,
        iconC: (ic.c0 + ic.c1) / 2,
        // "Pescoço" do funil: 70% do ícone, centrado nele.
        neck: Math.max(MIN_NECK, (ic.c1 - ic.c0) * NECK_RATIO) / 2,
        // Distância do lado da janela mais longe da dock até o centro do ícone.
        reach: Math.max(1, iconA - win.a0),
    };
}

/**
 * Para onde vai o ponto (tx, ty) da textura da janela (0..1) no instante
 * `t` (0 = janela normal, 1 = dentro do ícone). Devolve [x, y] relativos à
 * janela, em pixels.
 */
export function genieVertex(s, tx, ty, t) {
    let u, f;   // u = ao longo da borda; f = 0 (longe da dock) .. 1 (perto)
    switch (s.position) {
    case Position.TOP: u = tx; f = 1 - ty; break;
    case Position.LEFT: u = ty; f = 1 - tx; break;
    case Position.RIGHT: u = ty; f = tx; break;
    default: u = tx; f = ty;
    }
    const bend = easeInOutSine(clamp01(t / BEND_END));
    const slide = easeInOutCubic(clamp01((t - SLIDE_START) / (1 - SLIDE_START)));

    // Cada linha da janela "escorre" em direção ao ícone e para nele.
    const along = Math.min(s.reach, f * (s.win.a1 - s.win.a0) + slide * s.reach);
    // Quanto mais perto do ícone, mais estreita (curva suave).
    const pinch = bend * smoothstep(clamp01(along / s.reach));
    const low = lerp(s.win.c0, s.iconC - s.neck, pinch);
    const high = lerp(s.win.c1, s.iconC + s.neck, pinch);
    const c = low + u * (high - low);
    const a = s.win.a0 + along;

    switch (s.position) {
    case Position.TOP: return [c, -a];
    case Position.LEFT: return [-a, c];
    case Position.RIGHT: return [a, c];
    default: return [c, a];
    }
}
