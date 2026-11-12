// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// magnification.js — a matemática da ampliação "em onda".
//
// Ideia: imagine uma lupa que passa ao longo da dock. Cada ponto da dock
// tem um fator de ampliação s(t), que é máximo sob o cursor e cai suavemente
// (curva de cosseno) até 1 a uma distância `range`:
//
//         s(t) = 1 + A · g((t − cursor) / range),   g(d) = (1 + cos(π·d)) / 2
//
// Se cada pedacinho da dock é esticado por s(t), a nova posição de um ponto
// u é a INTEGRAL de s até ele. Fixando o ponto sob o cursor (ele não se mexe),
// fica:
//
//         novo(u) = u + A · range · G((u − cursor) / range)
//
// onde G é a integral de g: G(d) = d/2 + sen(π·d)/(2π) (e ±1/2 fora da lupa).
//
// Vantagens desse método:
//   - os ícones nunca se sobrepõem nem abrem buracos (a função é contínua);
//   - o ícone sob o cursor não "foge" do mouse;
//   - o custo é O(n) e não cria objetos: só números.
//
// O dock.js usa o resultado para mudar `scale` e `translation` dos ícones —
// propriedades que NÃO causam relayout no Clutter, só redesenho. Por isso
// a animação fica leve mesmo a 60+ fps.

const HALF_INV_PI = 1 / (2 * Math.PI);

/** Integral normalizada do perfil de cosseno. */
function integral(d) {
    if (d <= -1)
        return -0.5;
    if (d >= 1)
        return 0.5;
    return d / 2 + Math.sin(Math.PI * d) * HALF_INV_PI;
}

/**
 * Quanto um ponto `u` (no eixo principal) é deslocado pela onda.
 *
 * @param {number} u - posição original
 * @param {number} cursor - posição do cursor
 * @param {number} amplitude - (fator máximo − 1) × intensidade atual (0..1)
 * @param {number} range - alcance da lupa para cada lado
 * @returns {number}
 */
export function waveOffset(u, cursor, amplitude, range) {
    return amplitude * range * integral((u - cursor) / range);
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
 */
export function computeWave(starts, lengths, count, cursor, amplitude, range,
    outScale, outOffset) {
    for (let i = 0; i < count; i++) {
        const start = starts[i];
        const end = start + lengths[i];
        if (lengths[i] <= 0 || amplitude <= 0) {
            outScale[i] = 1;
            outOffset[i] = 0;
            continue;
        }
        const newStart = start + waveOffset(start, cursor, amplitude, range);
        const newEnd = end + waveOffset(end, cursor, amplitude, range);
        outScale[i] = (newEnd - newStart) / lengths[i];
        outOffset[i] = (newStart + newEnd) / 2 - (start + end) / 2;
    }
}
