// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// wobblyMath.js — a física das "janelas balançando".
//
// A janela vira uma malha de n × n pontos. Para cada ponto guardamos só o
// DESLOCAMENTO (dx, dy) em relação ao lugar onde ele deveria estar
// (o "repouso") e a velocidade dele. Deslocamento zero = janela normal.
//
// Forças em cada ponto (tudo linear, por isso é estável e previsível):
//   - mola com os vizinhos: k · Σ(d_vizinho − d_ponto). É uma mola "vetorial":
//     ela quer que a DIFERENÇA entre dois pontos volte a ser a do repouso,
//     então a malha nunca fica torta para sempre (nem gira);
//   - mola de volta para casa: k · HOME_RATIO · (−d). Garante que, solta, a
//     janela volta EXATAMENTE para o lugar (deslocamento zero);
//   - atrito: −atrito · v (perde energia e para de balançar);
//   - atrito interno: atrito · INNER_DAMPING · Σ(v_vizinho − v_ponto). Acalma
//     as vibrações rápidas entre vizinhos sem frear o balanço grande.
// Aceleração = força / massa.
//
// Quando a janela anda, os pontos "ficam para trás" (inércia): o ponto
// segurado pelo mouse (a âncora) acompanha a janela e os outros são puxados
// pelas molas — é isso que faz a janela parecer gelatina.
//
// Este arquivo não importa nada do GNOME (dá para testar com `node`).

const HOME_RATIO = 0.5;
const INNER_DAMPING = 1.5;
const MAX_STEP = 1 / 240;          // passo máximo da simulação (s)
const MAX_FRAME = 1 / 20;          // um quadro travado não vira uma "explosão"
const REST_DISTANCE = 0.5;         // px: abaixo disto a malha está parada
const REST_SPEED = 2;              // px/s

/** Pesos de Catmull-Rom (curva suave que passa pelos pontos da malha). */
function catmullRom(t, out) {
    const t2 = t * t;
    const t3 = t2 * t;
    out[0] = (-t3 + 2 * t2 - t) / 2;
    out[1] = (3 * t3 - 5 * t2 + 2) / 2;
    out[2] = (-3 * t3 + 4 * t2 + t) / 2;
    out[3] = (t3 - t2) / 2;
}

export class SpringMesh {
    /** @param {number} n - pontos por lado (3 a 12) */
    constructor(n) {
        this.n = n;
        const count = n * n;
        this.dx = new Float64Array(count);
        this.dy = new Float64Array(count);
        this.vx = new Float64Array(count);
        this.vy = new Float64Array(count);
        this._ax = new Float64Array(count);
        this._ay = new Float64Array(count);
        this._wu = new Float64Array(4);
        this._wv = new Float64Array(4);
        this.anchor = -1;
        this.setParams({spring: 400, friction: 9, mass: 1});
    }

    setParams({spring, friction, mass}) {
        this.k = spring;
        this.c = friction;
        this.m = Math.max(0.05, mass);
        // Passo seguro: menor que o período da vibração mais rápida e que o
        // tempo de frenagem do atrito (senão a integração explode).
        const omega = Math.sqrt((8 + HOME_RATIO) * this.k / this.m);
        const damping = this.c * (1 + 8 * INNER_DAMPING) / this.m;
        this._step = Math.min(MAX_STEP, 0.5 / omega, 0.5 / Math.max(damping, 1e-6));
    }

    /** Prende o ponto mais perto de (u, v) — coordenadas 0..1 na janela. */
    pin(u, v) {
        const n = this.n;
        const i = Math.round(Math.min(1, Math.max(0, u)) * (n - 1));
        const j = Math.round(Math.min(1, Math.max(0, v)) * (n - 1));
        this.anchor = j * n + i;
        this._zero(this.anchor);
    }

    release() {
        this.anchor = -1;
    }

    _zero(i) {
        this.dx[i] = this.dy[i] = this.vx[i] = this.vy[i] = 0;
    }

    /**
     * A janela foi de `from` para `to` ({x, y, w, h}). Os pontos ficam onde
     * estavam na tela (inércia), então o deslocamento deles muda. `limit`
     * limita o quanto um ponto pode ficar para trás (em px).
     */
    shift(from, to, limit = Infinity) {
        const n = this.n;
        for (let j = 0; j < n; j++) {
            const gy = j / (n - 1);
            const moveY = (to.y + gy * to.h) - (from.y + gy * from.h);
            for (let i = 0; i < n; i++) {
                const p = j * n + i;
                if (p === this.anchor)
                    continue;
                const gx = i / (n - 1);
                const moveX = (to.x + gx * to.w) - (from.x + gx * from.w);
                let dx = this.dx[p] - moveX;
                let dy = this.dy[p] - moveY;
                const length = Math.hypot(dx, dy);
                if (length > limit) {
                    dx *= limit / length;
                    dy *= limit / length;
                }
                this.dx[p] = dx;
                this.dy[p] = dy;
            }
        }
    }

    /**
     * Avança a simulação `dt` segundos.
     *
     * @returns {boolean} true enquanto a malha ainda se mexe
     */
    step(dt) {
        dt = Math.min(dt, MAX_FRAME);
        if (dt <= 0)
            return !this.isAtRest();
        const steps = Math.ceil(dt / this._step);
        const h = dt / steps;
        for (let s = 0; s < steps; s++)
            this._substep(h);
        if (this.isAtRest()) {
            this.reset();
            return false;
        }
        return true;
    }

    _substep(h) {
        const {n, k, c, m, dx, dy, vx, vy, _ax: ax, _ay: ay} = this;
        const home = k * HOME_RATIO;
        const inner = c * INNER_DAMPING;
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const p = j * n + i;
                let fx = -home * dx[p] - c * vx[p];
                let fy = -home * dy[p] - c * vy[p];
                // Vizinhos à esquerda, direita, acima e abaixo.
                for (let q = 0; q < 4; q++) {
                    let o;
                    if (q === 0) {
                        if (i === 0)
                            continue;
                        o = p - 1;
                    } else if (q === 1) {
                        if (i === n - 1)
                            continue;
                        o = p + 1;
                    } else if (q === 2) {
                        if (j === 0)
                            continue;
                        o = p - n;
                    } else {
                        if (j === n - 1)
                            continue;
                        o = p + n;
                    }
                    fx += k * (dx[o] - dx[p]) + inner * (vx[o] - vx[p]);
                    fy += k * (dy[o] - dy[p]) + inner * (vy[o] - vy[p]);
                }
                ax[p] = fx / m;
                ay[p] = fy / m;
            }
        }
        // Euler semi-implícito: primeiro a velocidade, depois a posição.
        for (let p = 0; p < n * n; p++) {
            if (p === this.anchor)
                continue;
            vx[p] += ax[p] * h;
            vy[p] += ay[p] * h;
            dx[p] += vx[p] * h;
            dy[p] += vy[p] * h;
        }
    }

    isAtRest() {
        for (let p = 0; p < this.n * this.n; p++) {
            if (Math.abs(this.dx[p]) > REST_DISTANCE || Math.abs(this.dy[p]) > REST_DISTANCE ||
                Math.abs(this.vx[p]) > REST_SPEED || Math.abs(this.vy[p]) > REST_SPEED)
                return false;
        }
        return true;
    }

    /** Zera tudo: a janela volta exatamente ao normal. */
    reset() {
        this.dx.fill(0);
        this.dy.fill(0);
        this.vx.fill(0);
        this.vy.fill(0);
    }

    /** O maior deslocamento atual (para saber quanto redesenhar em volta). */
    maxDisplacement() {
        let max = 0;
        for (let p = 0; p < this.n * this.n; p++)
            max = Math.max(max, Math.abs(this.dx[p]), Math.abs(this.dy[p]));
        return max;
    }

    /**
     * Deslocamento num ponto qualquer (u, v ∈ 0..1) da janela, interpolado
     * suavemente entre os pontos da malha. Escreve [dx, dy] em `out`.
     */
    sample(u, v, out) {
        const n = this.n;
        const fu = Math.min(1, Math.max(0, u)) * (n - 1);
        const fv = Math.min(1, Math.max(0, v)) * (n - 1);
        const iu = Math.min(n - 2, Math.floor(fu));
        const iv = Math.min(n - 2, Math.floor(fv));
        catmullRom(fu - iu, this._wu);
        catmullRom(fv - iv, this._wv);
        let x = 0;
        let y = 0;
        for (let b = 0; b < 4; b++) {
            const row = Math.min(n - 1, Math.max(0, iv - 1 + b)) * n;
            const wv = this._wv[b];
            for (let a = 0; a < 4; a++) {
                const p = row + Math.min(n - 1, Math.max(0, iu - 1 + a));
                const w = this._wu[a] * wv;
                x += this.dx[p] * w;
                y += this.dy[p] * w;
            }
        }
        out[0] = x;
        out[1] = y;
    }
}
