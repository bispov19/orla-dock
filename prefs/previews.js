// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/previews.js — desenhos das prévias (estilo da barra e posição).
//
// Tudo é desenhado com o Cairo (a biblioteca de desenho 2D do GTK) num
// Gtk.DrawingArea. A prévia do estilo NÃO depende do nome do estilo: ela lê
// as "marcas" dele em lib/styles.js (ocupa a borda inteira? tem orbe? funde
// a barra de cima?…). Assim um estilo novo já nasce com prévia.

import cairo from 'gi://cairo';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// Cores dos "apps" de mentira (iguais em todas as prévias).
const APP_COLORS = [
    [0.36, 0.62, 0.98], [0.98, 0.55, 0.24], [0.30, 0.80, 0.52],
    [0.86, 0.36, 0.62], [0.96, 0.80, 0.30], [0.52, 0.46, 0.94],
];
const ACCENT = [0.21, 0.52, 0.89];
const Position = {BOTTOM: 0, TOP: 1, LEFT: 2, RIGHT: 3};

export function roundedRect(cr, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/** Papel de parede de mentira: um degradê com um brilho. */
function paintBackdrop(cr, w, h) {
    const base = new cairo.LinearGradient(0, 0, w, h);
    base.addColorStopRGB(0, 0.14, 0.20, 0.36);
    base.addColorStopRGB(1, 0.30, 0.18, 0.38);
    cr.setSource(base);
    cr.paint();
    const glow = new cairo.RadialGradient(w * 0.72, h * 0.25, 0, w * 0.72, h * 0.25, w * 0.55);
    glow.addColorStopRGBA(0, 0.98, 0.64, 0.42, 0.40);
    glow.addColorStopRGBA(1, 0.98, 0.64, 0.42, 0);
    cr.setSource(glow);
    cr.paint();
}

/** Uma janela de mentira no meio da tela (dá noção de escala). */
function paintWindow(cr, x, y, w, h) {
    roundedRect(cr, x, y, w, h, Math.max(3, h * 0.04));
    cr.setSourceRGBA(0.95, 0.95, 0.97, 0.92);
    cr.fill();
    roundedRect(cr, x, y, w, Math.max(6, h * 0.12), Math.max(3, h * 0.04));
    cr.setSourceRGBA(0.85, 0.85, 0.88, 1);
    cr.fill();
    cr.setSourceRGBA(0.6, 0.6, 0.65, 0.5);
    for (let i = 0; i < 3; i++) {
        roundedRect(cr, x + w * 0.08, y + h * (0.28 + i * 0.18), w * (0.7 - i * 0.15), Math.max(2, h * 0.06), 2);
        cr.fill();
    }
}

function text(cr, str, x, y, size, rgba, align = 'center') {
    cr.selectFontFace('Sans', 0, 1);
    cr.setFontSize(size);
    const ext = cr.textExtents(str);
    const dx = align === 'center' ? -ext.width / 2 : align === 'right' ? -ext.width : 0;
    cr.moveTo(x + dx, y);
    cr.setSourceRGBA(...rgba);
    cr.showText(str);
    return ext.width;
}

function clockText() {
    return GLib.DateTime.new_now_local().format('%H:%M');
}

/** Ícone de app: um quadrado arredondado colorido. */
function appIcon(cr, x, y, s, [r, g, b]) {
    roundedRect(cr, x, y, s, s, s * 0.24);
    cr.setSourceRGB(r, g, b);
    cr.fill();
}

/** Botão de aplicativos: orbe (Windows 7), grade solta (GNOME) ou grade num círculo. */
function appsButton(cr, x, y, s, style) {
    if (style.startOrb) {
        const orb = s * 1.25;
        const cx = x + s / 2, cy = y + s / 2;
        const g = new cairo.LinearGradient(0, cy - orb / 2, 0, cy + orb / 2);
        g.addColorStopRGB(0, 0.45, 0.73, 1);
        g.addColorStopRGB(1, 0.05, 0.24, 0.6);
        cr.arc(cx, cy, orb / 2, 0, 2 * Math.PI);
        cr.setSource(g);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.6);
        cr.setLineWidth(1);
        cr.stroke();
        cr.arc(cx, cy - orb * 0.18, orb * 0.3, Math.PI, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 0.28);
        cr.fill();
        return;
    }
    if (style.appsButtonAtEnd) {
        const dot = s / 6;
        cr.setSourceRGBA(1, 1, 1, 0.92);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                cr.arc(x + dot * (1 + i * 2), y + dot * (1 + j * 2), dot * 0.62, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        return;
    }
    // Genérico (sem logo de ninguém): uma grade num círculo azul.
    cr.arc(x + s / 2, y + s / 2, s / 2, 0, 2 * Math.PI);
    cr.setSourceRGB(...ACCENT);
    cr.fill();
    const dot = s / 9;
    cr.setSourceRGBA(1, 1, 1, 0.95);
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            cr.arc(x + s / 2 + i * dot * 2.2, y + s / 2 + j * dot * 2.2, dot * 0.7, 0, 2 * Math.PI);
            cr.fill();
        }
    }
}

/** Barra de ponta a ponta (barras de tarefas). */
function paintTaskbar(cr, w, h, style) {
    const bh = Math.max(14, h * 0.12);
    const y = h - bh;
    if (style.glassSheen) {
        const g = new cairo.LinearGradient(0, y, 0, h);
        g.addColorStopRGBA(0, 0.42, 0.52, 0.66, 0.88);
        g.addColorStopRGBA(1, 0.12, 0.16, 0.24, 0.92);
        cr.rectangle(0, y, w, bh);
        cr.setSource(g);
        cr.fill();
        cr.rectangle(0, y, w, 1);
        cr.setSourceRGBA(1, 1, 1, 0.45);
        cr.fill();
    } else {
        cr.rectangle(0, y, w, bh);
        cr.setSourceRGBA(0.10, 0.10, 0.13, 0.94);
        cr.fill();
    }

    const icon = bh * 0.56;
    const cell = icon * (style.runningFrame ? 1.9 : 1.75);
    const cy = y + (bh - icon) / 2;
    let x = (cell - icon) / 2;
    appsButton(cr, x, cy, icon, style);
    x += cell;
    if (style.mergePanel) {
        // "Atividades" da barra de cima, logo depois do botão.
        roundedRect(cr, x, y + bh / 2 - icon * 0.14, icon * 0.6, icon * 0.28, icon * 0.14);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.fill();
        cr.arc(x + icon * 0.85, y + bh / 2, icon * 0.09, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 0.5);
        cr.fill();
        x += icon * 1.3;
    }
    APP_COLORS.forEach((color, i) => {
        const cellX = x + i * cell;
        const running = i < 3;
        if (style.runningFrame && running) {
            roundedRect(cr, cellX + 1, y + 2, cell - 2, bh - 4, 3);
            const g = new cairo.LinearGradient(0, y, 0, h);
            g.addColorStopRGBA(0, 1, 1, 1, i === 0 ? 0.38 : 0.24);
            g.addColorStopRGBA(1, 1, 1, 1, 0.06);
            cr.setSource(g);
            cr.fillPreserve();
            cr.setSourceRGBA(1, 1, 1, 0.4);
            cr.setLineWidth(1);
            cr.stroke();
        } else if (i === 0 && style.cellHighlight) {
            cr.rectangle(cellX, y, cell, bh);
            cr.setSourceRGBA(1, 1, 1, 0.14);
            cr.fill();
        }
        appIcon(cr, cellX + (cell - icon) / 2, cy, icon, color);
        if (style.edgeIndicator && running) {
            cr.rectangle(cellX + cell * 0.15, h - 2, cell * 0.7, 2);
            cr.setSourceRGB(...ACCENT);
            cr.fill();
        }
    });

    // Fim: relógio (e a bandeja da barra de cima, se fundida).
    const right = w - 6;
    const clockW = text(cr, clockText(), right, y + bh / 2 + (style.mergePanel ? 3 : -1),
        Math.max(7, bh * 0.32), [1, 1, 1, 0.95], 'right');
    if (!style.mergePanel)
        text(cr, GLib.DateTime.new_now_local().format('%d/%m'), right - clockW / 2, y + bh * 0.82,
            Math.max(6, bh * 0.26), [1, 1, 1, 0.8]);
    if (style.mergePanel) {
        cr.setSourceRGBA(1, 1, 1, 0.85);
        for (let i = 0; i < 4; i++) {
            roundedRect(cr, right - clockW - 10 - (i + 1) * icon * 0.55, y + bh / 2 - icon * 0.18,
                icon * 0.36, icon * 0.36, 2);
            cr.fill();
        }
    }
}

/** Dock flutuante (macOS e GNOME). */
function paintFloatingDock(cr, w, h, style) {
    const icon = Math.max(8, h * 0.085);
    const gap = style.appsButtonAtEnd ? icon * 0.45 : icon * 0.22;
    const pad = icon * 0.3;
    // Ampliação: os ícones perto do "cursor" (o 3º) crescem.
    const scales = APP_COLORS.map((_c, i) =>
        style.magnification ? 1 + 0.7 * Math.max(0, 1 - Math.abs(i - 2) / 2.2) : 1);
    const appsWidth = scales.reduce((sum, sc) => sum + icon * sc + gap, 0);
    const extra = icon + gap + (style.separators ? gap * 2 : 0);   // botão de apps
    const dockW = appsWidth + extra + pad * 2;
    const dockH = icon + pad * 2;
    const margin = h * 0.035;
    const x0 = (w - dockW) / 2;
    const y0 = h - dockH - margin;

    roundedRect(cr, x0, y0, dockW, dockH, dockH * (style.appsButtonAtEnd ? 0.32 : 0.36));
    cr.setSourceRGBA(0.12, 0.12, 0.16, style.appsButtonAtEnd ? 0.85 : 0.72);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, 0.18);
    cr.setLineWidth(1);
    cr.stroke();

    let x = x0 + pad;
    const base = y0 + pad + icon;     // os ícones crescem para cima
    const separator = () => {
        cr.rectangle(x + gap / 2, y0 + pad * 1.2, 1, icon - pad * 0.4);
        cr.setSourceRGBA(1, 1, 1, 0.35);
        cr.fill();
        x += gap * 2;
    };
    if (!style.appsButtonAtEnd) {
        appsButton(cr, x, base - icon, icon, style);
        x += icon + gap;
        if (style.separators)
            separator();
    }
    APP_COLORS.forEach((color, i) => {
        const s = icon * scales[i];
        const lift = style.magnification ? (scales[i] - 1) * icon * 0.35 : 0;
        if (style.cellHighlight && i === 1) {
            roundedRect(cr, x - gap * 0.35, base - s - gap * 0.35, s + gap * 0.7, s + gap * 0.7, s * 0.28);
            cr.setSourceRGBA(1, 1, 1, 0.16);
            cr.fill();
        }
        appIcon(cr, x, base - s - lift, s, color);
        if (i < 3) {
            cr.arc(x + s / 2, y0 + dockH - pad * 0.45, Math.max(1.2, icon * 0.06), 0, 2 * Math.PI);
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.fill();
        }
        x += s + gap;
    });
    if (style.appsButtonAtEnd) {
        if (style.separators)
            separator();
        appsButton(cr, x, base - icon, icon, style);
    }
}

/**
 * Prévia de um estilo de barra numa "tela" w × h.
 *
 * @param {object} style - um estilo de lib/styles.js
 */
export function paintStylePreview(cr, w, h, style) {
    roundedRect(cr, 0, 0, w, h, Math.min(14, h * 0.07));
    cr.clip();
    paintBackdrop(cr, w, h);
    paintWindow(cr, w * 0.2, h * 0.18, w * 0.5, h * 0.48);
    // Barra de cima do GNOME: some quando a barra de tarefas a absorve.
    if (!style.mergePanel) {
        const th = Math.max(6, h * 0.06);
        cr.rectangle(0, 0, w, th);
        cr.setSourceRGBA(0, 0, 0, 0.85);
        cr.fill();
        text(cr, clockText(), w / 2, th * 0.75, th * 0.62, [1, 1, 1, 0.9]);
        cr.setSourceRGBA(1, 1, 1, 0.8);
        for (let i = 0; i < 3; i++) {
            cr.arc(w - th * (1 + i * 1.1), th / 2, th * 0.2, 0, 2 * Math.PI);
            cr.fill();
        }
    }
    if (style.fullWidth)
        paintTaskbar(cr, w, h, style);
    else
        paintFloatingDock(cr, w, h, style);
}

/**
 * Prévia de uma POSIÇÃO: um monitor com a barra naquele lado. Barras de
 * tarefas ocupam a borda inteira; docks ficam centralizadas.
 */
export function paintPositionPreview(cr, w, h, position, style, selected) {
    roundedRect(cr, 1, 1, w - 2, h - 2, 7);
    cr.save();
    cr.clip();
    paintBackdrop(cr, w, h);
    cr.restore();
    roundedRect(cr, 1, 1, w - 2, h - 2, 7);
    cr.setSourceRGBA(1, 1, 1, selected ? 0.55 : 0.25);
    cr.setLineWidth(selected ? 2 : 1);
    cr.stroke();

    const vertical = position === Position.LEFT || position === Position.RIGHT;
    const thick = Math.max(6, Math.min(w, h) * 0.13);
    const gap = style.fullWidth ? 0 : 4;
    const long = style.fullWidth ? (vertical ? h - 2 : w - 2) : (vertical ? h * 0.62 : w * 0.62);
    let x = (w - long) / 2, y = (h - long) / 2;
    if (position === Position.BOTTOM)
        y = h - thick - gap - (style.fullWidth ? 1 : 0);
    else if (position === Position.TOP)
        y = gap + (style.fullWidth ? 1 : 0);
    else if (position === Position.LEFT)
        x = gap + (style.fullWidth ? 1 : 0);
    else
        x = w - thick - gap - (style.fullWidth ? 1 : 0);
    const [bw, bh] = vertical ? [thick, long] : [long, thick];
    roundedRect(cr, x, y, bw, bh, style.fullWidth ? 0 : thick * 0.35);
    cr.setSourceRGBA(0.1, 0.1, 0.13, 0.9);
    cr.fill();

    // Ícones de mentira ao longo da barra.
    const icon = thick * 0.56;
    const count = 5;
    const step = icon * 1.45;
    const start = (style.fullWidth ? thick * 0.3 : (long - step * count) / 2 + (step - icon) / 2) + 1;
    for (let i = 0; i < count; i++) {
        const along = start + i * step;
        const across = (thick - icon) / 2;
        const [ix, iy] = vertical ? [x + across, y + along] : [x + along, y + across];
        appIcon(cr, ix, iy, icon, APP_COLORS[i]);
    }
}

/** Um Gtk.DrawingArea que chama `paint(cr, w, h)` para se desenhar. */
export function drawingArea(width, height, paint, params = {}) {
    const area = new Gtk.DrawingArea({content_width: width, content_height: height, ...params});
    area.set_draw_func((_area, cr, w, h) => {
        paint(cr, w, h);
        cr.$dispose();
    });
    return area;
}
