// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// magnifier.js — o "motor" da ampliação, pensado para ser FLUIDO.
//
// O problema da versão ingênua: aplicar a onda direto em cada evento de
// movimento do mouse. Esses eventos chegam em intervalos irregulares (às
// vezes 3 num quadro, às vezes nenhum), então os ícones andam aos trancos.
//
// A solução (a mesma ideia usada em motores de jogos):
//   1. o mouse só atualiza o ALVO (onde a onda deveria estar);
//   2. um relógio sincronizado com a tela (Clutter.Timeline, que dispara
//      'new-frame' uma vez por quadro do monitor) move os valores ATUAIS
//      uma fração do caminho em direção ao alvo, a cada quadro;
//   3. quando tudo chega no alvo, o relógio para (não gasta CPU à toa).
//
// A fração é independente da taxa de atualização da tela:
//
//     fator = 1 − (1 − suavidade) ^ (dt / 16,7 ms)
//
// Assim, num monitor de 60 Hz ou de 144 Hz a sensação é a mesma.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {computeWave, waveOffset} from './magnification.js';

const REFERENCE_FRAME_MS = 1000 / 60;
const EPSILON_SCALE = 0.001;
const EPSILON_PX = 0.15;

export class Magnifier {
    constructor(dock) {
        this._dock = dock;
        this._pointer = 0;        // posição do cursor no eixo principal
        this._targetZoom = 0;     // 1 = cursor na dock, 0 = fora
        this._capacity = 0;
        this._lastTime = 0;
        this._bgStart = null;
        this._bgEnd = null;

        // Uma Timeline "infinita" ligada ao _root: ela usa o relógio de
        // quadros do monitor onde a dock está.
        this._timeline = new Clutter.Timeline({
            actor: dock.root,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;
    }

    _ensureCapacity(n) {
        if (this._capacity >= n)
            return;
        const size = Math.max(n, this._capacity * 2, 16);
        const grow = old => {
            const arr = new Float64Array(size);
            if (old)
                arr.set(old.subarray(0, Math.min(old.length, size)));
            return arr;
        };
        this._targetScale = grow(this._targetScale);
        this._targetOffset = grow(this._targetOffset);
        // Valores atuais começam "em repouso" (escala 1).
        const oldCur = this._curScale;
        this._curScale = new Float64Array(size).fill(1);
        if (oldCur)
            this._curScale.set(oldCur.subarray(0, Math.min(oldCur.length, size)));
        this._curOffset = grow(this._curOffset);
        this._capacity = size;
    }

    /** O cursor se moveu sobre a dock (posição no eixo principal). */
    pointerMoved(main) {
        this._pointer = main;
        this._targetZoom = 1;
        this._start();
    }

    /** O cursor saiu da dock: volta tudo ao normal, suavemente. */
    leave() {
        this._targetZoom = 0;
        this._start();
    }

    /** Zera na hora, sem animação (ex.: ao abrir um menu). */
    reset() {
        this._targetZoom = 0;
        if (this._curScale) {
            this._curScale.fill(1);
            this._curOffset.fill(0);
        }
        this._bgStart = this._bgEnd = null;
        this._timeline.stop();
        this._apply();
    }

    get active() {
        return this._targetZoom > 0;
    }

    /** O layout mudou (item entrou/saiu, tamanho mudou): reaplica. */
    layoutChanged() {
        this._ensureCapacity(this._dock.waveCount + 1);
        if (this._timeline.is_playing())
            return;   // o próximo quadro já aplica
        // Parado = já tinha chegado no alvo. Recalcula o alvo para o novo
        // layout e "encaixa" direto nele.
        const d = this._dock;
        this._computeTargets();
        const count = d.waveCount;
        this._curScale.set(this._targetScale.subarray(0, count));
        this._curOffset.set(this._targetOffset.subarray(0, count));
        this._bgStart = d.baseStart + waveOffset(d.baseStart, this._pointer, this._amplitude, this._range);
        this._bgEnd = d.baseEnd + waveOffset(d.baseEnd, this._pointer, this._amplitude, this._range);
        this._apply();
    }

    _start() {
        this._ensureCapacity(this._dock.waveCount + 1);
        if (!this._timeline.is_playing()) {
            this._lastTime = GLib.get_monotonic_time();
            this._timeline.start();
        }
    }

    _computeTargets() {
        const d = this._dock;
        const g = d.geometry;
        const count = d.waveCount;
        const amplitude = (g.maxScale - 1) * this._targetZoom;
        const range = g.iconSize * d.settings.get_double('magnification-radius');
        this._amplitude = amplitude;
        this._range = range;
        computeWave(d.waveStarts, d.waveLengths, count, this._pointer,
            amplitude, range, this._targetScale, this._targetOffset);
    }

    _tick() {
        const d = this._dock;
        if (!d.geometry)
            return;
        const now = GLib.get_monotonic_time();
        const dt = Math.min(64, Math.max(4, (now - this._lastTime) / 1000));
        this._lastTime = now;

        const smoothness = d.settings.get_double('magnification-smoothness');
        const factor = 1 - Math.pow(1 - smoothness, dt / REFERENCE_FRAME_MS);

        this._computeTargets();
        const count = d.waveCount;
        let moving = false;
        for (let i = 0; i < count; i++) {
            const ds = this._targetScale[i] - this._curScale[i];
            const dOff = this._targetOffset[i] - this._curOffset[i];
            if (Math.abs(ds) > EPSILON_SCALE || Math.abs(dOff) > EPSILON_PX) {
                this._curScale[i] += ds * factor;
                this._curOffset[i] += dOff * factor;
                moving = true;
            } else {
                this._curScale[i] = this._targetScale[i];
                this._curOffset[i] = this._targetOffset[i];
            }
        }

        // As pontas do fundo também são suavizadas.
        const start = d.baseStart + waveOffset(d.baseStart, this._pointer, this._amplitude, this._range);
        const end = d.baseEnd + waveOffset(d.baseEnd, this._pointer, this._amplitude, this._range);
        if (this._bgStart === null) {
            this._bgStart = start;
            this._bgEnd = end;
        } else {
            this._bgStart += (start - this._bgStart) * factor;
            this._bgEnd += (end - this._bgEnd) * factor;
            if (Math.abs(start - this._bgStart) > EPSILON_PX || Math.abs(end - this._bgEnd) > EPSILON_PX)
                moving = true;
            else
                [this._bgStart, this._bgEnd] = [start, end];
        }

        this._apply();
        if (!moving)
            this._timeline.stop();
    }

    /** Escreve os valores atuais nos atores (só escala/translação). */
    _apply() {
        const d = this._dock;
        const g = d.geometry;
        if (!g || !this._curScale)
            return;
        const maxExtra = Math.max(0.001, g.maxScale - 1);
        const rise = d.settings.get_int('magnification-rise');
        for (const item of d.orderedItems) {
            const i = item.waveIndex;
            if (i === undefined || i >= this._capacity)
                continue;
            const scale = this._curScale[i];
            // Elevação proporcional ao quanto o ícone está ampliado.
            const lift = rise * Math.min(1, (scale - 1) / maxExtra);
            item.setWave(scale, this._curOffset[i], lift);
        }
        const start = this._bgStart ?? d.baseStart;
        const end = this._bgEnd ?? d.baseEnd;
        d.placeBackground(start, end);
    }
}
