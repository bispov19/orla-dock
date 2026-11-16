// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// calendarIcon.js — ícone do Calendário que mostra o dia de HOJE, no estilo
// do iOS em modo escuro: o tile escuro de vidro do tema Brisa, o dia da
// semana em coral em cima ("Seg.") e o número do dia grande e fino.
//
// É desenhado com cairo num St.DrawingArea: assim o tile tem a mesma
// superelipse, gradiente, borda e brilho dos ícones do tema, e fica nítido
// em qualquer tamanho (a dock cria o ícone já no tamanho máximo da ampliação).

import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

const CALENDAR_APP_IDS = ['org.gnome.Calendar.desktop', 'gnome-calendar.desktop'];

// Medidas num quadro de 128 unidades, iguais às do tema Brisa: tile de 120
// com margem de 4 (o tamanho padrão dos ícones de apps), superelipse de
// expoente 5. O texto foi medido num tile de 112 e escala junto com ele.
const TILE_SIDE = 120, TILE_X = (128 - TILE_SIDE) / 2, EXPONENT = 5;
const TEXT_SCALE = TILE_SIDE / 112;
const FONT = 'Adwaita Sans';
const CORAL = [0xF0 / 255, 0x68 / 255, 0x5A / 255, 1];
const WHITE = [0xF2 / 255, 0xF2 / 255, 0xF5 / 255, 1];

export function isCalendarApp(app) {
    return CALENDAR_APP_IDS.includes(app?.get_id());
}

/** Texto que identifica o dia (para saber quando ele muda). */
export function todayKey() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

/** Dia da semana abreviado no idioma do sistema: "Seg.", "Ter."... */
function weekdayLabel(now) {
    let label = now.format('%a').replace(/\.$/, '');
    label = label.charAt(0).toUpperCase() + label.slice(1);
    if (GLib.get_language_names()[0].startsWith('pt'))
        label += '.';
    return label;
}

function superellipse(cr, x, y, side) {
    const a = side / 2, cx = x + a, cy = y + a, steps = 144;
    for (let i = 0; i < steps; i++) {
        const t = (i / steps) * 2 * Math.PI;
        const c = Math.cos(t), s = Math.sin(t);
        const px = cx + a * Math.sign(c) * Math.abs(c) ** (2 / EXPONENT);
        const py = cy + a * Math.sign(s) * Math.abs(s) ** (2 / EXPONENT);
        if (i === 0)
            cr.moveTo(px, py);
        else
            cr.lineTo(px, py);
    }
    cr.closePath();
}

/** Escreve `text` centralizado em `cx`, com a linha de base em `baseline`. */
function drawText(cr, text, size, weight, cx, baseline, rgba) {
    const layout = PangoCairo.create_layout(cr);
    const desc = Pango.FontDescription.from_string(FONT);
    desc.set_weight(weight);
    desc.set_absolute_size(size * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_text(text, -1);
    const [, logical] = layout.get_pixel_extents();
    cr.setSourceRGBA(...rgba);
    cr.moveTo(cx - logical.width / 2 - logical.x, baseline - layout.get_baseline() / Pango.SCALE);
    PangoCairo.show_layout(cr, layout);
}

function paintTile(cr) {
    const bottom = TILE_X + TILE_SIDE;

    superellipse(cr, TILE_X, TILE_X, TILE_SIDE);
    const fill = new Cairo.LinearGradient(0, TILE_X, 0, bottom);
    fill.addColorStopRGB(0, 0x2B / 255, 0x2B / 255, 0x2E / 255);
    fill.addColorStopRGB(1, 0x15 / 255, 0x15 / 255, 0x17 / 255);
    cr.setSource(fill);
    cr.fillPreserve();

    cr.save();
    cr.clip();
    // Reflexo de vidro na metade de cima.
    const glare = new Cairo.LinearGradient(0, TILE_X, 0, 64);
    glare.addColorStopRGBA(0, 1, 1, 1, 0.07);
    glare.addColorStopRGBA(1, 1, 1, 1, 0);
    cr.setSource(glare);
    cr.rectangle(TILE_X, TILE_X, TILE_SIDE, TILE_SIDE / 2);
    cr.fill();
    // Borda interna de 1 unidade (traço de 2 recortado pelo tile).
    superellipse(cr, TILE_X, TILE_X, TILE_SIDE);
    cr.setLineWidth(2);
    cr.setSourceRGBA(1, 1, 1, 0.18);
    cr.strokePreserve();
    // Brilho fino só no topo.
    const shine = new Cairo.LinearGradient(0, TILE_X, 0, TILE_X + 26);
    shine.addColorStopRGBA(0, 1, 1, 1, 0.55);
    shine.addColorStopRGBA(0.4, 1, 1, 1, 0.12);
    shine.addColorStopRGBA(1, 1, 1, 1, 0);
    cr.setSource(shine);
    cr.stroke();
    cr.restore();
}

// ── Modo "seguir o tema de ícones" ──────────────────────────────────────
// Temas como o Brisa regravam o ícone do Calendário com a data de hoje. O
// Shell guarda as texturas dos ícones pelo nome, então recarregar pelo nome
// mostraria a data antiga: aqui o arquivo é lido direto do disco.

let iconTheme = null;

/** Caminho do ícone do Calendário no tema de ícones atual, ou null. */
export function themeCalendarFile(app, size = 128) {
    const gicon = app?.get_icon();
    if (!gicon)
        return null;
    iconTheme ??= new St.IconTheme();
    return iconTheme.lookup_by_gicon(gicon, size, 0)?.get_filename() ?? null;
}

/** Pasta raiz do tema de ícones que contém `path` (a que tem index.theme). */
export function iconThemeRoot(path) {
    let dir = path ? Gio.File.new_for_path(path).get_parent() : null;
    while (dir && !dir.get_child('index.theme').query_exists(null))
        dir = dir.get_parent();
    return dir;
}

/** O ícone do Calendário do tema atual, lido do arquivo (sem cache por nome). */
export function createThemeCalendarIcon(app, size) {
    const path = themeCalendarFile(app, size);
    if (!path)
        return null;
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new St.Icon({gicon: Gio.BytesIcon.new(new GLib.Bytes(bytes)), icon_size: size});
    } catch {
        return null;
    }
}

/** Cria o ícone no tamanho `size` (px lógicos). */
export function createCalendarIcon(size) {
    const now = GLib.DateTime.new_now_local();
    const weekday = weekdayLabel(now);
    const day = now.format('%e').trim();

    const area = new St.DrawingArea({width: size, height: size});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const k = Math.min(w, h) / 128;
        cr.translate((w - 128 * k) / 2, (h - 128 * k) / 2);
        cr.scale(k, k);

        paintTile(cr);
        cr.translate(64, 64);
        cr.scale(TEXT_SCALE, TEXT_SCALE);
        cr.translate(-64, -64);
        drawText(cr, weekday, 20, Pango.Weight.SEMIBOLD, 64, 46, CORAL);
        drawText(cr, day, 62, Pango.Weight.LIGHT, 64, 103, WHITE);
        cr.$dispose();
    });
    return area;
}
