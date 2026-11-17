// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// glassMath.js — a "receita" do vidro da dock, num lugar só.
//
// O vidro é: fundo desfocado → vibração (saturação) → brilho (clarear) →
// tom (multiplicar + misturar com a cor) → luz fina na borda.
//
// Quem usa esta receita:
//   - lib/blur.js: o shader (GLSL) da dock real é MONTADO com as constantes
//     e o trecho GLSL daqui;
//   - prefs/blurPreview.js: a prévia da aba Desfoque transforma os mesmos
//     passos numa matriz de cor do GTK (glassColorMatrix) e desenha a luz
//     da borda com a mesma curva (rimIntensity).
// Assim a prévia não pode mostrar uma conta diferente da dock.
//
// Este arquivo não importa nada do GNOME: serve à extensão e às preferências.

/** Brilho: quanto clarear para cada unidade do controle "Brilho". */
export const LIFT_SCALE = 0.18;
/** Tom: parte que MULTIPLICA a cor e parte que MISTURA com ela. */
export const TINT_MULTIPLY = 0.75;
export const TINT_MIX = 0.40;
/** Luz na borda: curva, lado de trás (mais fraco) e ganho. */
export const RIM_POWER = 3.8;
export const RIM_BACK = 0.7;
export const RIM_GAIN = 2.2;
/** Sombreado de 2px na beirada de dentro (o vidro "tem espessura"). */
export const EDGE_SHADE = 0.85;
/** Peso de cada canal na luminância (Rec. 709). */
export const LUMA = [0.2126, 0.7152, 0.0722];

const f = n => n.toFixed(4);

/**
 * Trecho GLSL dos passos de COR (vibração, brilho, tom), com as constantes
 * acima. Recebe/devolve `base` (vec3, sem alfa pré-multiplicado).
 */
export const GLSL_GLASS_COLOR = `
float lum = dot(base, vec3(${LUMA.map(f).join(', ')}));
base = mix(vec3(lum), base, orla_saturation);
base += vec3(orla_lift);
base = mix(base, base * orla_tint.rgb, orla_tint.a * ${f(TINT_MULTIPLY)});
base = mix(base, orla_tint.rgb, orla_tint.a * ${f(TINT_MIX)});
`;

/** Trecho GLSL da luz na borda (precisa de `c`, `half_size`, `dist`). */
export const GLSL_GLASS_RIM = `
if (orla_glow > 0.01) {
    vec2 light = vec2(cos(orla_angle), sin(orla_angle));
    float facing = dot(orla_edge_normal(c, half_size, orla_radius), light);
    float rim = (pow(clamp(facing, 0.0, 1.0), ${f(RIM_POWER)}) +
                 pow(clamp(-facing, 0.0, 1.0), ${f(RIM_POWER)}) * ${f(RIM_BACK)}) * orla_glow;
    float line = smoothstep(-1.8, -0.2, dist) * (1.0 - smoothstep(-0.2, 0.5, dist));
    base += vec3(line * ${f(RIM_GAIN)} * rim);
}
base *= mix(${f(EDGE_SHADE)}, 1.0, smoothstep(0.0, -2.0, dist));
`;

function hexToUnit(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    const n = m ? parseInt(m[1], 16) : 0x241F31;
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/**
 * Os parâmetros do vidro a partir das configurações (um Gio.Settings ou
 * qualquer objeto com get_double/get_string).
 */
export function glassParams(settings) {
    return {
        radius: Math.round(settings.get_double('blur-intensity')),
        saturation: settings.get_double('blur-vibrancy'),
        lift: settings.get_double('blur-brightness') * LIFT_SCALE,
        tint: [...hexToUnit(settings.get_string('blur-tint-color')), settings.get_double('blur-tint-opacity')],
        glow: settings.get_double('blur-border-glow'),
        angle: settings.get_double('blur-highlight-angle') * Math.PI / 180,
    };
}

/**
 * Os passos de cor do vidro como UMA operação linear: cor' = A·cor + b.
 * (Saturação, clarear, multiplicar e misturar são todos lineares, então
 * se juntam.) Devolve A (3×3, linha = canal de saída) e b (3).
 */
export function glassColorTransform({saturation: s, lift, tint}) {
    const [tr, tg, tb, ta] = tint;
    const t = [tr, tg, tb];
    const k1 = ta * TINT_MULTIPLY;
    const k2 = ta * TINT_MIX;
    const A = [];
    const b = [];
    for (let i = 0; i < 3; i++) {
        // Multiplicar pelo tom (só no canal i) e depois misturar com ele.
        const d = (1 + k1 * (t[i] - 1)) * (1 - k2);
        A.push(LUMA.map((w, j) => d * ((1 - s) * w + (i === j ? s : 0))));
        b.push(d * lift + k2 * t[i]);
    }
    return {A, b};
}

/** Intensidade da luz da borda num ponto cuja normal faz `facing` com a luz. */
export function rimIntensity(facing, glow) {
    const front = Math.max(0, facing) ** RIM_POWER;
    const back = Math.max(0, -facing) ** RIM_POWER * RIM_BACK;
    return (front + back) * glow * RIM_GAIN;
}
