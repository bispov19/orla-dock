// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// music/card.js — o card do wavebar-music-pill, aberto com o botão direito:
//
//   ‹ [ícone] Spotify  1/2 ›                ⋯
//   ┌──────────────┐
//   │     capa     │
//   └──────────────┘
//   Título
//   Artista — Álbum
//   letra (linha atual em destaque)        ← com "Mostrar letra" ligada
//   ▂▅▇▅▃▂▅▇ onda de progresso (clicar pula)
//   0:42                              3:15
//        ⏮      ⏯      ⏭
//
// Abre acima da dock (ou ao lado, na dock lateral). Clicar fora, Esc ou o
// botão direito de novo fecham. Enquanto fechado, NADA dele roda: o timer
// do progresso só existe com o card aberto e a música tocando.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Position, Timeout} from '../utils.js';
import {isCancelled} from './cache.js';
import {splitArtistTitle} from './lrc.js';
import {LyricsFollower} from './musicService.js';
import {VolumeControl} from './volumeBar.js';
import {WaveformBar, formatTime} from './waveform.js';
import {coverColor, readableColor} from './coverColor.js';

const KEY = 'wavebar-music-pill-';
const TICK_MS = 250;
const GAP = 10;
const MARGIN = 12;
const OPEN_MS = 220;
const LYRICS_FADE_MS = 200;
const TITLE_WIDTH = 268;      // largura do título no card (280 − respiros), em px lógicos

function label(styleClass, lines = 1) {
    const l = new St.Label({style_class: styleClass, x_expand: true});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    if (lines > 1) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    }
    return l;
}

function button(iconName, styleClass, accessibleName) {
    return new St.Button({
        style_class: `wavebar-music-pill-button ${styleClass}`,
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName}),
    });
}

export class MusicCard {
    /**
     * @param {object} service - MusicService
     * @param {object} hooks
     * @param {Function} hooks.openPreferences
     */
    constructor(service, {openPreferences}) {
        this._service = service;
        this._settings = service.settings;
        this._openPreferences = openPreferences;
        this._isOpen = false;
        this._grab = null;
        this._owner = null;
        this._player = null;
        this._artUrl = null;
        this._coverCancellable = null;
        this._tick = 0;
        this._ticks = 0;
        this._closeLater = new Timeout();

        this._overlay = new St.Widget({reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        Main.layoutManager.addTopChrome(this._overlay);
        this._overlay.connect('button-press-event', (_a, event) => this._onOutsidePress(event));
        this._overlay.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (this._menu)
                this._hideMenu();
            else
                this.close();
            return Clutter.EVENT_STOP;
        });

        this._card = new St.BoxLayout({
            style_class: 'wavebar-music-pill-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._overlay.add_child(this._card);
        this._build();
        // O conteúdo mudou de altura com o card aberto: reposiciona com
        // suavidade (uma vez por quadro, juntando as mudanças).
        this._replace = new Timeout();
        this._card.connect('notify::height', () => {
            if (this._isOpen)
                this._replace.start(0, () => this._place(true));
        });

        this._lyrics = new LyricsFollower(service, update => this._showLyrics(update));
        service.connectObject(
            'changed', () => this._sync(),
            'seeked', () => this._updateProgress(),
            'stopping', () => this.destroy(),
            this);
        this._settings.connectObject(
            `changed::${KEY}lyrics`, () => this._sync(),
            this);
        Main.overview.connectObject('showing', () => this.close(), this);
        Main.sessionMode.connectObject('updated', () => this.close(), this);
    }

    get isOpen() {
        return this._isOpen;
    }

    get owner() {
        return this._isOpen ? this._owner : null;
    }

    // ---------- Montagem ----------

    _build() {
        // Linha de cima: troca de player e o menu "⋯".
        const top = new St.BoxLayout({style_class: 'wavebar-music-pill-card-top'});
        this._prevPlayer = button('go-previous-symbolic', 'wavebar-music-pill-small', _('Previous player'));
        this._prevPlayer.connect('clicked', () => this._service.manager.cyclePlayer(-1));
        this._appIcon = new St.Icon({style_class: 'wavebar-music-pill-app-icon', fallback_icon_name: 'multimedia-player-symbolic'});
        this._appName = label('wavebar-music-pill-app-name');
        const appBox = new St.BoxLayout({style_class: 'wavebar-music-pill-app-box'});
        appBox.add_child(this._appIcon);
        appBox.add_child(this._appName);
        this._appButton = new St.Button({style_class: 'wavebar-music-pill-app-button', can_focus: true, child: appBox,
            x_expand: true, x_align: Clutter.ActorAlign.START});
        this._appButton.connect('clicked', () => {
            this._player?.raise();
            this.close();
        });
        this._count = new St.Label({style_class: 'wavebar-music-pill-count', y_align: Clutter.ActorAlign.CENTER});
        this._nextPlayer = button('go-next-symbolic', 'wavebar-music-pill-small', _('Next player'));
        this._nextPlayer.connect('clicked', () => this._service.manager.cyclePlayer(1));
        this._more = button('view-more-horizontal-symbolic', 'wavebar-music-pill-small', _('More options'));
        this._more.connect('clicked', () => this._toggleMenu());
        top.add_child(this._prevPlayer);
        top.add_child(this._appButton);
        top.add_child(this._count);
        top.add_child(this._nextPlayer);
        top.add_child(this._more);
        this._card.add_child(top);

        this._cover = new St.Bin({
            style_class: 'wavebar-music-pill-card-cover wavebar-music-pill-no-cover',
            x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({style_class: 'wavebar-music-pill-card-placeholder', icon_name: 'audio-x-generic-symbolic',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
        });
        // Por cima da capa, a capa ANTERIOR, que some aos poucos (crossfade).
        this._coverOld = new St.Bin({style_class: 'wavebar-music-pill-card-cover', visible: false,
            x_align: Clutter.ActorAlign.CENTER});
        const coverBox = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        coverBox.add_child(this._cover);
        coverBox.add_child(this._coverOld);
        this._card.add_child(coverBox);

        const info = new St.BoxLayout({style_class: 'wavebar-music-pill-card-info', orientation: Clutter.Orientation.VERTICAL});
        this._title = label('wavebar-music-pill-card-title', 2);
        this._artist = label('wavebar-music-pill-card-artist');
        info.add_child(this._title);
        info.add_child(this._artist);
        this._info = info;
        this._card.add_child(info);

        // Letra: as linhas numa rolagem curta, a atual em destaque.
        this._lyricsBox = new St.BoxLayout({style_class: 'wavebar-music-pill-card-lyrics-box',
            orientation: Clutter.Orientation.VERTICAL});
        this._lyricsView = new St.ScrollView({
            style_class: 'wavebar-music-pill-card-lyrics',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false,
            child: this._lyricsBox,
            x_expand: true, y_expand: true,
            opacity: 0,
        });
        // Área de altura FIXA (CSS): a mensagem ("Carregando letra…") e a
        // letra ficam uma sobre a outra e só a opacidade muda. A letra
        // chegando, faltando ou trocando nunca muda o tamanho do card (ele
        // não precisa se reposicionar depois de aberto).
        this._lyricsStatus = new St.Label({style_class: 'wavebar-music-pill-card-lyrics-status',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, opacity: 0});
        this._lyricsArea = new St.Widget({
            style_class: 'wavebar-music-pill-card-lyrics-area',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
        });
        this._lyricsArea.add_child(this._lyricsView);
        this._lyricsArea.add_child(this._lyricsStatus);
        this._card.add_child(this._lyricsArea);
        this._pendingLyrics = null;
        this._lyricLabels = [];
        this._lyricLines = null;
        this._activeLine = -1;

        const progress = new St.BoxLayout({style_class: 'wavebar-music-pill-card-progress', orientation: Clutter.Orientation.VERTICAL});
        this._wave = new WaveformBar();
        this._wave.connect('scrub', (_w, fraction) => {
            this._elapsed.text = formatTime(fraction * (this._player?.metadata.length ?? 0));
        });
        this._wave.connect('seek', (_w, fraction) => {
            if (!this._player)
                return;
            this._player.setPosition(fraction * this._player.metadata.length);
            this._updateProgress();
        });
        const times = new St.BoxLayout({style_class: 'wavebar-music-pill-card-times'});
        this._elapsed = new St.Label({style_class: 'wavebar-music-pill-time', text: '0:00'});
        this._total = new St.Label({style_class: 'wavebar-music-pill-time', text: '0:00', x_expand: true,
            x_align: Clutter.ActorAlign.END});
        times.add_child(this._elapsed);
        times.add_child(this._total);
        progress.add_child(this._wave);
        progress.add_child(times);
        this._card.add_child(progress);

        const controls = new St.BoxLayout({style_class: 'wavebar-music-pill-card-controls', x_align: Clutter.ActorAlign.CENTER});
        this._prev = button('media-skip-backward-symbolic', 'wavebar-music-pill-control', _('Previous track'));
        this._prev.connect('clicked', () => this._player?.previous());
        this._play = button('media-playback-start-symbolic', 'wavebar-music-pill-control wavebar-music-pill-play', _('Play or pause'));
        this._play.connect('clicked', () => this._player?.playPause());
        this._next = button('media-skip-forward-symbolic', 'wavebar-music-pill-control', _('Next track'));
        this._next.connect('clicked', () => this._player?.next());
        // Aleatório e repetir, simétricos em volta dos controles principais.
        this._shuffle = button('media-playlist-shuffle-symbolic', 'wavebar-music-pill-control wavebar-music-pill-toggle',
            _('Shuffle'));
        this._shuffle.connect('clicked', () => this._player?.toggleShuffle());
        this._repeat = button('media-playlist-repeat-symbolic', 'wavebar-music-pill-control wavebar-music-pill-toggle',
            _('Repeat'));
        this._repeat.connect('clicked', () => this._player?.cycleLoopStatus());
        controls.add_child(this._shuffle);
        controls.add_child(this._prev);
        controls.add_child(this._play);
        controls.add_child(this._next);
        controls.add_child(this._repeat);
        this._card.add_child(controls);

        // Volume do player (só aqui, no card).
        this._volume = new VolumeControl(this._service.volume);
        this._volume.add_style_class_name('wavebar-music-pill-card-volume');
        this._card.add_child(this._volume);
        this._volumeHeld = false;
    }

    /** Liga o modelo de volume só com o card aberto. */
    _syncVolume() {
        const want = this._isOpen;
        if (want && !this._volumeHeld) {
            this._service.volume.acquire();
            this._volumeHeld = true;
            this._volume.sync();
        } else if (!want && this._volumeHeld) {
            this._service.volume.release();
            this._volumeHeld = false;
        }
    }

    /** Liga/desliga: ":checked" = ícone na cor de destaque. */
    _setToggle(button, supported, on, label) {
        this._setEnabled(button, supported);
        button.accessible_name = label;
        if (supported && on)
            button.add_style_pseudo_class('checked');
        else
            button.remove_style_pseudo_class('checked');
    }

    // ---------- Abrir e fechar ----------

    /** Abre junto do item `owner` (a pílula de uma dock); de novo, fecha. */
    toggle(owner) {
        if (this._isOpen)
            this.close();
        else
            this.open(owner);
    }

    open(owner) {
        if (this._isOpen || !this._service)
            return;
        this._owner = owner;
        this._isOpen = true;
        const dock = owner.dock;
        const monitor = dock.monitor;
        const dark = dock.look?.dark !== false;
        this._card.remove_style_class_name(dark ? 'wavebar-music-pill-light' : 'wavebar-music-pill-dark');
        this._card.add_style_class_name(dark ? 'wavebar-music-pill-dark' : 'wavebar-music-pill-light');

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._artUrl = null;
        this._activeLine = -2;
        this._lyrics.active = this._settings.get_boolean(`${KEY}lyrics`);
        this._volume.setColor(this._color ?? this._accent(dark), dark);
        this._sync();
        this._syncVolume();
        this._overlay.show();
        this._place();
        this._grab = Main.pushModal(this._overlay);
        this._play.grab_key_focus();

        this._animateIn(dock);
        dock.autohide?.sync();
    }

    /**
     * Entrada: opacidade 0 → 255 e 12 px desde a dock, 220 ms. A animação só
     * começa DEPOIS do primeiro quadro com o card montado (invisível): o
     * trabalho de montar e posicionar não "come" o começo dela — antes,
     * o primeiro quadro visível já saía no meio do caminho (o salto).
     * Reabrindo no meio do fechamento, continua de onde está.
     */
    _animateIn(dock) {
        const card = this._card;
        const resuming = this._closingCard;
        this._closingCard = false;
        card.remove_all_transitions();
        this._cancelFirstFrame();
        this._opening = true;
        const finished = () => {
            this._opening = false;
            if (this._pendingLyrics)
                this._showLyrics(this._pendingLyrics);
            this._updateTimer();
            // A posição pode ter mudado com o card fechado.
            this._player?.refreshPosition().then(() => this._updateProgress()).catch(() => {});
        };
        if (!St.Settings.get().enable_animations) {
            card.set({opacity: 255, translation_x: 0, translation_y: 0});
            finished();
            return;
        }
        if (!resuming) {
            const [tx, ty] = this._slide(dock.axis.position);
            card.set({opacity: 0, translation_x: tx, translation_y: ty});
        }
        const start = () => card.ease({
            opacity: 255, translation_x: 0, translation_y: 0, duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: finished,
        });
        if (resuming) {
            start();
            return;
        }
        this._firstFrameId = global.stage.connect('after-paint', () => {
            this._cancelFirstFrame();
            if (this._isOpen)
                start();
        });
    }

    _cancelFirstFrame() {
        if (this._firstFrameId) {
            global.stage.disconnect(this._firstFrameId);
            this._firstFrameId = 0;
        }
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._hideMenu();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._lyrics.active = false;
        this._opening = false;
        this._cancelFirstFrame();
        this._closingCard = true;
        this._updateTimer();
        this._syncVolume();
        this._coverCancellable?.cancel();
        const dock = this._owner?.dock;
        this._card.remove_all_transitions();
        if (St.Settings.get().enable_animations && dock) {
            // O caminho de volta é o mesmo da ida (mesma distância e duração).
            const [tx, ty] = this._slide(dock.axis.position);
            this._card.ease({opacity: 0, translation_x: tx, translation_y: ty, duration: OPEN_MS,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onStopped: finished => {
                    if (finished && !this._isOpen) {
                        this._closingCard = false;
                        this._overlay.hide();
                    }
                }});
        } else {
            this._closingCard = false;
            this._overlay.hide();
        }
        if (dock && !dock.destroyed)
            dock.autohide?.sync();
        // O widget pode voltar ao normal (ele ficou como estava com o card aberto).
        const owner = this._owner;
        if (owner && !owner.dock?.destroyed)
            owner.cardClosed?.();
    }

    _slide(position) {
        const d = 12;
        return [[0, d], [0, -d], [-d, 0], [d, 0]][position] ?? [0, d];
    }

    /**
     * Acima do widget (dock embaixo), abaixo (em cima) ou ao lado (laterais),
     * ANCORADO pela borda voltada para a dock: se o card crescer depois de
     * aberto (a letra chegou, o título ocupou duas linhas), ele cresce para
     * longe da dock — nunca para trás dela. Sempre inteiro na área livre da
     * tela (sem passar por baixo do painel do GNOME).
     */
    _place(animate = false) {
        const owner = this._owner;
        if (!owner || owner.dock.destroyed)
            return;
        const dock = owner.dock;
        const monitor = dock.monitor;
        const [, , prefW, prefH] = this._card.get_preferred_size();
        const w = this._card.width || prefW;
        const h = Math.max(this._card.height, prefH);
        const [ix, iy] = owner.get_transformed_position();
        const [iw, ih] = owner.get_transformed_size();
        const [bx, by] = dock.backgroundActor.get_transformed_position();
        const [bw, bh] = dock.backgroundActor.get_transformed_size();
        // O centro do widget sem o deslocamento da onda de ampliação.
        const cx = ix - owner.translation_x + iw / 2;
        const cy = iy - owner.translation_y + ih / 2;
        let x, y;
        switch (dock.axis.position) {
        case Position.TOP:
            x = cx - w / 2;
            y = by + bh + GAP;
            break;
        case Position.LEFT:
            x = bx + bw + GAP;
            y = cy - h / 2;
            break;
        case Position.RIGHT:
            x = bx - GAP - w;
            y = cy - h / 2;
            break;
        default:
            x = cx - w / 2;
            y = by - GAP - h;
        }
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const top = Math.max(monitor.y, area.y) + MARGIN;
        x = Math.max(monitor.x + MARGIN, Math.min(x, monitor.x + monitor.width - w - MARGIN));
        y = Math.max(top, Math.min(y, monitor.y + monitor.height - h - MARGIN));
        const nx = Math.round(x - monitor.x);
        const ny = Math.round(y - monitor.y);
        if (nx === this._card.x && ny === this._card.y)
            return;
        if (animate && this._card.mapped && St.Settings.get().enable_animations)
            this._card.ease({x: nx, y: ny, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this._card.set_position(nx, ny);
    }

    _onOutsidePress(event) {
        const [x, y] = event.get_coords();
        if (this._menu) {
            const [mx, my] = this._menu.get_transformed_position();
            if (x >= mx && x <= mx + this._menu.width && y >= my && y <= my + this._menu.height)
                return Clutter.EVENT_PROPAGATE;
            this._hideMenu();
        }
        const [cx, cy] = this._card.get_transformed_position();
        const inside = x >= cx && x <= cx + this._card.width && y >= cy && y <= cy + this._card.height;
        // Dentro do card, o clique segue para o botão (no GNOME 51 os botões
        // reconhecem o clique por gestos, e parar o evento aqui os calaria).
        if (inside)
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    // ---------- Menu "⋯" ----------

    _toggleMenu() {
        if (this._menu) {
            this._hideMenu();
            return;
        }
        const expanded = this._settings.get_string(`${KEY}mode`) === 'expanded';
        const items = [
            [expanded ? _('Compact mode') : _('Expanded mode'), () =>
                this._settings.set_string(`${KEY}mode`, expanded ? 'compact' : 'expanded')],
            [_('Disable music widget'), () => {
                this.close();
                this._settings.set_boolean(`${KEY}enabled`, false);
            }],
            [_('Settings'), () => {
                this.close();
                this._openPreferences();
            }],
        ];
        const menu = new St.BoxLayout({style_class: 'wavebar-music-pill-menu', orientation: Clutter.Orientation.VERTICAL,
            reactive: true});
        menu.add_style_class_name(this._card.has_style_class_name('wavebar-music-pill-light')
            ? 'wavebar-music-pill-light' : 'wavebar-music-pill-dark');
        for (const [text, run] of items) {
            const item = new St.Button({style_class: 'wavebar-music-pill-menu-item', can_focus: true,
                child: new St.Label({text, x_align: Clutter.ActorAlign.START})});
            item.connect('clicked', () => {
                this._hideMenu();
                run();
            });
            menu.add_child(item);
        }
        this._overlay.add_child(menu);
        const [, , w] = menu.get_preferred_size();
        const [ox, oy] = this._overlay.get_transformed_position();
        const [bx, by] = this._more.get_transformed_position();
        menu.set_position(Math.round(Math.min(bx + this._more.width - w, ox + this._overlay.width - w - MARGIN) - ox),
            Math.round(by + this._more.height + 4 - oy));
        this._menu = menu;
        menu.get_first_child()?.grab_key_focus();
    }

    _hideMenu() {
        this._menu?.destroy();
        this._menu = null;
    }

    // ---------- Conteúdo ----------

    _sync() {
        if (!this._isOpen)
            return;
        const player = this._service.current;
        if (!player) {
            // O último player fechou com o card aberto.
            this._player = null;
            this.close();
            return;
        }
        this._player = player;
        const players = this._service.players;
        const several = players.length > 1;
        this._prevPlayer.visible = this._nextPlayer.visible = this._count.visible = several;
        this._count.text = `${players.indexOf(player) + 1}/${players.length}`;
        this._appIcon.gicon = player.app?.get_icon() ?? null;
        this._appName.text = player.displayName;

        const md = player.metadata;
        const shown = splitArtistTitle(md.title, md.artists.join(', '));
        const title = shown.title || md.title || _('Unknown title');
        if (title !== this._fullTitle) {
            this._fullTitle = title;
            this._fitTitle(title);
        }
        this._artist.text = [shown.artist, md.album].filter(Boolean).join(' — ') || _('Unknown artist');
        if (md.artUrl !== this._artUrl) {
            this._artUrl = md.artUrl;
            this._loadCover(md.artUrl);
        }
        this._wave.setSeed(`${md.title}|${md.artists.join(',')}`);
        this._wave.setSeekable(player.canSeek && md.length > 0);

        const playing = player.status === 'Playing';
        this._play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._setEnabled(this._play, playing ? player.canPause : player.canPlay);
        this._setEnabled(this._prev, player.canGoPrevious);
        this._setEnabled(this._next, player.canGoNext);
        this._setToggle(this._shuffle, player.canShuffle, player.shuffle,
            player.shuffle ? _('Shuffle: on') : _('Shuffle: off'));
        const loop = player.loopStatus ?? 'None';
        this._repeat.child.icon_name = loop === 'Track' ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._setToggle(this._repeat, player.canLoop, loop !== 'None',
            {None: _('Repeat: off'), Playlist: _('Repeat: playlist'), Track: _('Repeat: this song')}[loop]);
        this._lyrics.active = this._isOpen && this._settings.get_boolean(`${KEY}lyrics`);
        this._lyricsArea.visible = this._settings.get_boolean(`${KEY}lyrics`);
        this._updateProgress();
        this._updateTimer();
    }

    _setEnabled(actor, enabled) {
        actor.reactive = enabled;
        actor.can_focus = enabled;
        if (enabled)
            actor.remove_style_pseudo_class('insensitive');
        else
            actor.add_style_pseudo_class('insensitive');
    }

    _updateProgress() {
        const player = this._player;
        if (!this._isOpen || !player)
            return;
        const length = player.metadata.length;
        const position = player.position;
        this._total.text = length > 0 ? formatTime(length) : '--:--';
        if (!this._wave.isDragging) {
            this._elapsed.text = formatTime(position);
            this._wave.setProgress(length > 0 ? position / length : 0);
        }
    }

    _updateTimer() {
        const needed = this._isOpen && !this._opening && this._player?.status === 'Playing';
        // A posição exata (um timer só, no serviço) enquanto o card está aberto.
        this._service?.watchPosition(this, this._isOpen);
        if (needed && !this._tick) {
            this._ticks = 0;
            this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._updateProgress();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed && this._tick) {
            GLib.source_remove(this._tick);
            this._tick = 0;
        }
    }

    /** Troca de camada (mensagem ↔ letra) só pela opacidade, ~200 ms. */
    _fadeLayer(actor, shown) {
        const opacity = shown ? 255 : 0;
        if (this._isOpen && !this._opening && this._card.mapped && St.Settings.get().enable_animations) {
            actor.ease({opacity, duration: LYRICS_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            actor.remove_transition('opacity');
            actor.opacity = opacity;
        }
    }

    _showLyrics(update) {
        if (!this._isOpen)
            return;
        // Durante a animação de abertura nada muda: aplica quando ela acabar.
        if (this._opening && update.kind !== 'loading') {
            this._pendingLyrics = update;
            return;
        }
        this._pendingLyrics = null;
        const {kind, lines, index, text} = update;
        const on = this._settings.get_boolean(`${KEY}lyrics`);
        this._lyricsArea.visible = on;
        if (!on)
            return;
        const message = {loading: _('Loading lyrics…'), none: _('No lyrics for this song')}[kind] ?? null;
        if (message)
            this._lyricsStatus.text = message;
        this._fadeLayer(this._lyricsStatus, Boolean(message));
        // Sem tempos: o texto parado (não fingimos sincronia).
        if (kind === 'plain' && text) {
            this._fadeLayer(this._lyricsView, true);
            if (this._plainText !== text) {
                this._plainText = text;
                this._lyricLines = null;
                this._lyricLabels = [];
                this._lyricsBox.destroy_all_children();
                const l = new St.Label({style_class: 'wavebar-music-pill-card-lyric wavebar-music-pill-plain', text});
                l.clutter_text.line_wrap = true;
                l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                this._lyricsBox.add_child(l);
                this._lyricsView.vadjustment.value = 0;
            }
            return;
        }
        this._plainText = null;
        const show = kind === 'synced';
        this._fadeLayer(this._lyricsView, show);
        if (!show) {
            this._lyricLines = null;
            return;
        }
        if (lines !== this._lyricLines) {
            this._lyricLines = lines;
            this._lyricsBox.destroy_all_children();
            this._lyricLabels = lines.map(line => {
                const l = new St.Label({style_class: 'wavebar-music-pill-card-lyric', text: line.text || '♪'});
                l.clutter_text.line_wrap = true;
                l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                this._lyricsBox.add_child(l);
                return l;
            });
            this._activeLine = -2;
        }
        if (index === this._activeLine)
            return;
        this._lyricLabels[this._activeLine]?.remove_style_class_name('wavebar-music-pill-active');
        this._activeLine = index;
        const current = this._lyricLabels[index];
        current?.add_style_class_name('wavebar-music-pill-active');
        // Centraliza a linha atual depois do layout.
        this._closeLater.start(0, () => {
            const adj = this._lyricsView.vadjustment;
            let target = 0;
            if (current?.get_stage()) {
                const box = current.get_allocation_box();
                target = (box.y1 + box.y2) / 2 - adj.page_size / 2;
            }
            target = Math.max(adj.lower, Math.min(target, adj.upper - adj.page_size));
            if (St.Settings.get().enable_animations)
                adj.ease(target, {duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                adj.value = target;
        });
    }

    async _loadCover(url) {
        this._coverCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._coverCancellable = cancellable;
        // A capa antiga fica até a nova chegar (e aí as duas se cruzam):
        // nada de piscar o ícone genérico no meio.
        if (!url) {
            this._setCover(null);
            return;
        }
        let path = null;
        try {
            path = await this._service.covers.load(url, cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        if (cancellable.is_cancelled() || !this._service)
            return;
        this._setCover(path);
        // A barra de volume na cor da música (ou na de destaque, sem capa).
        let color = null;
        if (path && this._settings.get_boolean(`${KEY}dynamic-color`)) {
            try {
                color = await coverColor(path, cancellable);
            } catch (e) {
                if (isCancelled(e))
                    return;
            }
        }
        if (cancellable.is_cancelled() || !this._service)
            return;
        const dark = this._card.has_style_class_name('wavebar-music-pill-dark');
        this._color = color ? readableColor(color, dark) : null;
        this._volume.setColor(this._color ?? this._accent(dark), dark);
    }

    /** A cor de destaque do sistema, legível sobre o card. */
    _accent(dark) {
        const accent = St.ThemeContext.get_for_stage(global.stage).get_accent_color?.()?.[0];
        const rgb = accent ? [accent.red / 255, accent.green / 255, accent.blue / 255] : [0.21, 0.52, 0.89];
        return readableColor(rgb, dark);
    }

    /**
     * O título em até 2 linhas: se não couber, é cortado (com "…") no
     * ponto exato em que cabe, medindo o texto de verdade.
     */
    _fitTitle(full) {
        const label = this._title;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Largura fixa (o card tem largura fixa): a do rótulo pode estar
        // desatualizada com o card fechado.
        const width = TITLE_WIDTH * scale;
        label.text = 'Ág';
        const [, one] = label.get_preferred_height(width);
        // O bloco título + artista tem sempre a altura de 2 linhas de título
        // + o artista: título de 1 ou 2 linhas, o card não muda de tamanho.
        const [, artist] = this._artist.get_preferred_height(width);
        const node = this._info.get_theme_node();
        this._info.height = Math.ceil(one * 2 + Math.max(artist, one * 0.8) + node.get_length('spacing') +
            node.get_padding(St.Side.TOP) + node.get_padding(St.Side.BOTTOM));
        const fits = t => {
            label.text = t;
            return label.get_preferred_height(width)[1] <= one * 2 + 1;
        };
        if (fits(full))
            return;
        let lo = 0, hi = full.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (fits(`${full.slice(0, mid).trimEnd()}…`))
                lo = mid;
            else
                hi = mid - 1;
        }
        label.text = `${full.slice(0, lo).trimEnd()}…`;
    }

    _setCover(path) {
        // Crossfade: a capa anterior fica por cima e some aos poucos.
        if (this._card.mapped && St.Settings.get().enable_animations && this._coverShown !== path) {
            const old = this._coverOld;
            old.remove_all_transitions();
            old.style = this._cover.style;
            old.style_class = this._cover.style_class;
            old.set_child(this._cover.child.visible
                ? new St.Icon({style_class: 'wavebar-music-pill-card-placeholder', icon_name: 'audio-x-generic-symbolic',
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})
                : null);
            old.opacity = 255;
            old.show();
            old.ease({opacity: 0, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onStopped: () => old.hide()});
        }
        this._coverShown = path;
        if (path) {
            this._cover.style = `background-image: url("${GLib.filename_to_uri(path, null)}");`;
            this._cover.remove_style_class_name('wavebar-music-pill-no-cover');
            this._cover.child.visible = false;
        } else {
            this._cover.style = null;
            this._cover.add_style_class_name('wavebar-music-pill-no-cover');
            this._cover.child.visible = true;
        }
    }

    destroy() {
        if (!this._service)
            return;
        this.close();
        this._updateTimer();
        this._closeLater.cancel();
        this._replace.cancel();
        this._cancelFirstFrame();
        this._coverCancellable?.cancel();
        this._lyrics.destroy();
        if (this._volumeHeld)
            this._service.volume.release();
        this._volumeHeld = false;
        this._lyricsView.vadjustment.remove_transition('value');
        this._service.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._overlay.destroy();
        this._service = null;
        this._player = null;
        this._owner = null;
    }
}
