// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// blur.js — desfoque (blur) do fundo da dock com cantos arredondados.
//
// O problema: o efeito nativo Shell.BlurEffect (modo BACKGROUND) desfoca o
// que está atrás do ator, mas sempre num RETÂNGULO. Numa dock arredondada,
// os cantos ficariam "quadrados" e desfocados.
//
// A solução: em vez de deixar o Shell.BlurEffect desenhar direto na tela,
// desviamos o desenho dele para uma textura nossa (um "framebuffer fora da
// tela", ou offscreen) e depois desenhamos essa textura na tela com um
// pequeno shader GLSL que zera a transparência fora do retângulo arredondado.
//
// Como isso funciona no Clutter: desde o GNOME 42 cada ator e cada efeito
// descreve o que vai desenhar montando uma árvore de "paint nodes"
// (nós de pintura). Um Clutter.LayerNode é um nó que desenha os filhos numa
// textura e depois "carimba" essa textura usando um Cogl.Pipeline (a receita
// de como pintar: texturas, cores, shaders). Nós entregamos ao
// Shell.BlurEffect o nosso LayerNode como pai — ele desenha lá dentro sem
// saber — e o nosso pipeline aplica a máscara arredondada.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {GLSL_GLASS_COLOR, GLSL_GLASS_RIM} from './glassMath.js';

// Declarações GLSL: variáveis "uniform" são parâmetros que o JavaScript
// envia para a placa de vídeo.
const MASK_DECLARATIONS = `
uniform vec2 orla_size;
uniform float orla_radius;
uniform vec2 orla_tex_scale;
uniform float orla_saturation;
uniform float orla_lift;
uniform vec4 orla_tint;
uniform float orla_glow;
uniform float orla_angle;

// Normal (direção "para fora") da borda mais próxima de um retângulo
// arredondado centrado em 0, com meia-largura b e raio r.
vec2 orla_edge_normal(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - (b - vec2(r));
    if (q.x > 0.0 || q.y > 0.0)
        return sign(p) * normalize(max(q, vec2(0.0)));
    float onX = step(q.y, q.x);
    return sign(p) * vec2(onX, 1.0 - onX);
}
`;

// Executado para cada pixel:
//   1. distância até a borda do retângulo arredondado (técnica "signed
//      distance field": negativa dentro, positiva fora);
//   2. o "vidro": vibração (saturação), brilho, tom de cor e uma linha de
//      luz na borda que depende da direção da luz — a receita mora em
//      glassMath.js (a mesma da prévia da aba Desfoque);
//   3. transparência fora da borda, com 1px de suavização (sem serrilhado).
// A cor chega com alfa PRÉ-MULTIPLICADO; tiramos o alfa para calcular e
// devolvemos no fim.
const MASK_CODE = `
vec2 p = cogl_tex_coord_in[0].xy / orla_tex_scale * orla_size;
vec2 half_size = orla_size * 0.5;
vec2 c = p - half_size;
vec2 q = abs(c) - (half_size - vec2(orla_radius));
float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - orla_radius;

float alpha = cogl_color_out.a;
vec3 base = alpha > 0.0 ? cogl_color_out.rgb / alpha : vec3(0.0);
${GLSL_GLASS_COLOR}
${GLSL_GLASS_RIM}

cogl_color_out = vec4(clamp(base, 0.0, 1.0) * alpha, alpha);
cogl_color_out *= clamp(0.5 - dist, 0.0, 1.0);
`;

// Arredonda o tamanho da textura para cima, em degraus de 64px. Assim, quando
// a dock muda um pouco de tamanho (ampliação), reaproveitamos a mesma textura
// em vez de alocar uma nova a cada quadro.
const TEXTURE_STEP = 64;
const roundUp = v => Math.max(TEXTURE_STEP, Math.ceil(v / TEXTURE_STEP) * TEXTURE_STEP);

export const RoundedBlurEffect = GObject.registerClass(
class OrlaRoundedBlurEffect extends Shell.BlurEffect {
    _init({radius = 30, cornerRadius = 0} = {}) {
        super._init({
            mode: Shell.BlurMode.BACKGROUND,
            brightness: 1.0,
            radius,
        });
        this._cornerRadius = cornerRadius;
        // Valores "neutros": o vidro não altera a cor.
        this._glass = {saturation: 1, lift: 0, tint: [0, 0, 0, 0], glow: 0, angle: 0};
        this._texture = null;
        this._framebuffer = null;
        this._pipeline = null;
        this._texWidth = 0;
        this._texHeight = 0;
    }

    set cornerRadius(value) {
        this._cornerRadius = value;
        this.queue_repaint();
    }

    get cornerRadius() {
        return this._cornerRadius;
    }

    /**
     * Ajustes do vidro (mesma receita da Luma Dock):
     *   saturation  vibração (1 = normal)
     *   lift        quanto clarear (brilho × 0,18)
     *   tint        [r, g, b, força] do tom (0..1)
     *   glow, angle linha de luz na borda e direção (radianos)
     */
    setGlass(glass) {
        this._glass = {...this._glass, ...glass};
        this.queue_repaint();
    }

    get _neutral() {
        const g = this._glass;
        return Math.abs(g.saturation - 1) < 0.01 && g.lift === 0 && g.tint[3] === 0 && g.glow <= 0.01;
    }

    _ensureFramebuffer(actor, width, height) {
        if (this._framebuffer && width <= this._texWidth && height <= this._texHeight)
            return;

        // O contexto Cogl é a "conexão" com a placa de vídeo.
        const context = actor.get_context().get_backend().get_cogl_context();
        this._texWidth = roundUp(width);
        this._texHeight = roundUp(height);
        this._texture = Cogl.Texture2D.new_with_size(context,
            this._texWidth, this._texHeight);
        this._framebuffer = Cogl.Offscreen.new_with_texture(this._texture);

        this._pipeline = Cogl.Pipeline.new(context);
        this._pipeline.set_layer_texture(0, this._texture);
        this._pipeline.set_layer_filters(0,
            Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        this._pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
            MASK_DECLARATIONS, MASK_CODE));

        this._sizeLocation = this._pipeline.get_uniform_location('orla_size');
        this._radiusLocation = this._pipeline.get_uniform_location('orla_radius');
        this._saturationLocation = this._pipeline.get_uniform_location('orla_saturation');
        this._liftLocation = this._pipeline.get_uniform_location('orla_lift');
        this._tintLocation = this._pipeline.get_uniform_location('orla_tint');
        this._glowLocation = this._pipeline.get_uniform_location('orla_glow');
        this._angleLocation = this._pipeline.get_uniform_location('orla_angle');
        this._texScaleLocation = this._pipeline.get_uniform_location('orla_tex_scale');
    }

    vfunc_paint_node(node, paintContext, flags) {
        const actor = this.get_actor();
        // Sem cantos e sem ajustes de vidro, o efeito nativo puro já basta.
        if (!actor || (this._cornerRadius <= 0 && this._neutral)) {
            super.vfunc_paint_node(node, paintContext, flags);
            return;
        }

        // Tamanho do ator em pixels reais da tela (considera escala HiDPI,
        // inclusive fracionária, como 1,25 ou 1,5).
        const [width, height] = actor.get_size();
        // get_resource_scale(): escala do monitor onde o ator está
        // (1 numa tela comum, 2 em HiDPI, ou fracionária como 1,25).
        const scale = actor.get_resource_scale();
        const pixelWidth = Math.ceil(width * scale);
        const pixelHeight = Math.ceil(height * scale);
        // `!(x > 0)` também pega NaN (ator ainda sem tamanho/escala).
        if (!(pixelWidth > 0) || !(pixelHeight > 0))
            return;

        this._ensureFramebuffer(actor, pixelWidth, pixelHeight);

        // Projeção ortográfica: diz que as coordenadas lógicas (0..largura)
        // correspondem aos pixels da textura, já considerando a escala.
        this._framebuffer.orthographic(0, 0,
            this._texWidth / scale, this._texHeight / scale, 0, 1);
        this._framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);

        const usedX = pixelWidth / this._texWidth;
        const usedY = pixelHeight / this._texHeight;
        this._pipeline.set_uniform_float(this._sizeLocation, 2, 1,
            [pixelWidth, pixelHeight]);
        const glass = this._glass;
        this._pipeline.set_uniform_float(this._saturationLocation, 1, 1, [glass.saturation]);
        this._pipeline.set_uniform_float(this._liftLocation, 1, 1, [glass.lift]);
        this._pipeline.set_uniform_float(this._tintLocation, 4, 1, glass.tint);
        this._pipeline.set_uniform_float(this._glowLocation, 1, 1, [glass.glow]);
        this._pipeline.set_uniform_float(this._angleLocation, 1, 1, [glass.angle]);
        this._pipeline.set_uniform_float(this._radiusLocation, 1, 1,
            [Math.min(this._cornerRadius * scale, pixelWidth / 2, pixelHeight / 2)]);
        this._pipeline.set_uniform_float(this._texScaleLocation, 2, 1,
            [usedX, usedY]);

        const layer = Clutter.LayerNode.new_to_framebuffer(
            this._framebuffer, this._pipeline);
        layer.add_texture_rectangle(
            new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height}),
            0, 0, usedX, usedY);
        node.add_child(layer);

        // O Shell.BlurEffect desenha dentro da nossa camada.
        super.vfunc_paint_node(layer, paintContext, flags);
    }
});
