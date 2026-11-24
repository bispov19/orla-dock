// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/placement.js — ONDE o Menu Iniciar aparece e DE ONDE ele cresce.
// Um módulo só, usado por todos os estilos.
//
// A âncora é sempre o botão de aplicativos da dock do monitor (a posição
// real dele na tela, já com ampliação e deslocamentos). Sem botão, o meio
// da barra; sem dock no monitor, o meio da borda de baixo do monitor.
//
//   modo 'dock'    o menu sai do botão: centralizado nele, do lado de
//                  dentro da tela (acima de uma dock embaixo, à direita de
//                  uma dock à esquerda…). Faltando espaço, ele desliza ao
//                  longo da dock até caber, sem perder o lado do botão.
//   modo 'corner'  no canto da área livre do lado onde a dock começa.
//   modo 'center'  no centro da área livre (a Grade flutuante usa sempre).
//
// Em todos os modos a animação nasce no botão: o "pivô" (ponto fixo da
// escala) é o centro do botão, e o deslize inicial vem da direção dele.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Position} from '../utils.js';

const GAP = 10;          // entre a dock e o menu
const SAFE = 12;         // margem segura das bordas da tela
const SLIDE = 14;        // tamanho do deslize de entrada

/**
 * A âncora no monitor: retângulo do botão (ou da barra) e o lado da dock.
 * @returns {{rect: {x, y, w, h}, side: number, bar: object|null}}
 */
export function anchorOf(dock, monitor) {
    const actor = dock?.startButton?.get_stage() ? dock.startButton
        : dock?.backgroundActor?.get_stage() ? dock.backgroundActor : null;
    const side = dock?.axis.position ?? Position.BOTTOM;
    if (!actor) {
        // Sem dock: o meio da borda de baixo.
        return {rect: {x: monitor.x + monitor.width / 2, y: monitor.y + monitor.height, w: 0, h: 0},
            side: Position.BOTTOM, bar: null};
    }
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    const bar = dock.backgroundActor;
    const [bx, by] = bar.get_transformed_position();
    const [bw, bh] = bar.get_transformed_size();
    return {rect: {x, y, w, h}, side, bar: {x: bx, y: by, w: bw, h: bh}};
}

/**
 * A área livre do monitor: a área de trabalho do GNOME (sem a barra de
 * cima) menos a dock (que pode não reservar espaço, no auto-ocultar),
 * com a margem segura.
 */
export function freeArea(monitor, anchor, scale) {
    let {x, y, width, height} = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
    const bar = anchor.bar;
    if (bar) {
        switch (anchor.side) {
        case Position.TOP: {
            const bottom = bar.y + bar.h;
            if (bottom > y) {
                height -= bottom - y;
                y = bottom;
            }
            break;
        }
        case Position.LEFT: {
            const right = bar.x + bar.w;
            if (right > x) {
                width -= right - x;
                x = right;
            }
            break;
        }
        case Position.RIGHT:
            width = Math.min(width, bar.x - x);
            break;
        default:
            height = Math.min(height, bar.y - y);
        }
    }
    const safe = SAFE * scale;
    return {x: x + safe, y: y + safe, width: width - 2 * safe, height: height - 2 * safe};
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * Onde pôr um menu de `width`×`height` e como animá-lo.
 * @returns {{x, y, width, height, pivot: [number, number], slide: [number, number]}}
 *   x/y absolutos; pivot normalizado (0..1 dentro do menu, pode passar);
 *   slide = deslocamento inicial da entrada.
 */
export function placeMenu({monitor, anchor, mode, width, height, scale}) {
    const free = freeArea(monitor, anchor, scale);
    width = Math.min(width, free.width);
    height = Math.min(height, free.height);
    const {rect, side} = anchor;
    const ax = rect.x + rect.w / 2;
    const ay = rect.y + rect.h / 2;
    const gap = GAP * scale;
    let x, y;

    if (mode === 'center') {
        x = free.x + (free.width - width) / 2;
        y = free.y + (free.height - height) / 2;
    } else if (mode === 'corner') {
        x = side === Position.RIGHT ? free.x + free.width - width : free.x;
        y = side === Position.BOTTOM ? free.y + free.height - height : free.y;
    } else {
        const bar = anchor.bar ?? {x: rect.x, y: rect.y, w: rect.w, h: rect.h};
        switch (side) {
        case Position.TOP:
            x = ax - width / 2;
            y = bar.y + bar.h + gap;
            break;
        case Position.LEFT:
            x = bar.x + bar.w + gap;
            y = ay - height / 2;
            break;
        case Position.RIGHT:
            x = bar.x - gap - width;
            y = ay - height / 2;
            break;
        default:
            x = ax - width / 2;
            y = bar.y - gap - height;
        }
    }
    // Nunca sai da área livre (nem do monitor).
    x = clamp(x, free.x, free.x + free.width - width);
    y = clamp(y, free.y, free.y + free.height - height);
    x = Math.round(x);
    y = Math.round(y);

    // O pivô é o botão; o deslize vem da direção dele, curto.
    const pivot = [(ax - x) / width, (ay - y) / height];
    const dx = ax - (x + width / 2);
    const dy = ay - (y + height / 2);
    const length = Math.hypot(dx, dy) || 1;
    const slide = [dx / length * SLIDE * scale, dy / length * SLIDE * scale];
    return {x, y, width, height, pivot, slide};
}
