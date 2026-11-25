// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/musicService.js — o "motor" do wavebar-music-pill, compartilhado por
// todas as docks (uma por monitor). Só existe com o widget LIGADO: o
// DockManager cria ao ligar e destrói ao desligar (e no disable()).
//
//   players   MprisManager (lib/music/mpris.js), por sinais do D-Bus
//   rede      uma Soup.Session criada só na primeira capa/letra da internet
//   caches    capas e letras (memória + ~/.cache/orla-dock/music/)
//
// Também tem o LyricsFollower: segue a linha da letra da faixa atual. A
// posição do MPRIS não avisa sozinha; então lemos a posição quando algo
// muda (faixa, play/pause, Seeked) e marcamos UM timer para a hora exata da
// próxima linha. Pausado, sem letra ou sem ninguém olhando: nenhum timer.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {lookupPlayerApp} from './appLookup.js';
import {isCancelled} from './cache.js';
import {CoverArtLoader} from './coverArt.js';
import {findLineIndex} from './lrc.js';
import {LyricsClient, LyricsNetworkError} from './lyrics.js';
import {MprisManager} from './mpris.js';
import {PlayerVolume} from './volume.js';

const KEY = 'wavebar-music-pill-';
const LYRICS_SETTLE_MS = 300;     // metadados chegam em partes: espera assentar
const LYRICS_LEAD_US = 200000;    // a linha aparece um pouco antes (parece mais natural)
const LENGTH_WAIT_MS = 2000;      // sem duração ainda: espera até 2 s por ela
const RESYNC_MS = 2500;           // tocando: relê a posição real a cada 2,5 s
const NETWORK_TIMEOUT_S = 8;

export class MusicService extends Signals.EventEmitter {
    /**
     * @param {Gio.Settings} settings
     * @param {string} version - para o User-Agent
     */
    constructor(settings, version) {
        super();
        this.settings = settings;
        this._version = version;
        this._session = null;
        this.covers = new CoverArtLoader(() => this._ensureSession());
        this.lyrics = new LyricsClient(() => this._ensureSession());
        this.manager = new MprisManager(lookupPlayerApp);
        this._visible = false;

        this.manager.connectObject(
            'changed', () => this._onChanged(),
            'seeked', () => this.emit('seeked'),
            this);
        settings.connectObject(
            `changed::${KEY}show-without-player`, () => this._onChanged(),
            // As preferências pedem "limpar cache de letras" mudando esta chave.
            `changed::${KEY}lyrics-cache-stamp`, () => {
                this.lyrics.clear().catch(() => {});
                this.emit('lyrics-cleared');
            },
            this);
        this.manager.start();
        this._visible = this._wantsVisible();
    }

    /** A sessão HTTP, criada só quando alguém precisa da internet. */
    _ensureSession() {
        this._session ??= new Soup.Session({
            user_agent: `OrlaDock/${this._version} (GNOME Shell extension; wavebar-music-pill; +https://github.com/bispov19/orla-dock)`,
            timeout: NETWORK_TIMEOUT_S,
            idle_timeout: 30,
        });
        return this._session;
    }

    get current() {
        return this.manager.current;
    }

    /**
     * Quem precisa da posição exata (letra, contorno, card aberto) se
     * registra aqui. Um ÚNICO timer, só enquanto alguém precisa e a música
     * toca, relê a posição real do player a cada 2,5 s; um salto em relação
     * à estimada vira 'seeked' (o Spotify não avisa quando você pula no app).
     */
    watchPosition(owner, on) {
        this._watchers ??= new Set();
        if (on)
            this._watchers.add(owner);
        else
            this._watchers.delete(owner);
        this._syncPositionTimer();
    }

    _syncPositionTimer() {
        const want = (this._watchers?.size ?? 0) > 0 && this.current?.status === 'Playing';
        if (want && !this._positionTimer) {
            this._positionTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESYNC_MS, () => {
                this.current?.refreshPosition().catch(() => {});
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._positionTimer) {
            GLib.source_remove(this._positionTimer);
            this._positionTimer = 0;
        }
    }

    /** O volume do player atual (o card usa). */
    get volume() {
        this._volume ??= new PlayerVolume(this);
        return this._volume;
    }

    get players() {
        return this.manager.players;
    }

    /** O widget aparece na dock? (há player, ou "mostrar mesmo sem player") */
    get visible() {
        return this._visible;
    }

    _wantsVisible() {
        return this.manager.players.length > 0 ||
            this.settings.get_boolean(`${KEY}show-without-player`);
    }

    _onChanged() {
        const visible = this._wantsVisible();
        // A dock também é avisada quando passa a haver (ou não) player.
        const hasPlayers = this.manager.players.length > 0;
        if (visible !== this._visible || hasPlayers !== this._hasPlayers) {
            this._visible = visible;
            this._hasPlayers = hasPlayers;
            this.emit('visibility-changed');
        }
        this._syncPositionTimer();
        this.emit('changed');
    }

    destroy() {
        // Quem ainda estiver ligado (pílulas saindo com animação, o card)
        // larga o serviço antes de ele sumir.
        this.emit('stopping');
        if (this._positionTimer)
            GLib.source_remove(this._positionTimer);
        this._positionTimer = 0;
        this._watchers?.clear();
        this._volume?.destroy();
        this._volume = null;
        this.settings.disconnectObject(this);
        this.manager.disconnectObject(this);
        this.manager.destroy();
        this.covers.destroy();
        this.lyrics.destroy();
        this._session?.abort();
        this._session = null;
    }
}

/**
 * Segue a letra da faixa atual e avisa a cada linha nova (o widget e o
 * card usam a MESMA lógica e a mesma fonte, então mostram sempre o mesmo).
 *
 * `onUpdate({kind, lines, index, text, status})`:
 *   kind   'loading' | 'synced' (lines + index) | 'plain' (text, sem
 *          tempos: não fingimos sincronia) | 'none'
 *   index  linha atual: a última cujo tempo ≤ posição + 200 ms (-1 = antes
 *          da primeira)
 *   status o PlaybackStatus do player ('Stopped' = limpar)
 *
 * A posição: lida do player (Position) quando algo muda e, enquanto toca,
 * relida a cada 2,5 s — o Spotify não avisa quando você pula no próprio
 * app; a diferença vira um "Seeked" (ver MprisPlayer.refreshPosition).
 * Entre as leituras, ela anda sozinha (estimada). Um timer só, marcado
 * para a hora exata da próxima linha.
 */
export class LyricsFollower {
    constructor(service, onUpdate) {
        this._service = service;
        this._onUpdate = onUpdate;
        this._active = false;
        this._trackKey = null;
        this._lines = null;
        this._text = '';
        this._kind = 'none';
        this._index = -2;
        this._timer = 0;
        this._settleId = 0;
        this._watching = false;
        this._cancellable = null;
        service.connectObject(
            'changed', () => this._sync(),
            'seeked', () => this._schedule(true),
            'lyrics-cleared', () => {
                this._trackKey = null;
                this._sync();
            },
            this);
    }

    /** Liga/desliga (ninguém mostrando a letra = nada roda, nem busca). */
    set active(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._trackKey = null;
            this._sync();
        } else {
            this._stopTimers();
            this._cancelFetch();
        }
    }

    get kind() {
        return this._kind;
    }

    get lines() {
        return this._lines;
    }

    get index() {
        return this._index;
    }

    _sync() {
        if (!this._active)
            return;
        const player = this._service.current;
        // Trocou a faixa OU o player (o busName faz parte da chave).
        const key = player?.metadata.title ? player.trackKey : null;
        if (key !== this._trackKey) {
            this._trackKey = key;
            this._load(player);
        }
        this._schedule(true);
    }

    _cancelFetch() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._settleId) {
            GLib.source_remove(this._settleId);
            this._settleId = 0;
        }
    }

    _set(kind, lines = null, text = '') {
        this._kind = kind;
        this._lines = lines;
        this._text = text;
        this._index = -2;
    }

    _load(player) {
        this._cancelFetch();
        this._stopTimers();
        // Faixa nova: a letra anterior some NA HORA (nunca a da música errada).
        this._set(player ? 'loading' : 'none');
        this._emit();
        if (!player)
            return;
        // Os players mandam os dados em partes (a duração às vezes chega
        // depois do título): esperamos assentar e, sem duração, um pouco
        // mais — é ela que escolhe a versão certa da música.
        let waited = 0;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LYRICS_SETTLE_MS, () => {
            waited += LYRICS_SETTLE_MS;
            const md = this._service.current?.metadata;
            if (!md?.title) {
                this._settleId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!md.length && waited < LENGTH_WAIT_MS)
                return GLib.SOURCE_CONTINUE;
            this._settleId = 0;
            this._fetch(md);
            return GLib.SOURCE_REMOVE;
        });
    }

    _fetch(md) {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._service.lyrics.fetch(md, cancellable).then(result => {
            if (cancellable.is_cancelled())
                return;
            if (result.kind === 'synced')
                this._set('synced', result.lines);
            else if (result.kind === 'plain' && result.text)
                this._set('plain', null, result.text);
            else
                this._set('none');
            this._emit();
            this._schedule(true);
        }).catch(e => {
            if (isCancelled(e) || cancellable.is_cancelled())
                return;
            // Sem rede ou servidor fora: nada aparece (e nenhum erro no log).
            if (!(e instanceof LyricsNetworkError))
                console.log(`[Orla Dock] Letra: ${e.message}`);
            this._set('none');
            this._emit();
        });
    }

    _emit() {
        this._onUpdate({
            kind: this._kind,
            lines: this._lines,
            index: this._index,
            text: this._text,
            status: this._service?.current?.status ?? 'Stopped',
        });
    }

    _stopTimers() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        this._syncResync(false);
    }

    /** Linha atual agora + timer para a próxima (só tocando). */
    _schedule(refresh = false) {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        const player = this._service?.current;
        if (!this._active || this._kind !== 'synced' || !player) {
            this._syncResync(false);
            if (refresh && this._active)
                this._emit();
            return;
        }
        const position = player.position + LYRICS_LEAD_US;
        const index = findLineIndex(this._lines, position);
        if (index !== this._index || refresh) {
            this._index = index;
            this._emit();
        }
        const playing = player.status === 'Playing';
        this._syncResync(playing);
        if (!playing)
            return;   // pausado: a linha congela
        const next = this._lines[index + 1];
        if (!next)
            return;
        const waitMs = Math.max(30, (next.time - position) / 1000 / (player.rate || 1));
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(waitMs), () => {
            this._timer = 0;
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Precisa da posição exata (letra sincronizada, ativa e tocando). */
    _syncResync(on) {
        if (on !== this._watching) {
            this._watching = on;
            this._service?.watchPosition(this, on);
        }
    }

    destroy() {
        this._stopTimers();
        this._cancelFetch();
        this._service?.disconnectObject(this);
        this._service = null;
        this._onUpdate = () => {};
    }
}
