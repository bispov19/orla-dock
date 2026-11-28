// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// blur.js — desfoque (blur) do fundo da dock com cantos arredondados.
//
// O problema: o efeito nativo Shell.BlurEffect (modo BACKGROUND) desfoca o
// que está atrás do ator, mas sempre num RETÂNGULO. Numa dock arredondada,
// os cantos ficariam "quadrados" e desfocados.
//
// A solução: copiamos o pedaço da tela atrás da dock para uma textura nossa,
// desfocamos e desenhamos o resultado com um shader GLSL que também zera a
// transparência fora do retângulo arredondado. Cada passo é um "paint node"
// (nó de pintura) que desenha numa textura e carimba o resultado no pai:
//
//   tela ← vidro(composição ← gauss V ← gauss H ← redução ← cópia do fundo)
//
// POR QUE não usar o Shell.BlurEffect: ele cria texturas de vídeo novas a
// cada desenho, presas à árvore de nós. Estender a classe em JavaScript faz
// o GJS segurar essa árvore até a próxima coleta de lixo — e, como a memória
// de VÍDEO não conta para o coletor, ela crescia para gigabytes durante a
// ampliação, e a coleta seguinte travava a tela por até meio segundo. Aqui
// as texturas são PERMANENTES: só mudam quando a dock fica maior que elas;
// o que sobra para o coletor são nós pequenos, sem textura própria.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import {GLSL_CODE, GLSL_DECLARATIONS, NEUTRAL} from './glassMath.js';

// O shader do vidro (a receita completa, passo a passo, está em
// glassMath.js). Ele roda para cada pixel da dock e, além de mexer na cor,
// RELÊ a textura do fundo desfocado em outros pontos (refração perto da
// borda), por isso o pipeline tem a textura como camada 0.

// Arredonda o tamanho das texturas para cima, em degraus. Elas só crescem:
// uma textura trocada só é liberada na coleta de lixo.
const TEXTURE_STEP = 64;
const roundUp = v => Math.max(TEXTURE_STEP, Math.ceil(v / TEXTURE_STEP) * TEXTURE_STEP);

// Acima deste desvio, o fundo é reduzido antes de desfocar (o mesmo limite
// do Clutter): o resultado é igual aos olhos e custa muito menos.
const MAX_SIGMA = 6;
const MAX_DOWNSCALE = 4;

// O mesmo filtro gaussiano do Clutter (clutter-blur.c): uma direção por vez,
// lendo dois pixels por amostra. A diferença é o limite da leitura
// (orla_uv_max): a textura pode ser maior que a parte usada.
const GAUSS_DECLARATIONS = `
uniform float orla_sigma;
uniform vec2 orla_step;
uniform vec2 orla_uv_min;
uniform vec2 orla_uv_max;
`;
const GAUSS_CODE = `
vec2 uv = vec2(cogl_tex_coord.st);
vec3 k;
k.x = 1.0 / (sqrt(2.0 * 3.14159265) * orla_sigma);
k.y = exp(-0.5 / (orla_sigma * orla_sigma));
k.z = k.y * k.y;
float total = k.x;
vec4 ret = texture2D(cogl_sampler, clamp(uv, orla_uv_min, orla_uv_max)) * k.x;
k.xy *= k.yz;
int n = int(ceil(1.5 * orla_sigma)) * 2;
for (int i = 1; i <= n; i += 2) {
    float sub = k.x;
    k.xy *= k.yz;
    sub += k.x;
    vec2 offset = orla_step * (float(i) + k.x / sub);
    ret += texture2D(cogl_sampler, clamp(uv + offset, orla_uv_min, orla_uv_max)) * sub;
    ret += texture2D(cogl_sampler, clamp(uv - offset, orla_uv_min, orla_uv_max)) * sub;
    total += 2.0 * sub;
    k.xy *= k.yz;
}
cogl_texel = ret / total;
`;
// Redução: média de 4 leituras suaves (evita cintilar ao reduzir 4×).
const REDUCE_CODE = `
vec2 uv = vec2(cogl_tex_coord.st);
cogl_texel = vec4(0.0);
cogl_texel += texture2D(cogl_sampler, clamp(uv + orla_step * vec2(-1.0, -1.0), orla_uv_min, orla_uv_max));
cogl_texel += texture2D(cogl_sampler, clamp(uv + orla_step * vec2(1.0, -1.0), orla_uv_min, orla_uv_max));
cogl_texel += texture2D(cogl_sampler, clamp(uv + orla_step * vec2(-1.0, 1.0), orla_uv_min, orla_uv_max));
cogl_texel += texture2D(cogl_sampler, clamp(uv + orla_step * vec2(1.0, 1.0), orla_uv_min, orla_uv_max));
cogl_texel *= 0.25;
`;

/** Um alvo de desenho: textura + framebuffer + o pipeline que lê a textura. */
class Surface {
    constructor(context, width, height, setup) {
        this.width = width;
        this.height = height;
        const texture = Cogl.Texture2D.new_with_size(context, width, height);
        this.framebuffer = Cogl.Offscreen.new_with_texture(texture);
        this.pipeline = Cogl.Pipeline.new(context);
        this.pipeline.set_layer_texture(0, texture);
        this.pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        this.pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        this._locations = {};
        setup(this.pipeline);
    }

    uniform(name, ...values) {
        const p = this.pipeline;
        this._locations[name] ??= p.get_uniform_location(`orla_${name}`);
        p.set_uniform_float(this._locations[name], values.length, 1, values);
    }

    /** Camada que desenha nesta superfície e a carimba em (0,0)–(w,h) do pai. */
    layer(usedW, usedH, w, h) {
        const node = Clutter.LayerNode.new_to_framebuffer(this.framebuffer, this.pipeline);
        node.add_texture_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}),
            0, 0, usedW / this.width, usedH / this.height);
        return node;
    }
}

// O Cogl reconhece um shader já compilado pelo OBJETO do trecho: criar o
// mesmo trecho de novo (outra dock, textura maior) recompilaria tudo.
const snippets = new Map();

function snippetFor(code, create) {
    if (!snippets.has(code))
        snippets.set(code, create());
    return snippets.get(code);
}

/** Solta os trechos de shader guardados (ao desativar a extensão). */
export function releaseBlurShaders() {
    snippets.clear();
}

const lookup = code => pipeline => {
    pipeline.add_layer_snippet(0, snippetFor(code, () => {
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.TEXTURE_LOOKUP, GAUSS_DECLARATIONS, null);
        snippet.set_replace(code);
        return snippet;
    }));
    // Cada passo cobre a área inteira do seguinte: substitui, não mistura.
    pipeline.set_blend('RGBA = ADD (SRC_COLOR, 0)');
};

export const RoundedBlurEffect = GObject.registerClass(
class OrlaRoundedBlurEffect extends Clutter.Effect {
    _init({radius = 30, cornerRadius = 0, mode = Shell.BlurMode.BACKGROUND} = {}) {
        super._init();
        this._mode = mode;
        this._radius = radius;
        this._brightness = 1.0;
        this._cornerRadius = cornerRadius;
        // Valores "neutros": o vidro mostra só o desfoque.
        this._glass = {...NEUTRAL};
        this._surfaces = null;
        // Os parâmetros do shader só são reenviados quando mudam (e não a
        // cada quadro): a dock é redesenhada a cada quadro da Visão Geral.
        this._paramsDirty = true;
        this._lastSize = null;      // [largura, altura, escala] do último envio
        this._lastMask = null;
        this._cached = false;       // modo ACTOR: o resultado ainda vale
        // A máscara: o retângulo visível dentro do ator (null = o ator
        // inteiro). A dock mantém o ator do vidro com tamanho fixo durante
        // a ampliação e move só a máscara.
        this._mask = null;
    }

    get mode() {
        return this._mode;
    }

    set mode(value) {
        this._mode = value;
        this._invalidate();
    }

    /** Raio do desfoque (o dobro do desvio da gaussiana, como no Shell). */
    get radius() {
        return this._radius;
    }

    set radius(value) {
        this._radius = value;
        this._invalidate();
    }

    get brightness() {
        return this._brightness;
    }

    set brightness(value) {
        this._brightness = value;
        this._invalidate();
    }

    _invalidate() {
        this._paramsDirty = true;
        this._cached = false;
        this.queue_repaint();
    }

    /** O retângulo visível do vidro, em coordenadas do ator. */
    setMask(x, y, width, height) {
        const m = this._mask;
        if (m && m[0] === x && m[1] === y && m[2] === width && m[3] === height)
            return;
        this._mask = [x, y, width, height];
        this.queue_repaint();
    }

    set cornerRadius(value) {
        this._cornerRadius = value;
        this._paramsDirty = true;
        this.queue_repaint();
    }

    get cornerRadius() {
        return this._cornerRadius;
    }

    /** Ajustes do vidro (os parâmetros de glassParams, em glassMath.js). */
    setGlass(glass) {
        this._glass = {...this._glass, ...glass};
        this._paramsDirty = true;
        this.queue_repaint();
    }

    /** Cria (ou aumenta) as texturas permanentes da cadeia. */
    _ensureSurfaces(actor, width, height, downscale) {
        const s = this._surfaces;
        if (s && width <= s.width && height <= s.height && s.downscale === downscale)
            return s;
        // O contexto Cogl é a "conexão" com a placa de vídeo.
        const context = actor.get_context().get_backend().get_cogl_context();
        const w = roundUp(Math.max(width, s?.width ?? 0));
        const h = roundUp(Math.max(height, s?.height ?? 0));
        const sw = Math.ceil(w / downscale);
        const sh = Math.ceil(h / downscale);
        this._surfaces = {
            width: w, height: h, downscale,
            source: new Surface(context, w, h, lookup(REDUCE_CODE)),
            reduced: new Surface(context, sw, sh, lookup(GAUSS_CODE)),
            horizontal: new Surface(context, sw, sh, lookup(GAUSS_CODE)),
            vertical: new Surface(context, sw, sh, p => p.set_blend('RGBA = ADD (SRC_COLOR, 0)')),
            glass: new Surface(context, w, h, p => p.add_snippet(snippetFor(GLSL_CODE, () =>
                Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, GLSL_DECLARATIONS, GLSL_CODE)))),
        };
        this._paramsDirty = true;
        this._cached = false;
        return this._surfaces;
    }

    /** Parâmetros que só dependem do tamanho, da escala e das opções. */
    _sendParams(s, width, height, scale, sigma) {
        const d = s.downscale;
        const rw = Math.ceil(width / d);
        const rh = Math.ceil(height / d);
        // Projeção: coordenadas = pixels de cada superfície; na do vidro, as
        // coordenadas lógicas do ator (ele desenha a si mesmo ali dentro).
        for (const x of [s.reduced, s.horizontal, s.vertical])
            x.framebuffer.orthographic(0, 0, x.width, x.height, 0, 1);
        for (const x of [s.source, s.glass])
            x.framebuffer.orthographic(0, 0, x.width / scale, x.height / scale, 0, 1);

        const limits = (x, usedW, usedH) => {
            x.uniform('uv_min', 0.5 / x.width, 0.5 / x.height);
            x.uniform('uv_max', (usedW - 0.5) / x.width, (usedH - 0.5) / x.height);
        };
        limits(s.source, width, height);
        s.source.uniform('step', d / 4 / s.source.width, d / 4 / s.source.height);
        limits(s.reduced, rw, rh);
        s.reduced.uniform('sigma', sigma / d);
        s.reduced.uniform('step', 1 / s.reduced.width, 0);
        limits(s.horizontal, rw, rh);
        s.horizontal.uniform('sigma', sigma / d);
        s.horizontal.uniform('step', 0, 1 / s.horizontal.height);

        const b = Math.round(Math.min(1, this._brightness) * 255);
        s.vertical.pipeline.set_color(new Cogl.Color({red: b, green: b, blue: b, alpha: 255}));

        const g = this._glass;
        s.glass.uniform('full', width, height);
        s.glass.uniform('tex_scale', width / s.glass.width, height / s.glass.height);
        s.glass.uniform('scale', scale);
        s.glass.uniform('tint', ...g.tint);
        for (const name of ['target', 'adapt', 'saturation', 'refraction', 'dispersion', 'sheen', 'glow', 'angle', 'grain'])
            s.glass.uniform(name, g[name]);
    }

    /** Nó que copia para a textura o pedaço da tela atrás do ator. */
    _backgroundNode(actor, paintContext, width, height) {
        const target = paintContext.get_framebuffer();
        // Em que canto da tela este framebuffer começa (cada monitor tem o
        // seu) e quantos pixels ele tem por unidade.
        let ox = 0, oy = 0;
        let scale = target.get_width() / global.stage.width;
        const view = global.stage.peek_stage_views().find(v => v.get_framebuffer() === target);
        if (view) {
            const layout = new Mtk.Rectangle();
            view.get_layout(layout);
            [ox, oy] = [layout.x, layout.y];
            scale = view.get_scale();
        }
        const [x, y] = actor.get_transformed_position();
        const blit = Clutter.BlitNode.new(target);
        blit.add_blit_rectangle(Math.round((x - ox) * scale), Math.round((y - oy) * scale), 0, 0, width, height);
        return blit;
    }

    vfunc_paint_node(node, paintContext, flags) {
        const actor = this.get_actor();
        if (!actor)
            return;
        // Tamanho do ator em pixels reais da tela. get_resource_scale(): 1
        // numa tela comum, 2 em HiDPI, ou fracionária como 1,25.
        const [width, height] = actor.get_size();
        const scale = actor.get_resource_scale();
        const pw = Math.ceil(width * scale);
        const ph = Math.ceil(height * scale);
        // `!(x > 0)` também pega NaN (ator ainda sem tamanho/escala).
        if (!(pw > 0) || !(ph > 0))
            return;

        const sigma = this._radius * scale / 2;
        let downscale = 1;
        while (sigma / downscale > MAX_SIGMA && downscale < MAX_DOWNSCALE)
            downscale *= 2;
        const s = this._ensureSurfaces(actor, pw, ph, downscale);

        const last = this._lastSize;
        const dirty = this._paramsDirty || !last || last[0] !== pw || last[1] !== ph || last[2] !== scale;
        if (dirty) {
            this._paramsDirty = false;
            this._cached = false;
            this._lastSize = [pw, ph, scale];
            this._sendParams(s, pw, ph, scale, sigma);
        }

        // A máscara muda a cada quadro da ampliação: são só 2 vetores e o raio.
        const mask = this._mask;
        const mx = mask ? mask[0] : 0, my = mask ? mask[1] : 0;
        const mw = mask ? mask[2] : width, mh = mask ? mask[3] : height;
        const lm = this._lastMask;
        if (dirty || !lm || lm[0] !== mx || lm[1] !== my || lm[2] !== mw || lm[3] !== mh) {
            this._lastMask = [mx, my, mw, mh];
            const w = Math.max(1, mw * scale), h = Math.max(1, mh * scale);
            s.glass.uniform('size', w, h);
            s.glass.uniform('offset', mx * scale, my * scale);
            s.glass.uniform('radius', Math.min(this._cornerRadius * scale, w / 2, h / 2));
        }

        // O vidro pronto: só o retângulo visível vai para a tela.
        const isActor = this._mode === Shell.BlurMode.ACTOR;
        const reuse = isActor && this._cached && !(flags & Clutter.EffectPaintFlags.ACTOR_DIRTY);
        const out = reuse
            ? Clutter.PipelineNode.new(s.glass.pipeline)
            : Clutter.LayerNode.new_to_framebuffer(s.glass.framebuffer, s.glass.pipeline);
        const tx = scale / s.glass.width, ty = scale / s.glass.height;
        out.add_texture_rectangle(new Clutter.ActorBox({x1: mx, y1: my, x2: mx + mw, y2: my + mh}),
            mx * tx, my * ty, (mx + mw) * tx, (my + mh) * ty);
        node.add_child(out);
        if (reuse)
            return;

        // A cadeia do desfoque, de fora para dentro (ver o topo do arquivo).
        const rw = Math.ceil(pw / downscale);
        const rh = Math.ceil(ph / downscale);
        s.glass.framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);
        const vertical = s.vertical.layer(rw, rh, width, height);
        const horizontal = s.horizontal.layer(rw, rh, rw, rh);
        const reduced = s.reduced.layer(rw, rh, rw, rh);
        const source = s.source.layer(pw, ph, rw, rh);
        out.add_child(vertical);
        vertical.add_child(horizontal);
        horizontal.add_child(reduced);
        reduced.add_child(source);
        if (isActor) {
            s.source.framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);
            source.add_child(Clutter.ActorNode.new(actor, -1));
            this._cached = true;
        } else {
            source.add_child(this._backgroundNode(actor, paintContext, pw, ph));
            out.add_child(Clutter.ActorNode.new(actor, -1));
        }
    }
});
