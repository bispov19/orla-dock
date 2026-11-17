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
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
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
const _samples = new Map();   // caminho + data de modificação → cores e medidas

/** Solta os caches do módulo (chamado no disable da extensão). */
export function releaseCalendarCaches() {
    iconTheme = null;
    _samples.clear();
}

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

/**
 * O tema mantém a data em dia? Só temas como o Brisa regravam o ícone todo
 * dia; nos outros a data é fixa (o Conflux mostra sempre "OCT 02") ou nem
 * existe. Consideramos em dia o arquivo modificado HOJE — e, se for SVG,
 * que traga o número de hoje escrito como texto.
 */
function themeIconIsToday(path, bytes) {
    try {
        const info = Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const modified = info.get_modification_date_time().to_local();
        const now = GLib.DateTime.new_now_local();
        if (modified.format('%Y-%m-%d') !== now.format('%Y-%m-%d'))
            return false;
        if (!path.endsWith('.svg'))
            return true;
        const svg = new TextDecoder().decode(bytes);
        return new RegExp(`>\\s*${now.format('%e').trim()}\\s*<`).test(svg);
    } catch {
        return false;
    }
}

// ── A folha com a data, por cima de um ícone de tema sem data em dia ──────


const luminance = ([r, g, b]) => {
    const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

/**
 * Lê o ícone do tema em 64×64 e descobre: onde fica o "tile" (a parte não
 * transparente), a cor de fundo da área central (a mais comum) e a cor de
 * destaque (a mais viva: o vermelho do Conflux, o roxo do GNOME...).
 */
function sampleThemeIcon(path) {
    let key = path;
    try {
        key += Gio.File.new_for_path(path).query_info('time::modified', 0, null)
            .get_modification_date_time().to_unix();
    } catch {}
    if (_samples.has(key))
        return _samples.get(key);

    const N = 64;
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, N, N);
    const {width: w, height: h, rowstride: stride} = pixbuf;
    const channels = pixbuf.get_n_channels();
    const alphaAt = pixbuf.get_has_alpha() ? 3 : -1;
    const px = pixbuf.get_pixels();
    const at = (x, y) => {
        const i = y * stride + x * channels;
        return [px[i], px[i + 1], px[i + 2], alphaAt < 0 ? 255 : px[i + alphaAt]];
    };

    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (at(x, y)[3] > 160) {
                x0 = Math.min(x0, x); y0 = Math.min(y0, y);
                x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            }
        }
    }
    if (x1 <= x0 || y1 <= y0) {
        x0 = y0 = 0;
        x1 = w - 1;
        y1 = h - 1;
    }
    const tile = {x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h};

    // Fundo: a cor mais comum no meio do tile (agrupando tons parecidos).
    const counts = new Map();
    let accent = null, bestChroma = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const [r, g, b, a] = at(x, y);
            if (a < 200)
                continue;
            const chroma = Math.max(r, g, b) - Math.min(r, g, b);
            if (chroma > bestChroma) {
                bestChroma = chroma;
                accent = [r, g, b];
            }
            const inCenter = x > x0 + (x1 - x0) * 0.25 && x < x0 + (x1 - x0) * 0.75 &&
                y > y0 + (y1 - y0) * 0.35 && y < y0 + (y1 - y0) * 0.85;
            if (!inCenter)
                continue;
            const k = `${r >> 4},${g >> 4},${b >> 4}`;
            const entry = counts.get(k) ?? {n: 0, rgb: [r, g, b]};
            entry.n++;
            counts.set(k, entry);
        }
    }
    const background = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.rgb ?? [245, 245, 245];
    const ink = luminance(background) > 0.35 ? [28, 28, 30] : [242, 242, 245];
    // Destaque só se for colorido de verdade e legível sobre o fundo.
    const day = accent && bestChroma > 60 && contrast(accent, background) >= 2.5 ? accent : ink;

    // Cor "de fundo" de uma linha: a mais comum numa faixa à esquerda do
    // centro (longe do texto e dos pontos da grade).
    const rowColor = y => {
        const seen = new Map();
        for (let x = Math.round(x0 + (x1 - x0) * 0.12); x <= x0 + (x1 - x0) * 0.32; x++) {
            const [r, g, b, a] = at(x, y);
            if (a < 200)
                continue;
            const k = `${r >> 4},${g >> 4},${b >> 4}`;
            const entry = seen.get(k) ?? {n: 0, rgb: [r, g, b]};
            entry.n++;
            seen.set(k, entry);
        }
        return [...seen.values()].sort((a, b) => b.n - a.n)[0]?.rgb ?? background;
    };
    const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 90;

    // Faixa de cabeçalho (o topo roxo do Calendário do GNOME): linhas do
    // alto do tile com cor bem diferente do fundo. A folha começa abaixo
    // dela; sem faixa (Conflux), começa alto para cobrir a data antiga.
    let sheetTop = 0.08;
    for (let y = y0 + 1; y < y0 + (y1 - y0) * 0.4; y++) {
        if (far(rowColor(y), background))
            sheetTop = (y - y0 + 2) / (y1 - y0 + 1);
        else if (sheetTop > 0.08)
            break;
    }
    const sheetBottom = 0.9;
    const top = rowColor(Math.round(y0 + (y1 - y0) * Math.min(0.95, sheetTop + 0.04)));
    const bottom = rowColor(Math.round(y0 + (y1 - y0) * (sheetBottom - 0.04)));

    const sample = {tile, background, ink, day, sheetTop, sheetBottom,
        top: far(top, background) ? background : top,
        bottom: far(bottom, background) ? background : bottom};
    _samples.set(key, sample);
    return sample;
}

function rgbaOf([r, g, b], alpha = 1) {
    return [r / 255, g / 255, b / 255, alpha];
}

/**
 * Pinta, num quadro de 128, a folha com a data de hoje por cima do tile do
 * tema: cobre a parte central (onde ficam a data fixa ou a grade) e deixa a
 * moldura e o topo do ícone do tema à mostra.
 */
function paintDateSheet(cr, sample, now) {
    const t = sample.tile;
    const tx = t.x * 128, ty = t.y * 128, tw = t.w * 128, th = t.h * 128;
    const x = tx + tw * 0.08, w = tw * 0.84;
    const y = ty + th * sample.sheetTop, h = th * (sample.sheetBottom - sample.sheetTop);
    const r = Math.min(w, h) * 0.14;

    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
    // Degradê com as cores reais do ícone no alto e na base da folha.
    const fill = new Cairo.LinearGradient(0, y, 0, y + h);
    fill.addColorStopRGBA(0, ...rgbaOf(sample.top));
    fill.addColorStopRGBA(1, ...rgbaOf(sample.bottom));
    cr.setSource(fill);
    cr.fill();

    const cx = x + w / 2;
    const month = now.format('%b').replace(/\.$/, '').toUpperCase();
    drawText(cr, month, h * 0.2, Pango.Weight.SEMIBOLD, cx, y + h * 0.3, rgbaOf(sample.ink, 0.85));
    drawText(cr, now.format('%e').trim(), h * 0.62, Pango.Weight.BOLD, cx, y + h * 0.88, rgbaOf(sample.day));
}

/**
 * O ícone do Calendário do tema atual, lido do arquivo (sem o cache por
 * nome do Shell). Se o tema não mantém a data em dia, ganha por cima a
 * folha com a data de hoje, nas cores do próprio ícone.
 */
export function createThemeCalendarIcon(app, size) {
    const path = themeCalendarFile(app, size);
    if (!path)
        return null;
    let bytes;
    try {
        [, bytes] = GLib.file_get_contents(path);
    } catch {
        return null;
    }
    const icon = new St.Icon({gicon: Gio.BytesIcon.new(new GLib.Bytes(bytes)), icon_size: size});
    if (themeIconIsToday(path, bytes))
        return icon;

    let sample;
    try {
        sample = sampleThemeIcon(path);
    } catch {
        return icon;
    }
    const now = GLib.DateTime.new_now_local();
    const box = new Clutter.Actor({width: size, height: size});
    icon.set_size(size, size);
    box.add_child(icon);
    const sheet = new St.DrawingArea({width: size, height: size});
    sheet.connect('repaint', () => {
        const cr = sheet.get_context();
        const [w, h] = sheet.get_surface_size();
        const k = Math.min(w, h) / 128;
        cr.translate((w - 128 * k) / 2, (h - 128 * k) / 2);
        cr.scale(k, k);
        paintDateSheet(cr, sample, now);
        cr.$dispose();
    });
    box.add_child(sheet);
    return box;
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
