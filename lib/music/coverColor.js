// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// music/coverColor.js — a cor "da música": a cor vibrante mais presente na
// capa do álbum, usada no contorno de progresso da pílula.
//
// Como: a capa é lida e reduzida para 24×24 de forma ASSÍNCRONA (o Shell
// não espera o disco nem a decodificação); depois, nesses 576 pontos,
// ignoramos os muito escuros, muito claros e quase cinza, agrupamos o
// resto por matiz (12 faixas do círculo de cores) e ficamos com a faixa de
// maior peso (saturação × brilho). A média dela é a cor. Uma vez por capa
// (guardada em memória).

import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {LruMap} from './cache.js';

const SAMPLE = 24;
const HUE_BINS = 12;
const cache = new LruMap(120);

function readStream(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_LOW, cancellable, (f, res) => {
            try {
                resolve(f.read_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function scaledPixbuf(stream, cancellable) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, SAMPLE, SAMPLE, false, cancellable, (_s, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** RGB (0–1) → [h (0–1), s, v]. */
function toHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r)
            h = ((g - b) / d) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h /= 6;
        if (h < 0)
            h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

/** A cor dominante e vibrante dos pixels, ou null (capa cinza/escura). */
export function dominantColor(pixels, width, height, rowstride, channels) {
    const bins = Array.from({length: HUE_BINS}, () => ({weight: 0, r: 0, g: 0, b: 0}));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * channels;
            if (channels === 4 && pixels[i + 3] < 128)
                continue;
            const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
            const [h, s, v] = toHsv(r, g, b);
            if (v < 0.18 || s < 0.22 || (v > 0.95 && s < 0.35))
                continue;
            const weight = s * v;
            const bin = bins[Math.floor(h * HUE_BINS) % HUE_BINS];
            bin.weight += weight;
            bin.r += r * weight;
            bin.g += g * weight;
            bin.b += b * weight;
        }
    }
    const best = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
    // Menos de ~3% da imagem colorida: a capa é praticamente cinza.
    if (best.weight < width * height * 0.03 * 0.3)
        return null;
    return [best.r / best.weight, best.g / best.weight, best.b / best.weight];
}

/**
 * Ajusta a cor para aparecer bem sobre o fundo: saturação mínima e um
 * brilho na faixa certa (claro na dock escura, escuro na dock clara).
 * Entra e sai em RGB 0–1.
 */
export function readableColor([r, g, b], dark) {
    // RGB → HSL
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let l = (max + min) / 2;
    let s = 0, h = 0;
    const d = max - min;
    if (d > 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        h = toHsv(r, g, b)[0];
    }
    s = Math.max(0.55, Math.min(1, s));
    l = dark ? Math.max(0.6, Math.min(0.72, l)) : Math.max(0.34, Math.min(0.46, l));
    // HSL → RGB
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h * 6;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return [r1 + m, g1 + m, b1 + m];
}

/**
 * A cor da capa em `path` (arquivo local), ou null se não der.
 * @returns {Promise<number[]|null>} RGB 0–1, ainda sem o ajuste de leitura
 */
export async function coverColor(path, cancellable) {
    if (!path)
        return null;
    if (cache.has(path))
        return cache.get(path);
    let color = null;
    try {
        const stream = await readStream(Gio.File.new_for_path(path), cancellable);
        const pixbuf = await scaledPixbuf(stream, cancellable);
        stream.close_async(GLib.PRIORITY_LOW, null, null);
        color = dominantColor(pixbuf.get_pixels(), pixbuf.get_width(), pixbuf.get_height(),
            pixbuf.get_rowstride(), pixbuf.get_n_channels());
    } catch (e) {
        if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        color = null;
    }
    cache.set(path, color);
    return color;
}
