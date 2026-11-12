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

// Declarações GLSL: variáveis "uniform" são parâmetros que o JavaScript
// envia para a placa de vídeo.
const MASK_DECLARATIONS = `
uniform vec2 orla_size;
uniform float orla_radius;
uniform vec2 orla_tex_scale;
uniform float orla_saturation;
`;

// Executado para cada pixel. Calcula a distância do pixel até a borda de um
// retângulo arredondado (técnica "signed distance field") e usa isso como
// transparência, com 1px de suavização para não serrilhar a curva.
const MASK_CODE = `
vec2 p = cogl_tex_coord_in[0].xy / orla_tex_scale * orla_size;
vec2 half_size = orla_size * 0.5;
vec2 q = abs(p - half_size) - (half_size - vec2(orla_radius));
float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - orla_radius;
// "Vibração": mistura com a versão cinza para tirar ou dar saturação.
// Funciona com alfa pré-multiplicado porque é uma operação linear.
float gray = dot(cogl_color_out.rgb, vec3(0.2126, 0.7152, 0.0722));
cogl_color_out.rgb = max(mix(vec3(gray), cogl_color_out.rgb, orla_saturation), 0.0);
cogl_color_out.rgb = min(cogl_color_out.rgb, vec3(cogl_color_out.a));
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
        this._vibrancy = 1;
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

    /** Saturação do que se vê pelo vidro (1 = normal, 0 = cinza). */
    set vibrancy(value) {
        this._vibrancy = value;
        this.queue_repaint();
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
        this._texScaleLocation = this._pipeline.get_uniform_location('orla_tex_scale');
    }

    vfunc_paint_node(node, paintContext, flags) {
        const actor = this.get_actor();
        // Sem cantos e sem vibração, o efeito nativo puro já basta.
        if (!actor || (this._cornerRadius <= 0 && Math.abs(this._vibrancy - 1) < 0.01)) {
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
        this._pipeline.set_uniform_float(this._saturationLocation, 1, 1, [this._vibrancy]);
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
