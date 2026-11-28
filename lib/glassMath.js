// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// glassMath.js — o "Vidro da Orla": a receita do material, num lugar só.
//
// Para cada pixel do fundo já desfocado:
//
//   1. Refração — perto da borda, o vidro é mais grosso e curvo: o fundo é
//      lido um pouco mais para dentro, como numa lente. Com a dispersão,
//      vermelho, verde e azul se deslocam diferente (um arco-íris sutil).
//   2. Adaptação — mede o brilho (luminância) do que está atrás e o puxa
//      para uma faixa escolhida pelo controle "Tom". Sobre um fundo muito
//      claro ou muito escuro, o vidro continua com o mesmo contraste.
//   3. Vibração — realça (ou tira) a saturação das cores.
//   4. Cor do vidro — modo "cor": usa a matiz da cor escolhida, mas mantém
//      o brilho de cada pixel; o desenho do fundo continua aparecendo.
//   5. Reflexo — um brilho suave vindo de cima, como luz numa superfície
//      curva.
//   6. Relevo da borda — uma linha de luz no lado iluminado e uma sombra
//      fina no lado oposto, conforme a direção da luz.
//   7. Granulado — um ruído quase invisível que evita "degraus" de cor em
//      degradês escuros.
//
// Os passos 2 a 4 são LINEARES (cada canal de saída é uma soma ponderada
// dos canais de entrada, mais uma constante). Por isso a prévia das
// preferências consegue aplicá-los com uma única matriz de cor do GTK
// (colorTransform) e mostrar exatamente a mesma cor da dock.
//
// Quem usa: lib/blur.js (o shader da dock) e prefs/blurPreview.js (a
// prévia). Este arquivo não importa nada do GNOME.

/** Peso de cada canal na luminância (Rec. 709). */
export const LUMA = [0.2126, 0.7152, 0.0722];
/** Faixa de luminância do controle "Tom" (0 = escuro, 1 = claro). */
export const TONE_DARK = 0.12;
export const TONE_LIGHT = 0.86;
/** Quanto do contraste original sobra com a adaptação no máximo. */
export const ADAPT_KEEP = 0.2;
/** Largura da faixa curva da borda (px) e deslocamento máximo nela. */
export const BEVEL_PX = 16;
export const REFRACT_PX = 9;
/** Separação entre as cores na dispersão, em px, no máximo. */
export const DISPERSION_PX = 2.2;
/** Reflexo: quanto clareia no topo e até onde desce (fração da altura). */
export const SHEEN_GAIN = 0.16;
export const SHEEN_REACH = 0.55;
/** Relevo da borda: luz do lado iluminado e sombra do lado oposto. */
export const RIM_LIGHT = 0.55;
export const RIM_SHADOW = 0.22;
/** Granulado: amplitude máxima, em níveis de cor (de 255). */
export const GRAIN_LEVELS = 3.0;

const f = n => Number(n).toFixed(4);

function hexToUnit(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    const n = m ? parseInt(m[1], 16) : 0x16202a;
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const lumaOf = rgb => rgb.reduce((sum, v, i) => sum + v * LUMA[i], 0);

/**
 * Os parâmetros do vidro a partir das configurações (um Gio.Settings ou
 * qualquer objeto com get_double/get_string).
 */
export function glassParams(settings) {
    const tone = settings.get_double('blur-brightness');
    return {
        radius: Math.round(settings.get_double('blur-intensity')),
        target: TONE_DARK + (TONE_LIGHT - TONE_DARK) * tone,
        adapt: settings.get_double('blur-adaptive'),
        saturation: settings.get_double('blur-vibrancy'),
        tint: [...hexToUnit(settings.get_string('blur-tint-color')), settings.get_double('blur-tint-opacity')],
        refraction: settings.get_double('blur-refraction'),
        dispersion: settings.get_double('blur-dispersion'),
        sheen: settings.get_double('blur-sheen'),
        glow: settings.get_double('blur-border-glow'),
        angle: settings.get_double('blur-highlight-angle') * Math.PI / 180,
        grain: settings.get_double('blur-grain'),
    };
}

/** Parâmetros que não mudam nada (o vidro mostra o desfoque puro). */
export const NEUTRAL = Object.freeze({
    target: 0.5, adapt: 0, saturation: 1, tint: [0, 0, 0, 0],
    refraction: 0, dispersion: 0, sheen: 0, glow: 0, angle: 0, grain: 0,
});

/**
 * Passos 2 a 4 como uma operação: cor' = A·cor + b.
 * Devolve A (3×3, linha = canal de saída) e b (3).
 */
export function colorTransform({target, adapt, saturation, tint}) {
    // Começa na identidade e aplica cada passo por cima: M ← P·M, v ← P·v + p.
    let A = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    let b = [0, 0, 0];
    const apply = (P, p) => {
        A = P.map(row => [0, 1, 2].map(j => row.reduce((s, v, k) => s + v * A[k][j], 0)));
        b = P.map((row, i) => row.reduce((s, v, k) => s + v * b[k], 0) + p[i]);
    };
    // 2. Adaptação: cor + k·(alvo − L), com k = adapt·(1 − ADAPT_KEEP).
    const k = adapt * (1 - ADAPT_KEEP);
    apply([0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? 1 : 0) - k * LUMA[j])), [k * target, k * target, k * target]);
    // 3. Vibração: L + s·(cor − L).
    apply([0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? saturation : 0) + (1 - saturation) * LUMA[j])), [0, 0, 0]);
    // 4. Cor do vidro (modo "cor"): mistura com tom + (L − L_tom).
    const [tr, tg, tb, ta] = tint;
    const tLuma = lumaOf([tr, tg, tb]);
    apply([0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? 1 - ta : 0) + ta * LUMA[j])),
        [tr, tg, tb].map(t => ta * (t - tLuma)));
    return {A, b};
}

/** Luz (positivo) ou sombra (negativo) da borda num ponto da borda. */
export function rimLight(facing, glow) {
    return facing >= 0
        ? Math.pow(facing, 2) * RIM_LIGHT * glow
        : -Math.pow(-facing, 2) * RIM_SHADOW * glow;
}

// ---------------------------------------------------------------------
// O shader da dock (lib/blur.js monta o pipeline com estes trechos)
// ---------------------------------------------------------------------

export const GLSL_DECLARATIONS = `
uniform vec2 orla_size;          // tamanho da dock, em pixels
uniform vec2 orla_tex_scale;     // parte usada da textura (0..1)
uniform float orla_radius;       // raio dos cantos, em pixels
uniform float orla_scale;        // escala da tela (HiDPI)
uniform float orla_target;
uniform float orla_adapt;
uniform float orla_saturation;
uniform vec4 orla_tint;
uniform float orla_refraction;
uniform float orla_dispersion;
uniform float orla_sheen;
uniform float orla_glow;
uniform float orla_angle;
uniform float orla_grain;

const vec3 ORLA_LUMA = vec3(${LUMA.map(f).join(', ')});

// Distância até a borda de um retângulo arredondado centrado em 0
// (negativa dentro, positiva fora).
float orla_sdf(vec2 p, vec2 half_size, float r) {
    vec2 q = abs(p) - (half_size - vec2(r));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Direção "para fora" da borda mais próxima, calculada pela variação da
// distância (gradiente): funciona igual nos lados e nos cantos.
vec2 orla_normal(vec2 p, vec2 half_size, float r) {
    float e = 0.5;
    vec2 g = vec2(orla_sdf(p + vec2(e, 0.0), half_size, r) - orla_sdf(p - vec2(e, 0.0), half_size, r),
                  orla_sdf(p + vec2(0.0, e), half_size, r) - orla_sdf(p - vec2(0.0, e), half_size, r));
    float len = length(g);
    return len > 0.0001 ? g / len : vec2(0.0, -1.0);
}

// Lê o fundo desfocado num ponto (em pixels), já sem o alfa multiplicado.
vec4 orla_sample(vec2 p) {
    vec2 uv = clamp(p, vec2(0.5), orla_size - vec2(0.5)) / orla_size * orla_tex_scale;
    return texture2D(cogl_sampler0, uv);
}

float orla_hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

export const GLSL_CODE = `
vec2 p = cogl_tex_coord_in[0].xy / orla_tex_scale * orla_size;
vec2 half_size = orla_size * 0.5;
vec2 c = p - half_size;
float dist = orla_sdf(c, half_size, orla_radius);
vec2 n = orla_normal(c, half_size, orla_radius);

// 1. Refração e dispersão: perto da borda, lê o fundo mais para dentro.
float bevel = min(${f(BEVEL_PX)} * orla_scale, min(half_size.x, half_size.y) * 0.9);
float t = clamp(1.0 + dist / max(bevel, 1.0), 0.0, 1.0);   // 1 na borda, 0 no miolo
float bend = orla_refraction * ${f(REFRACT_PX)} * orla_scale * t * t;
vec4 texel = cogl_color_out;
vec3 base;
if (bend > 0.01) {
    float spread = orla_dispersion * ${f(DISPERSION_PX)} * orla_scale * t;
    vec4 g = orla_sample(p - n * bend);
    float r = orla_sample(p - n * (bend + spread)).r;
    float b = orla_sample(p - n * max(bend - spread, 0.0)).b;
    texel = vec4(r, g.g, b, g.a);
}
float alpha = texel.a;
base = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);

// 2. Adaptação ao brilho do que está atrás.
float lum = dot(base, ORLA_LUMA);
base += vec3(orla_adapt * ${f(1 - ADAPT_KEEP)} * (orla_target - lum));
// 3. Vibração.
lum = dot(base, ORLA_LUMA);
base = mix(vec3(lum), base, orla_saturation);
// 4. Cor do vidro, modo "cor" (matiz do tom, brilho do pixel).
float tint_lum = dot(orla_tint.rgb, ORLA_LUMA);
base = mix(base, orla_tint.rgb + vec3(lum - tint_lum), orla_tint.a);

// 5. Reflexo vindo de cima.
float from_top = p.y / max(orla_size.y, 1.0);
base += vec3(orla_sheen * ${f(SHEEN_GAIN)} * pow(clamp(1.0 - from_top / ${f(SHEEN_REACH)}, 0.0, 1.0), 2.0));

// 6. Relevo da borda: luz de um lado, sombra do outro.
if (orla_glow > 0.01) {
    vec2 light = vec2(cos(orla_angle), sin(orla_angle));
    float facing = dot(n, light);
    float line = smoothstep(-1.6 * orla_scale, -0.2, dist) * (1.0 - smoothstep(-0.2, 0.6, dist));
    float amount = facing >= 0.0
        ? facing * facing * ${f(RIM_LIGHT)}
        : -facing * facing * ${f(RIM_SHADOW)};
    base += vec3(line * amount * orla_glow * 1.6);
    // A faixa curva também pega um pouco de luz do lado iluminado.
    base += vec3(t * t * max(facing, 0.0) * orla_glow * 0.06);
}

// 7. Granulado.
base += vec3((orla_hash(floor(p)) - 0.5) * orla_grain * ${f(GRAIN_LEVELS / 255)} * 2.0);

cogl_color_out = vec4(clamp(base, 0.0, 1.0) * alpha, alpha);
// Fora da borda: transparente, com 1px de suavização.
cogl_color_out *= clamp(0.5 - dist, 0.0, 1.0);
`;
