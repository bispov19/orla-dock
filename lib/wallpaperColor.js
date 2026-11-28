// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// wallpaperColor.js — descobre a cor predominante do papel de parede.
//
// O caminho da imagem fica no GSettings "org.gnome.desktop.background"
// (chaves picture-uri e picture-uri-dark). Carregamos a imagem já
// REDUZIDA para 64×64 com o GdkPixbuf (biblioteca de imagens do GTK), de
// forma assíncrona para não travar o Shell, e calculamos uma média que dá
// mais peso às cores vivas (senão o resultado vira sempre um cinza).
// Por fim, ajustamos o brilho para a cor servir de fundo de dock.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const SAMPLE = 64;

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    if (s === 0)
        return [l * 255, l * 255, l * 255];
    const hue = (p, q, t) => {
        if (t < 0)
            t += 1;
        if (t > 1)
            t -= 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** Média ponderada pela saturação, depois ajustada para virar fundo. */
function dominantColor(pixbuf, dark) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    let r = 0, g = 0, b = 0, total = 0;
    for (let y = 0; y < pixbuf.get_height(); y += 2) {
        for (let x = 0; x < pixbuf.get_width(); x += 2) {
            const i = y * stride + x * channels;
            const [, s, l] = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
            // Cores vivas e de luminosidade média pesam mais.
            const weight = 0.1 + s * (1 - Math.abs(l - 0.5) * 2);
            r += pixels[i] * weight;
            g += pixels[i + 1] * weight;
            b += pixels[i + 2] * weight;
            total += weight;
        }
    }
    const [h, s] = rgbToHsl(r / total, g / total, b / total);
    // Fundo escuro e levemente saturado no modo escuro; claro no modo claro.
    return hslToRgb(h, Math.min(s, 0.45), dark ? 0.16 : 0.9);
}

export class WallpaperColor extends EventEmitter {
    constructor(isDark) {
        super();
        this._isDark = isDark;
        this.rgb = null;
        this._cancellable = null;
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._settings.connectObject(
            'changed::picture-uri', () => this.refresh(),
            'changed::picture-uri-dark', () => this.refresh(),
            this);
        this.refresh();
    }

    destroy() {
        this._cancellable?.cancel();
        this._settings.disconnectObject(this);
    }

    refresh() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        const dark = this._isDark();
        const key = dark ? 'picture-uri-dark' : 'picture-uri';
        const uri = this._settings.get_string(key) || this._settings.get_string('picture-uri');
        if (!uri || uri.endsWith('.xml'))
            return;   // sem imagem, ou "slideshow" em XML: fica a cor padrão

        const file = Gio.File.new_for_uri(uri);
        file.read_async(GLib.PRIORITY_LOW, cancellable, (f, res) => {
            let stream;
            try {
                stream = f.read_finish(res);
            } catch {
                return;
            }
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, SAMPLE, SAMPLE, true,
                cancellable, (_s, r) => {
                    try {
                        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(r);
                        this.rgb = dominantColor(pixbuf, dark);
                        this.emit('changed');
                    } catch {
                        // imagem ilegível: mantém a cor anterior
                    } finally {
                        stream.close_async(GLib.PRIORITY_LOW, null, null);
                    }
                });
        });
    }
}
