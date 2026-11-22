// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// magnification.js — a matemática da ampliação "em onda".
//
// Ideia: imagine uma lupa que passa ao longo da dock. Cada ponto da dock
// tem um fator de ampliação s(t), que é máximo sob o cursor e cai até 1 a
// uma distância `range`:
//
//         s(t) = 1 + A · forma(|t − cursor| / range)
//
// A "forma" muda conforme o ESTILO de movimento (Fluido, Dominó, Cilindro…).
// Se cada pedacinho da dock é esticado por s(t), a nova posição de um ponto
// u é a INTEGRAL de s até ele. Fixando o ponto sob o cursor:
//
//         novo(u) = u + A · range · G((u − cursor) / range)
//
// onde G é a integral da forma. Como a forma muda por estilo, calculamos G
// numa tabela (uma vez por estilo) e interpolamos.
//
// Vantagens: os ícones nunca se sobrepõem, o ícone sob o cursor não "foge"
// do mouse, e o custo por quadro é O(n) sem criar objetos.
//
// Este arquivo não importa nada do GNOME (dá para testar com `node`).

const TABLE_SIZE = 256;

const bell = r => (Math.cos(r * Math.PI) + 1) * 0.5;
const smoothstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

/**
 * Formas da onda (0 = longe do cursor, 1 = sob o cursor), em função de
 * r = distância / alcance (0..1).
 */
export const SHAPES = {
    fluid: r => bell(r),
    domino: r => bell(r) ** 1.25,
    cylinder: r => Math.sin((1 - r) * Math.PI * 0.5) ** 1.4,
    magnetic: r => bell(r) ** 1.6,
    jelly: r => bell(r),
    coverflow: r => 1 - smoothstep(0, 1, r ** 1.3),
};

export {smoothstep};

const _profiles = new Map();

/**
 * Perfil de um estilo: a forma e a tabela da integral dela.
 *
 * @param {string} style - chave de SHAPES
 * @returns {{shape: Function, integral: Float64Array}}
 */
export function getProfile(style) {
    let profile = _profiles.get(style);
    if (profile)
        return profile;
    const shape = SHAPES[style] ?? SHAPES.fluid;
    // Integral numérica (regra do trapézio) de 0 até cada ponto da tabela.
    const integral = new Float64Array(TABLE_SIZE + 1);
    for (let i = 1; i <= TABLE_SIZE; i++) {
        const a = (i - 1) / TABLE_SIZE;
        const b = i / TABLE_SIZE;
        integral[i] = integral[i - 1] + (shape(a) + shape(b)) / 2 / TABLE_SIZE;
    }
    profile = {shape, integral};
    _profiles.set(style, profile);
    return profile;
}

/** Integral da forma de 0 até d (d pode ser negativo; além de ±1 é constante). */
function integralAt(profile, d) {
    const x = Math.min(1, Math.abs(d)) * TABLE_SIZE;
    const i = Math.floor(x);
    const t = x - i;
    const table = profile.integral;
    const value = i >= TABLE_SIZE ? table[TABLE_SIZE] : table[i] + (table[i + 1] - table[i]) * t;
    return d < 0 ? -value : value;
}

/**
 * Quanto um ponto `u` (no eixo principal) é deslocado pela onda.
 *
 * @param {number} u - posição original
 * @param {number} cursor - posição do cursor
 * @param {number} amplitude - (fator máximo − 1) × intensidade atual (0..1)
 * @param {number} range - alcance da lupa para cada lado
 * @param {object} profile - getProfile(estilo)
 * @returns {number}
 */
export function waveOffset(u, cursor, amplitude, range, profile = getProfile('fluid')) {
    return amplitude * range * integralAt(profile, (u - cursor) / range);
}

/**
 * Calcula escala e deslocamento de cada célula da dock.
 *
 * @param {Float64Array|number[]} starts - início de cada célula (original)
 * @param {Float64Array|number[]} lengths - comprimento de cada célula
 * @param {number} count - quantas células usar
 * @param {number} cursor - posição do cursor no mesmo sistema de coordenadas
 * @param {number} amplitude - (fator máximo − 1) × intensidade atual
 * @param {number} range - alcance da lupa
 * @param {Float64Array} outScale - saída: fator de escala de cada célula
 * @param {Float64Array} outOffset - saída: deslocamento do centro de cada célula
 * @param {object} profile - getProfile(estilo)
 */
export function computeWave(starts, lengths, count, cursor, amplitude, range,
    outScale, outOffset, profile = getProfile('fluid')) {
    for (let i = 0; i < count; i++) {
        const start = starts[i];
        const end = start + lengths[i];
        if (lengths[i] <= 0 || amplitude <= 0) {
            outScale[i] = 1;
            outOffset[i] = 0;
            continue;
        }
        const newStart = start + waveOffset(start, cursor, amplitude, range, profile);
        const newEnd = end + waveOffset(end, cursor, amplitude, range, profile);
        outScale[i] = (newEnd - newStart) / lengths[i];
        outOffset[i] = (newStart + newEnd) / 2 - (start + end) / 2;
    }
}
