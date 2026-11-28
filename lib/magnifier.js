// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
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
//
// Estilos de movimento: além do formato da onda
// (magnification.js), alguns estilos giram ou deformam os ícones:
//   Fluido     só a onda;
//   Dominó     os vizinhos tombam para os lados (rotação no plano);
//   Cilindro   os ícones giram em 3D como num tambor;
//   Magnético  os vizinhos são puxados em direção ao cursor;
//   Gelatina   os ícones esticam/achatam conforme a velocidade do mouse;
//   Coverflow  os ícones dos lados viram em 3D, como capas de disco.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {computeWave, getProfile, smoothstep, waveOffset} from './magnification.js';

const REFERENCE_FRAME_MS = 1000 / 60;
const EPSILON_SCALE = 0.001;
const EPSILON_PX = 0.15;
const EPSILON_DEG = 0.05;
const VELOCITY_DECAY = 0.85;   // a "inércia" da gelatina some aos poucos

// Canais animados de cada ícone (cada um tem alvo e valor atual):
//   scale  escala no eixo principal     cross  escala no eixo cruzado
//   offset deslocamento no eixo principal
//   rotA   rotação no plano (Dominó)    rotB   rotação 3D (Cilindro, Coverflow)
const CHANNELS = ['scale', 'cross', 'offset', 'rotA', 'rotB'];
const REST = {scale: 1, cross: 1, offset: 0, rotA: 0, rotB: 0};
const EPSILON = {scale: EPSILON_SCALE, cross: EPSILON_SCALE, offset: EPSILON_PX, rotA: EPSILON_DEG, rotB: EPSILON_DEG};

export class Magnifier {
    constructor(dock) {
        this._dock = dock;
        this._pointer = 0;        // posição do cursor no eixo principal
        this._velocity = 0;       // velocidade do cursor (px/ms), suavizada
        this._lastMotion = 0;
        this._targetZoom = 0;     // 1 = cursor na dock, 0 = fora
        this._capacity = 0;
        this._lastTime = 0;
        this._bgStart = null;
        this._bgEnd = null;
        this._target = {};
        this._current = {};

        // Uma Timeline "infinita" ligada ao _root: ela usa o relógio de
        // quadros do monitor onde a dock está.
        this._timeline = new Clutter.Timeline({
            actor: dock.root,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());

        // As opções ficam guardadas aqui e só são relidas quando mudam: ler
        // o GSettings dezenas de vezes por segundo, no meio da animação,
        // custava tempo de quadro à toa.
        this._readOptions();
        this._settingsId = dock.settings.connect('changed', (_s, key) => {
            if (key.startsWith('magnification-'))
                this._readOptions();
        });
    }

    destroy() {
        this._dock.settings.disconnect(this._settingsId);
        this._timeline.stop();
        this._timeline = null;
    }

    _readOptions() {
        const s = this._dock.settings;
        const style = s.get_string('magnification-style');
        this._opt = {
            style,
            profile: getProfile(style),
            // "Abrir espaço": os vizinhos se afastam. A força 2 corresponde
            // a afastar exatamente o necessário; valores maiores afastam menos.
            push: s.get_boolean('magnification-make-room') ? 2 / s.get_double('magnification-push') : 0,
            radius: s.get_double('magnification-radius'),
            tilt: s.get_int('magnification-domino-tilt'),
            curve: s.get_int('magnification-cylinder-angle'),
            pull: s.get_int('magnification-magnetic-strength'),
            stretch: s.get_double('magnification-jelly-stretch'),
            squish: s.get_double('magnification-jelly-squish'),
            card: s.get_int('magnification-coverflow-angle'),
            smoothness: s.get_double('magnification-smoothness'),
            rise: s.get_int('magnification-rise'),
        };
    }

    /**
     * Até quanto a onda pode esticar cada ponta do fundo (px). É o maior
     * deslocamento possível de um ponto: (fator − 1) × alcance × a integral
     * inteira da curva — o cursor longe da ponta, a onda toda de um lado.
     * A dock usa isso para dar ao vidro um tamanho fixo durante a ampliação.
     */
    get backgroundReach() {
        const g = this._dock.geometry;
        const o = this._opt;
        if (!g || o.push <= 0 || g.maxScale <= 1)
            return 0;
        const range = g.iconSize * o.radius;
        return o.push * waveOffset(range * 2, 0, g.maxScale - 1, range, o.profile) + 1;
    }

    _ensureCapacity(n) {
        if (this._capacity >= n)
            return;
        const size = Math.max(n, this._capacity * 2, 16);
        for (const channel of CHANNELS) {
            for (const store of [this._target, this._current]) {
                const old = store[channel];
                const arr = new Float64Array(size).fill(REST[channel]);
                if (old)
                    arr.set(old.subarray(0, Math.min(old.length, size)));
                store[channel] = arr;
            }
        }
        this._capacity = size;
    }

    /** O cursor se moveu sobre a dock (posição no eixo principal). */
    pointerMoved(main) {
        const now = GLib.get_monotonic_time();
        if (this._lastMotion) {
            const dt = Math.min(60, Math.max(8, (now - this._lastMotion) / 1000));
            const instant = (main - this._pointer) / dt;
            this._velocity += (instant - this._velocity) * 0.4;
        }
        this._lastMotion = now;
        this._pointer = main;
        this._targetZoom = 1;
        this._start();
    }

    /** O cursor saiu da dock: volta tudo ao normal, suavemente. */
    leave() {
        this._targetZoom = 0;
        this._lastMotion = 0;
        this._start();
    }

    /** Zera na hora, sem animação (ex.: ao abrir um menu). */
    reset() {
        this._targetZoom = 0;
        this._velocity = 0;
        this._lastMotion = 0;
        for (const channel of CHANNELS)
            this._current[channel]?.fill(REST[channel]);
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
        const count = this._dock.waveCount;
        this._computeTargets();
        for (const channel of CHANNELS)
            this._current[channel].set(this._target[channel].subarray(0, count));
        [this._bgStart, this._bgEnd] = this._backgroundTarget();
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
        const o = this._opt;
        const count = d.waveCount;
        const t = this._target;
        this._style = o.style;
        this._profile = o.profile;
        this._push = o.push;
        const amplitude = (g.maxScale - 1) * this._targetZoom;
        const range = g.iconSize * o.radius;
        this._amplitude = amplitude;
        this._range = range;
        computeWave(d.waveStarts, d.waveLengths, count, this._pointer,
            amplitude, range, t.scale, t.offset, this._profile);

        const zoom = this._targetZoom;
        const style = this._style;
        const {tilt, curve, pull, stretch, squish, card} = o;
        const velocity = Math.max(-1, Math.min(1, this._velocity * 0.5));

        for (let i = 0; i < count; i++) {
            t.offset[i] *= this._push;
            t.cross[i] = t.scale[i];
            t.rotA[i] = 0;
            t.rotB[i] = 0;
            if (zoom <= 0 || amplitude <= 0)
                continue;
            // delta > 0: o ícone está ANTES do cursor (à esquerda/acima).
            const center = d.waveStarts[i] + d.waveLengths[i] / 2;
            const delta = this._pointer - center;
            const ratio = Math.abs(delta) / range;
            if (ratio >= 1)
                continue;
            const side = delta > 0 ? 1 : -1;

            switch (style) {
            case 'domino':
                t.rotA[i] = side * Math.sin(ratio * Math.PI) * tilt;
                break;
            case 'cylinder':
                t.rotB[i] = -Math.sin(Math.max(-1, Math.min(1, delta / range)) * Math.PI / 2) * curve;
                break;
            case 'coverflow':
                if (Math.abs(delta) > 2)
                    t.rotB[i] = side * smoothstep(0, 0.85, ratio) * card;
                break;
            case 'magnetic':
                t.offset[i] += side * Math.sin(ratio * Math.PI) * (1 - ratio) * pull;
                break;
            case 'jelly': {
                // Mistura da posição (60%) com a velocidade do mouse (40%).
                const bell = (Math.cos(ratio * Math.PI) + 1) / 2;
                const drive = (Math.sin(delta / range * Math.PI) * 0.6 + velocity * 0.4) * bell;
                const grow = drive >= 0 ? drive * stretch : -Math.abs(drive) * squish;
                const flat = drive >= 0 ? drive * squish : -Math.abs(drive) * stretch;
                const base = t.scale[i];
                t.scale[i] = Math.max(0.35, base * (1 + grow));
                t.cross[i] = Math.max(0.35, base * (1 - flat));
                t.offset[i] += drive * stretch * 24;
                break;
            }
            }
        }
    }

    _backgroundTarget() {
        const d = this._dock;
        const off = u => this._push * waveOffset(u, this._pointer, this._amplitude, this._range, this._profile);
        return [d.baseStart + off(d.baseStart), d.baseEnd + off(d.baseEnd)];
    }

    _tick() {
        const d = this._dock;
        if (!d.geometry)
            return;
        const now = GLib.get_monotonic_time();
        const dt = Math.min(64, Math.max(4, (now - this._lastTime) / 1000));
        this._lastTime = now;

        const smoothness = this._opt.smoothness;
        const factor = 1 - Math.pow(1 - smoothness, dt / REFERENCE_FRAME_MS);

        this._computeTargets();
        // Sem movimento novo, a velocidade (Gelatina) vai a zero aos poucos.
        this._velocity *= VELOCITY_DECAY;
        let moving = Math.abs(this._velocity) > 0.01 && this._style === 'jelly';

        const count = d.waveCount;
        for (const channel of CHANNELS) {
            const target = this._target[channel];
            const current = this._current[channel];
            const eps = EPSILON[channel];
            for (let i = 0; i < count; i++) {
                const diff = target[i] - current[i];
                if (Math.abs(diff) > eps) {
                    current[i] += diff * factor;
                    moving = true;
                } else {
                    current[i] = target[i];
                }
            }
        }

        // As pontas do fundo também são suavizadas.
        const [start, end] = this._backgroundTarget();
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

    /** Escreve os valores atuais nos atores (escala, translação, rotação). */
    _apply() {
        const d = this._dock;
        const g = d.geometry;
        if (!g || !this._current.scale)
            return;
        const c = this._current;
        const maxExtra = Math.max(0.001, g.maxScale - 1);
        const rise = this._opt.rise;
        for (const item of d.orderedItems) {
            const i = item.waveIndex;
            if (i === undefined || i >= this._capacity)
                continue;
            // Elevação suave, proporcional ao quanto o ícone está ampliado.
            const lift = rise * smoothstep(0, 1, (c.scale[i] - 1) / maxExtra);
            item.setWave(c.scale[i], c.offset[i], lift, c.cross[i], c.rotA[i], c.rotB[i]);
        }
        const start = this._bgStart ?? d.baseStart;
        const end = this._bgEnd ?? d.baseEnd;
        d.placeBackground(start, end);
        d.queueGlassRedraw();
    }
}
