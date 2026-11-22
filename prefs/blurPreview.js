// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/blurPreview.js — prévia ao vivo do vidro, no topo da aba Desfoque.
//
// Uma miniatura da dock sobre um fundo colorido (o papel de parede atual,
// ou uma ilustração em tons de mar, coral e âmbar), com uma "janela"
// passando atrás. O vidro segue a MESMA receita da dock real
// (lib/glassMath.js):
//   - o desfoque é um nó de blur do GTK (feito pela placa de vídeo);
//   - adaptação, vibração e cor do vidro viram UMA matriz de cor
//     (colorTransform), a mesma conta do shader;
//   - o reflexo e o relevo da borda usam as mesmas constantes.
// A refração e a dispersão relêem o fundo em outro ponto, o que o GTK não
// faz: essas duas aparecem só na dock de verdade.
// Nada de laço por pixel em JavaScript: arrastar os controles fica leve.
//
// A animação (janela deslizando no modo Dinâmico e a troca suave ao ligar
// ou desligar o vidro) usa um "tick callback" do GTK, que só roda enquanto
// a prévia está na tela: em outra aba, ela para sozinha.

import Adw from 'gi://Adw';
import Cairo from 'gi://cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import Gtk from 'gi://Gtk';

import {backdropPath} from '../lib/glassBackdrops.js';
import {SHEEN_GAIN, SHEEN_REACH, colorTransform, glassParams, rimLight} from '../lib/glassMath.js';
import {dockStyle, hexToRgb} from '../lib/themes.js';

const HEIGHT = 190;
const CARD_RADIUS = 14;
const ICON = 34;                 // ícones da miniatura
const REAL_ICON = 48;            // tamanho "de referência" da dock real
const FADE_MS = 200;             // vidro liga/desliga
const SWEEP_MS = 14000;          // uma passada da janela no modo Dinâmico
const TEXTURE_WIDTH = 960;       // fundo reduzido (leve e nítido o bastante)

// Chaves que mudam a cena (as outras não fazem nada aqui).
const KEYS = new Set([
    'blur-enabled', 'blur-mode', 'blur-static-source', 'blur-static-preset', 'blur-custom-photo',
    'blur-intensity', 'blur-vibrancy', 'blur-brightness', 'blur-tint-color', 'blur-tint-opacity',
    'blur-border-glow', 'blur-highlight-angle', 'blur-adaptive', 'blur-sheen', 'corner-radius', 'theme', 'background-color',
    'background-opacity', 'border-width', 'border-color', 'border-opacity',
]);

const rect = (x, y, w, h) => new Graphene.Rect().init(x, y, w, h);
const rgba = (r, g, b, a = 1) => new Gdk.RGBA({red: r, green: g, blue: b, alpha: a});
const rounded = (x, y, w, h, r) => new Gsk.RoundedRect().init_from_rect(rect(x, y, w, h), r);

/** Uma imagem reduzida para textura, ou null se não der para ler. */
function loadTexture(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS) || path.endsWith('.xml'))
        return null;
    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, TEXTURE_WIDTH, -1, true);
        return Gdk.Texture.new_for_pixbuf(pixbuf);
    } catch {
        return null;
    }
}

function uriToPath(uri) {
    try {
        return uri ? Gio.File.new_for_uri(uri).get_path() : null;
    } catch {
        return null;
    }
}

export const BlurPreview = GObject.registerClass(
class OrlaBlurPreview extends Gtk.Widget {
    _init(settings, extensionPath) {
        super._init({hexpand: true, height_request: HEIGHT, margin_bottom: 12});
        this._settings = settings;
        this._path = extensionPath;
        this._glassT = settings.get_boolean('blur-enabled') ? 1 : 0;
        this._sweep = 0.3;
        this._tickId = 0;
        this._lastFrame = 0;

        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._style = Adw.StyleManager.get_default();
        this._ids = [
            [settings, settings.connect('changed', (_s, key) => this._onChanged(key))],
            [this._background, this._background.connect('changed', () => this._loadWallpaper())],
            [this._style, this._style.connect('notify::dark', () => {
                this._loadWallpaper();
                this.queue_draw();
            })],
        ];
        this.connect('map', () => this._syncAnimation());
        this.connect('unmap', () => this._stopAnimation());
        this.connect('destroy', () => {
            this._stopAnimation();
            this._ids.forEach(([obj, id]) => obj.disconnect(id));
            this._ids = [];
        });

        this._loadWallpaper();
        this._loadStatic();
        this._loadIcons();
    }

    // ---------- Dados ----------

    _onChanged(key) {
        if (!KEYS.has(key))
            return;
        if (key.startsWith('blur-static') || key === 'blur-custom-photo')
            this._loadStatic();
        this._syncAnimation();
        // queue_draw junta tudo num desenho por quadro: arrastar um controle
        // não gera mais redesenhos do que a tela consegue mostrar.
        this.queue_draw();
    }

    _loadWallpaper() {
        const key = this._style.dark ? 'picture-uri-dark' : 'picture-uri';
        this._wallpaper = loadTexture(uriToPath(this._background.get_string(key))) ??
            loadTexture(uriToPath(this._background.get_string('picture-uri')));
        this.queue_draw();
    }

    /** A imagem do vidro estático: a mesma escolha da dock (foto ou pronta). */
    _loadStatic() {
        const s = this._settings;
        let path = null;
        if (s.get_string('blur-static-source') === 'custom')
            path = s.get_string('blur-custom-photo') || null;
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
            path = backdropPath(this._path, s.get_string('blur-static-preset'));
        this._staticImage = loadTexture(path);
    }

    /** Ícones reais: o botão com o logo "OD", 5 apps fixados e a lixeira. */
    _loadIcons() {
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const scale = this.get_scale_factor();
        const lookup = gicon => theme.lookup_by_gicon(gicon, ICON, scale, Gtk.TextDirection.NONE, 0);
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const apps = shell.get_strv('favorite-apps')
            .map(id => {
                try {
                    return GioUnix.DesktopAppInfo.new(id);
                } catch {
                    return null;
                }
            })
            .filter(app => app?.get_icon())
            .slice(0, 5);
        const fallback = ['org.gnome.Nautilus', 'org.gnome.TextEditor', 'org.gnome.Calculator',
            'org.gnome.Settings', 'org.gnome.Software'];
        while (apps.length < 5)
            apps.push({get_icon: () => Gio.ThemedIcon.new(fallback[apps.length])});
        // Botão de aplicativos com o logo da Orla Dock.
        const logoPath = GLib.build_filenamev([this._path, 'icons', 'orla-dock-logo.svg']);
        const logo = Gio.FileIcon.new(Gio.File.new_for_path(logoPath));
        this._icons = [
            lookup(logo),
            ...apps.map(app => lookup(app.get_icon())),
            null,   // divisória
            lookup(Gio.ThemedIcon.new('user-trash-full')),
        ];
    }

    // ---------- Animação ----------

    get _wantsSweep() {
        const s = this._settings;
        return s.get_boolean('blur-enabled') && s.get_string('blur-mode') !== 'static';
    }

    _syncAnimation() {
        const target = this._settings.get_boolean('blur-enabled') ? 1 : 0;
        const needed = this.get_mapped() && (this._wantsSweep || this._glassT !== target);
        if (needed && !this._tickId) {
            this._lastFrame = 0;
            this._tickId = this.add_tick_callback((_w, clock) => this._tick(clock));
        } else if (!needed) {
            this._stopAnimation();
        }
    }

    _stopAnimation() {
        if (this._tickId)
            this.remove_tick_callback(this._tickId);
        this._tickId = 0;
    }

    _tick(clock) {
        const now = clock.get_frame_time();   // microssegundos
        const dt = this._lastFrame ? Math.min(0.1, (now - this._lastFrame) / 1e6) : 0;
        this._lastFrame = now;
        const target = this._settings.get_boolean('blur-enabled') ? 1 : 0;
        if (this._glassT !== target) {
            const step = dt * 1000 / FADE_MS;
            this._glassT = target > this._glassT
                ? Math.min(target, this._glassT + step) : Math.max(target, this._glassT - step);
        }
        if (this._wantsSweep)
            this._sweep = (this._sweep + dt * 1000 / SWEEP_MS) % 1;
        this.queue_draw();
        if (!this._wantsSweep && this._glassT === target) {
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    // ---------- Desenho ----------

    /** O "papel de parede": imagem cobrindo tudo, ou a ilustração. */
    _paintDesktop(snapshot, w, h, texture) {
        if (texture) {
            const tw = texture.get_width(), th = texture.get_height();
            const k = Math.max(w / tw, h / th);
            snapshot.append_texture(texture, rect((w - tw * k) / 2, (h - th * k) / 2, tw * k, th * k));
            return;
        }
        // Ilustração: mar profundo, um sol coral, uma mancha âmbar e ondas.
        const cr = snapshot.append_cairo(rect(0, 0, w, h));
        const sea = new Cairo.LinearGradient(0, 0, 0, h);
        sea.addColorStopRGB(0, 0.05, 0.23, 0.36);
        sea.addColorStopRGB(1, 0.07, 0.48, 0.54);
        cr.setSource(sea);
        cr.paint();
        const blob = (x, y, r, [cr0, cg, cb], a) => {
            cr.arc(x, y, r, 0, 2 * Math.PI);
            cr.setSourceRGBA(cr0, cg, cb, a);
            cr.fill();
        };
        blob(w * 0.78, h * 0.3, h * 0.42, [1, 0.48, 0.35], 0.95);
        blob(w * 0.22, h * 0.72, h * 0.5, [0.96, 0.72, 0.24], 0.85);
        blob(w * 0.5, h * 0.15, h * 0.22, [0.35, 0.8, 0.85], 0.7);
        cr.setSourceRGBA(1, 1, 1, 0.25);
        cr.setLineWidth(3);
        for (let i = 0; i < 3; i++) {
            cr.moveTo(0, h * (0.55 + i * 0.12));
            for (let x = 0; x <= w; x += 20)
                cr.lineTo(x, h * (0.55 + i * 0.12) + Math.sin(x / 40 + i) * 6);
            cr.stroke();
        }
        cr.$dispose();
    }

    /** Uma janela colorida que passa atrás da dock. */
    _paintWindow(snapshot, w, h) {
        const ww = w * 0.36, wh = h * 0.62;
        const x = -ww + (w + ww) * this._sweep;
        const y = h * 0.22;
        snapshot.push_rounded_clip(rounded(x, y, ww, wh, 10));
        const cr = snapshot.append_cairo(rect(x, y, ww, wh));
        const g = new Cairo.LinearGradient(x, y, x + ww, y + wh);
        g.addColorStopRGB(0, 1, 0.45, 0.35);
        g.addColorStopRGB(0.5, 0.98, 0.72, 0.25);
        g.addColorStopRGB(1, 0.2, 0.62, 0.95);
        cr.setSource(g);
        cr.paint();
        cr.rectangle(x, y, ww, 18);
        cr.setSourceRGBA(0.12, 0.12, 0.15, 0.85);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.55);
        for (let i = 0; i < 4; i++) {
            cr.rectangle(x + 14, y + 32 + i * 18, ww * (0.7 - i * 0.12), 7);
            cr.fill();
        }
        cr.$dispose();
        snapshot.pop();
    }

    /** O que fica "atrás da dock" (para o vidro desfocar). */
    _paintBehind(snapshot, w, h, isStatic) {
        if (isStatic) {
            this._paintDesktop(snapshot, w, h, this._staticImage);
            return;
        }
        this._paintDesktop(snapshot, w, h, this._wallpaper);
        this._paintWindow(snapshot, w, h);
    }

    vfunc_snapshot(snapshot) {
        const w = this.get_width(), h = this.get_height();
        if (w <= 0 || h <= 0)
            return;
        const s = this._settings;
        const isStatic = s.get_string('blur-mode') === 'static';

        snapshot.push_rounded_clip(rounded(0, 0, w, h, CARD_RADIUS));
        this._paintDesktop(snapshot, w, h, this._wallpaper);
        this._paintWindow(snapshot, w, h);

        // --- Medidas da dock em miniatura ---
        const n = this._icons.length;
        const gap = 9, pad = 11, sep = 12;
        const dw = (n - 1) * ICON + (n - 2) * gap + sep + pad * 2;
        const dh = ICON + pad * 2;
        const dx = (w - dw) / 2, dy = h - dh - 16;
        const radius = Math.min(dh / 2, s.get_int('corner-radius') * ICON / REAL_ICON + 4);
        const outline = rounded(dx, dy, dw, dh, radius);

        snapshot.append_outset_shadow(outline, rgba(0, 0, 0, 0.28), 0, 6, 0, 18);

        // --- Sem vidro: a cor do tema (a mesma conta da dock real) ---
        const look = dockStyle({
            theme: s.get_enum('theme'),
            backgroundColor: s.get_string('background-color'),
            useGradient: false, gradientColor: '#000000', gradientDirection: 0,
            opacity: s.get_double('background-opacity'),
            borderWidth: s.get_int('border-width'),
            borderColor: s.get_string('border-color'),
            borderOpacity: s.get_double('border-opacity'),
            radius, glass: false, glassTint: s.get_string('blur-tint-color'),
            systemDark: this._style.dark, wallpaperRgb: null,
        });
        if (this._glassT < 1) {
            const [r, g, b] = look.base.map(v => v / 255);
            snapshot.push_rounded_clip(outline);
            snapshot.append_color(rgba(r, g, b, s.get_double('background-opacity') * (1 - this._glassT)),
                rect(dx, dy, dw, dh));
            snapshot.pop();
        }

        // --- Com vidro: desfoque + a matriz de cor da receita + luz ---
        if (this._glassT > 0) {
            const params = glassParams(s);
            const {A, b} = colorTransform(params);
            // A matriz do GTK multiplica a cor como vetor-linha: usamos a
            // transposta de A (coluna = canal de saída).
            const matrix = new Graphene.Matrix().init_from_float([
                A[0][0], A[1][0], A[2][0], 0,
                A[0][1], A[1][1], A[2][1], 0,
                A[0][2], A[1][2], A[2][2], 0,
                0, 0, 0, 1,
            ]);
            snapshot.push_opacity(this._glassT);
            snapshot.push_rounded_clip(outline);
            snapshot.push_color_matrix(matrix, new Graphene.Vec4().init(b[0], b[1], b[2], 0));
            const blur = params.radius * ICON / REAL_ICON;
            if (blur > 0.5)
                snapshot.push_blur(blur);
            this._paintBehind(snapshot, w, h, isStatic);
            if (blur > 0.5)
                snapshot.pop();
            snapshot.pop();
            this._paintRim(snapshot, dx, dy, dw, dh, radius, params);
            snapshot.pop();
            snapshot.pop();
        }

        // --- Contorno do tema ---
        const bw = s.get_int('border-width');
        if (bw > 0) {
            const [r, g, b] = hexToRgb(s.get_string('border-color')).map(v => v / 255);
            const c = rgba(r, g, b, s.get_double('border-opacity'));
            snapshot.append_border(outline, [bw, bw, bw, bw], [c, c, c, c]);
        }

        // --- Ícones ---
        let x = dx + pad;
        for (const icon of this._icons) {
            if (!icon) {
                const line = look.dark || this._glassT > 0 ? rgba(1, 1, 1, 0.35) : rgba(0, 0, 0, 0.25);
                snapshot.append_color(line, rect(x + sep / 2 - 0.5, dy + pad + 4, 1, ICON - 8));
                x += sep;
                continue;
            }
            snapshot.save();
            snapshot.translate(new Graphene.Point({x, y: dy + pad}));
            icon.snapshot(snapshot, ICON, ICON);
            snapshot.restore();
            x += ICON + gap;
        }

        snapshot.pop();   // recorte do cartão
        // Borda fininha do cartão, para ele se destacar no tema claro.
        const edge = this._style.dark ? rgba(1, 1, 1, 0.08) : rgba(0, 0, 0, 0.1);
        const card = rounded(0, 0, w, h, CARD_RADIUS);
        snapshot.append_border(card, [1, 1, 1, 1], [edge, edge, edge, edge]);
    }

    /**
     * Reflexo de cima e relevo da borda, com as constantes do shader: para
     * cada trecho da borda, a normal (direção "para fora") contra a luz dá
     * luz (lado iluminado) ou sombra (lado oposto).
     */
    _paintRim(snapshot, x, y, w, h, r, params) {
        const cr = snapshot.append_cairo(rect(x - 2, y - 2, w + 4, h + 4));
        if (params.sheen > 0.01) {
            cr.save();
            this._roundedPath(cr, x, y, w, h, r);
            cr.clip();
            const sheen = new Cairo.LinearGradient(0, y, 0, y + h * SHEEN_REACH);
            sheen.addColorStopRGBA(0, 1, 1, 1, params.sheen * SHEEN_GAIN);
            sheen.addColorStopRGBA(0.5, 1, 1, 1, params.sheen * SHEEN_GAIN * 0.25);
            sheen.addColorStopRGBA(1, 1, 1, 1, 0);
            cr.setSource(sheen);
            cr.paint();
            cr.restore();
        }
        if (params.glow > 0.01) {
            const light = [Math.cos(params.angle), Math.sin(params.angle)];
            cr.setLineWidth(1.3);
            for (const [ax, ay, bx, by, nx, ny] of this._perimeter(x + 0.65, y + 0.65, w - 1.3, h - 1.3, r)) {
                const amount = rimLight(nx * light[0] + ny * light[1], params.glow) * 1.6;
                if (Math.abs(amount) < 0.01)
                    continue;
                if (amount > 0)
                    cr.setSourceRGBA(1, 1, 1, Math.min(1, amount));
                else
                    cr.setSourceRGBA(0, 0, 0, Math.min(1, -amount));
                cr.moveTo(ax, ay);
                cr.lineTo(bx, by);
                cr.stroke();
            }
        }
        cr.$dispose();
    }

    _roundedPath(cr, x, y, w, h, r) {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }

    /** Pedacinhos da borda: [x0, y0, x1, y1, normalX, normalY]. */
    *_perimeter(x, y, w, h, r) {
        const steps = 10;
        const sides = [
            [x + r, y, x + w - r, y, 0, -1],
            [x + w, y + r, x + w, y + h - r, 1, 0],
            [x + w - r, y + h, x + r, y + h, 0, 1],
            [x, y + h - r, x, y + r, -1, 0],
        ];
        for (const [x0, y0, x1, y1, nx, ny] of sides) {
            for (let i = 0; i < steps; i++) {
                const t0 = i / steps, t1 = (i + 1) / steps;
                yield [x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, nx, ny];
            }
        }
        const corners = [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0],
            [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]];
        for (const [cx, cy, start] of corners) {
            for (let i = 0; i < steps; i++) {
                const a0 = start + (Math.PI / 2) * i / steps, a1 = start + (Math.PI / 2) * (i + 1) / steps;
                const mid = (a0 + a1) / 2;
                yield [cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1),
                    Math.cos(mid), Math.sin(mid)];
            }
        }
    }
});
