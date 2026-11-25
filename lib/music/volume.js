// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/volume.js — o volume do player atual, mostrado no card do widget
// de música.
//
//   1. MPRIS: a propriedade Volume do org.mpris.MediaPlayer2.Player, quando
//      o player publica. Mudanças de fora chegam por PropertiesChanged
//      (o MprisPlayer avisa com 'changed').
//   2. Plano B: o volume do fluxo de áudio do app no PipeWire (via o Gvc,
//      a conexão de áudio que o próprio Shell já mantém; quais fluxos são
//      do app: appStreams.js). Mudanças de fora chegam por notify::volume.
//   3. Nenhum dos dois: indisponível (os controles ficam esmaecidos).
//
// Só trabalha enquanto alguém usa (acquire/release): com o card fechado,
// nada de procurar fluxos nem ouvir o áudio.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {describePlayer, pickStreams, readOwners} from './appStreams.js';
import {isCancelled} from './cache.js';

const UNMUTE_LEVEL = 0.25;      // desmutar com volume 0 volta a 25% (como o GNOME)
const REFRESH_DELAY_MS = 150;

export class PlayerVolume extends Signals.EventEmitter {
    constructor(service) {
        super();
        this._service = service;
        this._users = 0;
        this._player = null;
        this._streams = [];
        this._control = null;
        this._cancellable = null;
        this._refreshId = 0;
        this._beforeMute = new Map();   // busName → nível antes de silenciar (MPRIS)
        service.connectObject('changed', () => this._onPlayerChanged(), this);
    }

    /** Alguém passou a mostrar o volume. */
    acquire() {
        if (++this._users === 1)
            this._start();
    }

    release() {
        if (this._users === 0)
            return;
        if (--this._users === 0)
            this._stop();
    }

    get _mprisOk() {
        const p = this._player;
        return Boolean(p && p.volume !== null && p.canControl);
    }

    /** 'mpris' | 'stream' | 'none' */
    get mode() {
        if (this._mprisOk)
            return 'mpris';
        return this._streams.length ? 'stream' : 'none';
    }

    get available() {
        return this.mode !== 'none';
    }

    get muted() {
        if (this.mode === 'stream')
            return this._primary?.is_muted ?? false;
        return this.mode === 'mpris' && this._player.volume <= 0.001;
    }

    /** Nível mostrado, 0–1 (mudo = 0). */
    get level() {
        switch (this.mode) {
        case 'mpris':
            return Math.max(0, Math.min(1, this._player.volume));
        case 'stream': {
            const s = this._primary;
            return s && !s.is_muted ? Math.min(1, s.volume / this._maxNorm) : 0;
        }
        default:
            return 0;
        }
    }

    /** O usuário escolheu `level` (0–1). */
    set(level) {
        level = Math.max(0, Math.min(1, level));
        if (this.mode === 'mpris') {
            this._player.setVolume(level);
            this.emit('changed');
        } else if (this.mode === 'stream') {
            const volume = level * this._maxNorm;
            for (const stream of this._streams) {
                // Arrastou até o fim: zera e silencia (o ícone vira "mudo").
                const changed = stream.set_volume(volume < 1 ? 0 : volume);
                if (volume < 1 && !stream.is_muted)
                    stream.change_is_muted(true);
                else if (volume >= 1 && stream.is_muted)
                    stream.change_is_muted(false);
                if (changed)
                    stream.push_volume();
            }
        }
    }

    /** Silencia, ou volta ao volume de antes. */
    toggleMute() {
        if (this.mode === 'mpris') {
            const key = this._player.busName;
            if (this.muted) {
                this.set(this._beforeMute.get(key) ?? UNMUTE_LEVEL);
            } else {
                this._beforeMute.set(key, this.level);
                this.set(0);
            }
        } else if (this.mode === 'stream') {
            const muted = this.muted;
            for (const stream of this._streams) {
                if (muted && stream.volume === 0) {
                    stream.set_volume(UNMUTE_LEVEL * this._maxNorm);
                    stream.push_volume();
                }
                stream.change_is_muted(!muted);
            }
        }
    }

    // ---------- Fluxos de áudio (plano B) ----------

    get _maxNorm() {
        return this._control?.get_vol_max_norm() ?? 65536;
    }

    get _primary() {
        return this._streams.find(s => s.get_state() === Gvc.MixerStreamState.RUNNING) ?? this._streams[0] ?? null;
    }

    _start() {
        this._control = Volume.getMixerControl();
        // O mixer é do Shell (compartilhado): só conectamos e desconectamos.
        this._control.connectObject(
            'state-changed', () => this._queueRefresh(),
            'stream-added', () => this._queueRefresh(),
            'stream-removed', (_c, id) => {
                if (this._streams.some(s => s.get_id() === id))
                    this._setStreams(this._streams.filter(s => s.get_id() !== id));
                this._queueRefresh();
            }, this);
        this._player = null;
        this._onPlayerChanged();
    }

    _stop() {
        this._cancelRefresh();
        this._setStreams([]);
        this._control?.disconnectObject(this);
        this._control = null;
        this._player = null;
    }

    _onPlayerChanged() {
        if (!this._users)
            return;
        const player = this._service.current;
        if (player !== this._player) {
            this._player = player;
            this._setStreams([]);
            this._queueRefresh(0);
        }
        // Volume pelo MPRIS mudou (ou o player): avisa os controles.
        this.emit('changed');
    }

    _queueRefresh(delay = REFRESH_DELAY_MS) {
        if (!this._users || !this._player || this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._refreshId = 0;
            this._findStreams().catch(e => console.log(`[Orla Dock] Volume do app: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRefresh() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    async _findStreams() {
        const player = this._player;
        // Com volume pelo MPRIS não precisamos do áudio do app.
        if (!player || this._mprisOk || !this._control)
            return;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const ready = this._control.get_state() === Gvc.MixerControlState.READY;
        const inputs = ready ? this._control.get_sink_inputs().filter(s => !s.is_event_stream) : [];
        let owners = null;
        if (inputs.length) {
            try {
                owners = await readOwners(cancellable);
            } catch (e) {
                if (isCancelled(e) || cancellable.is_cancelled())
                    return;
                // Sem pactl: seguimos só com os nomes que o Gvc informa.
            }
        }
        if (cancellable.is_cancelled() || player !== this._player)
            return;
        const entries = inputs.map(stream => {
            const owner = owners?.get(stream.get_index());
            return {
                stream,
                pid: owner?.pid ?? 0,
                names: [...owner?.names ?? [], stream.get_application_id(), stream.get_icon_name()].filter(Boolean),
            };
        });
        const streams = await pickStreams(entries, describePlayer(player));
        if (!cancellable.is_cancelled() && player === this._player)
            this._setStreams(streams);
        this._cancellable = null;
    }

    _setStreams(streams) {
        const same = streams.length === this._streams.length && streams.every((s, i) => s === this._streams[i]);
        if (same)
            return;
        for (const s of this._streams)
            s.disconnectObject(this);
        this._streams = streams;
        for (const s of streams) {
            s.connectObject(
                'notify::volume', () => this.emit('changed'),
                'notify::is-muted', () => this.emit('changed'),
                this);
        }
        this.emit('changed');
    }

    destroy() {
        this._users = 0;
        this._stop();
        this._service?.disconnectObject(this);
        this._service = null;
    }
}
