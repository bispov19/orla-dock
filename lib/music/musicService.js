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
const LYRICS_LEAD_US = 150000;    // a linha aparece um pouco antes (atraso visual)
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

    /** O volume do player atual (card e canto da dock usam o mesmo). */
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
        // A dock também precisa saber quando passa a haver (ou não) player:
        // o volume no canto da dock depende disso.
        const hasPlayers = this.manager.players.length > 0;
        if (visible !== this._visible || hasPlayers !== this._hasPlayers) {
            this._visible = visible;
            this._hasPlayers = hasPlayers;
            this.emit('visibility-changed');
        }
        this.emit('changed');
    }

    destroy() {
        // Quem ainda estiver ligado (pílulas saindo com animação, o card)
        // larga o serviço antes de ele sumir.
        this.emit('stopping');
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
 * Segue a letra sincronizada da faixa atual e avisa a cada linha nova.
 * `onUpdate({kind, lines, index})`: kind = 'loading' | 'synced' | 'none'.
 */
export class LyricsFollower {
    constructor(service, onUpdate) {
        this._service = service;
        this._onUpdate = onUpdate;
        this._active = false;
        this._trackKey = null;
        this._lines = null;
        this._kind = 'none';
        this._index = -2;
        this._timer = 0;
        this._settleId = 0;
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

    /** Liga/desliga (ninguém mostrando a letra = nada roda). */
    set active(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._trackKey = null;
            this._sync();
        } else {
            this._stopTimer();
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

    _set(kind, lines) {
        this._kind = kind;
        this._lines = lines;
        this._index = -2;
    }

    _load(player) {
        this._cancelFetch();
        this._stopTimer();
        if (!player) {
            this._set('none', null);
            this._emit();
            return;
        }
        this._set('loading', null);
        this._emit();
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LYRICS_SETTLE_MS, () => {
            this._settleId = 0;
            const md = this._service.current?.metadata;
            if (!md?.title)
                return GLib.SOURCE_REMOVE;
            const cancellable = new Gio.Cancellable();
            this._cancellable = cancellable;
            this._service.lyrics.fetch(md, cancellable).then(result => {
                if (cancellable.is_cancelled())
                    return;
                // Só a sincronizada vale para "tempo real".
                if (result.kind === 'synced')
                    this._set('synced', result.lines);
                else
                    this._set('none', null);
                this._emit();
                this._schedule(true);
            }).catch(e => {
                if (isCancelled(e) || cancellable.is_cancelled())
                    return;
                // Sem rede ou servidor fora: nada aparece (e nada no log de erro).
                if (!(e instanceof LyricsNetworkError))
                    console.log(`[Orla Dock] Letra: ${e.message}`);
                this._set('none', null);
                this._emit();
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _emit() {
        this._onUpdate({kind: this._kind, lines: this._lines, index: this._index});
    }

    _stopTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    /** Linha atual agora + timer para a próxima (só tocando). */
    _schedule(refresh = false) {
        this._stopTimer();
        const player = this._service.current;
        if (!this._active || this._kind !== 'synced' || !player)
            return;
        const position = player.position + LYRICS_LEAD_US;
        const index = findLineIndex(this._lines, position);
        if (index !== this._index || refresh) {
            const changed = index !== this._index;
            this._index = index;
            if (changed || refresh)
                this._emit();
        }
        if (player.status !== 'Playing')
            return;
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

    destroy() {
        this._stopTimer();
        this._cancelFetch();
        this._service?.disconnectObject(this);
        this._service = null;
        this._onUpdate = () => {};
    }
}
