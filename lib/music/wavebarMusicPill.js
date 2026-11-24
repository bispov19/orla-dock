// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// music/wavebarMusicPill.js — o widget de música DENTRO da dock, entre o
// botão de aplicativos e os apps fixados (Arquivos). Visual e comportamento
// da extensão Wavebar, implementados aqui sem depender dela.
//
//   compacto    do tamanho de um ícone: a capa arredondada com as barrinhas
//               animadas num selo no canto (ou a nota musical, sem capa);
//   expandido   uma pílula mais larga: capa, "Título · Artista" (rolando se
//               não couber, com as bordas esmaecidas), a linha atual da
//               letra (opção) e as barrinhas ou os botões de controle.
//
// É um item da dock como os outros (lib/dockItem.js): a dock reserva o
// comprimento que ele pede (cellLength). Expandir = animar esse
// comprimento a cada quadro e pedir à dock para reposicionar os itens —
// os vizinhos deslizam junto, sem pulos.
//
// Cliques: esquerdo não faz nada; direito abre o card (lib/music/card.js);
// do meio, tocar/pausar; rodinha, volume do player.
//
// Na dock lateral não há espaço para texto: o "expandido" vira a coluna
// capa + botões (se os botões estiverem ligados).

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DockItem} from '../dockItem.js';
import {Timeout} from '../utils.js';
import {isCancelled} from './cache.js';
import {splitArtistTitle} from './lrc.js';
import {LyricsFollower} from './musicService.js';

const KEY = 'wavebar-music-pill-';
const EXPAND_MS = 280;
const PAUSED_OPACITY = 150;
const LEAVE_DELAY_MS = 260;       // tirar o mouse: espera antes de encolher
const LINE_FADE_MS = 160;
const VOLUME_STEP = 0.05;

// Barrinhas (as mesmas da Wavebar).
const BAR_COUNT = 3;
const STATIC_LEVELS = [0.45, 0.85, 0.6];
const MIN_REPAINT_US = 33000;      // ~30 quadros/s bastam para 3 barrinhas
const RAMP_MS = 300;

// Rolagem do título: pausa, vai devagar, pausa, volta mais rápido.
const MARQUEE_SPEED = 28;
const MARQUEE_RETURN_SPEED = 110;
const MARQUEE_START_PAUSE_MS = 2200;
const MARQUEE_END_PAUSE_MS = 1500;

/**
 * As três barrinhas. A Timeline presa ao ator anda no ritmo da tela e
 * para sozinha com o ator fora da tela; pausado, ela para assim que as
 * barras assentam.
 */
const Equalizer = GObject.registerClass(
class OrlaMusicEqualizer extends St.DrawingArea {
    _init(params = {}) {
        super._init({style_class: 'wavebar-music-pill-eq', y_align: Clutter.ActorAlign.CENTER, ...params});
        this._playing = false;
        this._amplitude = 0;
        this._lastFrame = 0;
        this._lastRepaint = 0;
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._onFrame());
        // Só anima na tela; ao aparecer, retoma se estiver tocando.
        this.connect('notify::mapped', () => this._start());
        this.connect('destroy', () => {
            this._timeline.stop();
            this._timeline = null;
        });
    }

    set playing(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        if (!St.Settings.get().enable_animations) {
            this._amplitude = 0;
            this.queue_repaint();
            return;
        }
        this._start();
    }

    _start() {
        if (!this._playing || !this.mapped || !this._timeline || this._timeline.is_playing() ||
            !St.Settings.get().enable_animations)
            return;
        this._lastFrame = GLib.get_monotonic_time();
        this._timeline.start();
    }

    _onFrame() {
        const now = GLib.get_monotonic_time();
        const step = (now - this._lastFrame) / 1000 / RAMP_MS;
        this._lastFrame = now;
        this._amplitude = this._playing ? Math.min(1, this._amplitude + step) : Math.max(0, this._amplitude - step);
        if (!this._playing && this._amplitude === 0) {
            this._timeline.stop();
            this.queue_repaint();
            return;
        }
        if (now - this._lastRepaint < MIN_REPAINT_US)
            return;
        this._lastRepaint = now;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const color = this.get_theme_node().get_foreground_color();
            const seconds = GLib.get_monotonic_time() / 1e6;
            const barWidth = width / (BAR_COUNT * 2 - 1);
            const radius = barWidth / 2;
            cr.setSourceColor(color);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(barWidth);
            for (let i = 0; i < BAR_COUNT; i++) {
                const a = Math.sin(seconds * (5.3 + i * 1.7) + i * 1.3);
                const b = Math.sin(seconds * (2.9 + i * 0.8) + i * 2.1);
                const live = 0.25 + 0.75 * Math.abs(a * 0.6 + b * 0.4);
                const level = STATIC_LEVELS[i] * (1 - this._amplitude) + live * this._amplitude;
                const barHeight = Math.max(barWidth, level * height);
                const x = radius + i * barWidth * 2;
                cr.moveTo(x, (height - barHeight) / 2 + radius);
                cr.lineTo(x, (height + barHeight) / 2 - radius);
                cr.stroke();
            }
        } finally {
            cr.$dispose();
        }
    }
});

function smallButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'wavebar-music-pill-ctl',
        can_focus: false,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName}),
    });
}

export const WavebarMusicPill = GObject.registerClass(
class OrlaWavebarMusicPill extends DockItem {
    /**
     * @param {object} dock
     * @param {object} service - MusicService (lib/music/musicService.js)
     */
    _init(dock, service) {
        // Só o botão do meio "clica" (tocar/pausar): o esquerdo não faz nada.
        super._init(dock, {button_mask: St.ButtonMask.MIDDLE});
        this.add_style_class_name('wavebar-music-pill-item');
        this._service = service;
        this._settings = service.settings;
        this._extra = 0;                 // comprimento além de um ícone (px)
        this._extraFrom = 0;
        this._extraTo = 0;
        this._state = 'compact';         // 'compact' | 'controls' | 'expanded'
        this._trackKey = null;
        this._artUrl = null;
        this._coverCancellable = null;
        this._peek = new Timeout();
        this._leave = new Timeout();
        this._relayoutSoon = new Timeout();
        this._seenTrack = false;
        this._hovering = false;
        this._marqueeRange = -1;

        this._build();
        this.connect('clicked', () => {
            if (!this._pressOnControls)
                this._service?.current?.playPause();
        });
        this.connect('notify::hover', () => this._onHover());
        // Fora da tela não dá para medir o texto: mede ao aparecer.
        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._update({animate: false});
        });

        this._lyrics = new LyricsFollower(service, update => this._showLyricLine(update));
        service.connectObject(
            'changed', () => this._sync(),
            'stopping', () => this._detach(),
            this);
        this._settings.connectObject('changed', (_s, key) => {
            if (key.startsWith(KEY))
                this._applySettings();
        }, this);
        this._applySettings();
    }

    get labelText() {
        return null;   // nada de dica flutuante: o próprio widget já informa
    }

    // ---------- Montagem ----------

    _build() {
        this._pill = new St.BoxLayout({style_class: 'wavebar-music-pill', clip_to_allocation: true});
        this._content.add_child(this._pill);

        // Capa (ou nota musical) com o selo das barrinhas no canto.
        // Posições fixas (calculadas em applyGeometry): a capa centrada e o
        // selo das barrinhas no canto de baixo, à direita.
        this._coverWrap = new St.Widget({layout_manager: new Clutter.FixedLayout(),
            y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER});
        this._cover = new St.Bin({
            style_class: 'wavebar-music-pill-cover wavebar-music-pill-no-cover',
            child: new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'wavebar-music-pill-note',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
        });
        this._coverWrap.add_child(this._cover);
        this._chip = new St.Bin({style_class: 'wavebar-music-pill-chip'});
        this._chipEq = new Equalizer();
        this._chip.set_child(this._chipEq);
        this._coverWrap.add_child(this._chip);
        this._pill.add_child(this._coverWrap);

        // Texto: título · artista (rolando) e, embaixo, a linha da letra.
        this._details = new St.BoxLayout({style_class: 'wavebar-music-pill-details',
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            visible: false, opacity: 0});
        this._title = new St.Label({style_class: 'wavebar-music-pill-title', y_align: Clutter.ActorAlign.CENTER});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const titleBox = new St.BoxLayout();
        titleBox.add_child(this._title);
        this._titleView = new St.ScrollView({
            style_class: 'wavebar-music-pill-marquee',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false,
            x_expand: true,
            child: titleBox,
        });
        this._hadj = this._titleView.hadjustment;
        this._hadj.connect('changed', () => this._syncMarquee());
        this._details.add_child(this._titleView);
        this._lyric = new St.Label({style_class: 'wavebar-music-pill-lyric', visible: false});
        this._lyric.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._details.add_child(this._lyric);
        this._pill.add_child(this._details);

        // Fim da pílula: barrinhas OU botões de controle.
        this._trail = new St.BoxLayout({style_class: 'wavebar-music-pill-trail', visible: false, opacity: 0,
            y_align: Clutter.ActorAlign.CENTER});
        this._trailEq = new Equalizer();
        this._trail.add_child(this._trailEq);
        this._controls = new St.BoxLayout({style_class: 'wavebar-music-pill-controls', visible: false});
        this._prev = smallButton('media-skip-backward-symbolic', _('Previous track'));
        this._prev.connect('clicked', () => this._service?.current?.previous());
        this._play = smallButton('media-playback-start-symbolic', _('Play or pause'));
        this._play.connect('clicked', () => this._service?.current?.playPause());
        this._next = smallButton('media-skip-forward-symbolic', _('Next track'));
        this._next.connect('clicked', () => this._service?.current?.next());
        for (const b of [this._prev, this._play, this._next])
            this._controls.add_child(b);
        this._trail.add_child(this._controls);
        this._pill.add_child(this._trail);
    }

    // ---------- Geometria (a dock chama) ----------

    cellLength(geometry) {
        return geometry.cellLength + this._extra;
    }

    applyGeometry(geometry) {
        super.applyGeometry(geometry);
        const vertical = geometry.axis.vertical;
        this._pill.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        this._trail.orientation = this._pill.orientation;
        this._controls.orientation = this._pill.orientation;
        // Tudo proporcional ao tamanho do ícone.
        const s = geometry.iconSize;
        const cover = Math.round(s * 0.86);
        this._coverSize = cover;
        this._coverWrap.set_size(s, s);
        this._cover.set_size(cover, cover);
        this._cover.child.icon_size = Math.round(s * 0.42);
        const inset = Math.round((s - cover) / 2);
        this._cover.set_position(inset, inset);
        const chip = Math.max(12, Math.round(s * 0.4));
        this._chip.set_size(chip, chip);
        this._chip.set_position(s - chip, s - chip);
        this._chipEq.set_size(Math.round(chip * 0.5), Math.round(chip * 0.45));
        this._trailEq.set_size(Math.round(s * 0.3), Math.round(s * 0.32));
        const ctl = Math.max(16, Math.round(s * 0.5));
        for (const b of [this._prev, this._play, this._next]) {
            b.set_size(ctl, ctl);
            b.child.icon_size = Math.max(10, Math.round(ctl * 0.5));
        }
        const font = Math.max(9, Math.round(s * (this._lyricsOn ? 0.24 : 0.28)));
        this._title.set_style(`font-size: ${font}px;`);
        this._lyric.set_style(`font-size: ${Math.max(8, Math.round(s * 0.2))}px;`);
        this._cover.set_style(this._coverStyle(cover));
        this._layoutPill();
        // A largura expandida depende do tamanho dos ícones.
        this._update({animate: false});
    }

    /** A pílula ocupa a célula toda, menos a folga das pontas. */
    _layoutPill() {
        const g = this._geometry;
        if (!g)
            return;
        const {axis} = g;
        const length = Math.max(g.iconSize, this.cellLength(g) - 2 * g.gap);
        this._pill.set_position(...axis.toXY(g.gap, g.iconCross));
        this._pill.set_size(...axis.toXY(Math.round(length), g.iconSize));
    }

    /** Largo, o widget não entra na onda de ampliação (ver Dock._onMotion). */
    get magnifies() {
        return this._state === 'compact';
    }

    /** A onda de ampliação só desloca a pílula (ela não amplia). */
    setWave(_scale, offset) {
        if (this._geometry)
            this[this._geometry.axis.mainTranslation] = offset;
    }

    // ---------- Estado ----------

    _applySettings() {
        const s = this._settings;
        this._expandedMode = s.get_string(`${KEY}mode`) === 'expanded';
        this._controlsOn = s.get_boolean(`${KEY}controls`);
        this._lyricsOn = s.get_boolean(`${KEY}lyrics`);
        this._showCover = s.get_boolean(`${KEY}show-cover`);
        this._scrollTitle = s.get_boolean(`${KEY}scroll-title`);
        if (this._geometry)
            this.applyGeometry(this._geometry);
        if (!this._showCover)
            this._setCover(null);
        else
            this._artUrl = null;    // recarrega na próxima sincronização
        this._sync();
    }

    _sync() {
        const player = this._service?.current ?? null;
        const md = player?.metadata;
        this._hasTrack = Boolean(md?.title);
        this._playing = player?.status === 'Playing';
        this.opacity = 255;
        this.remove_style_class_name('wavebar-music-pill-idle');
        if (!player)
            this.add_style_class_name('wavebar-music-pill-idle');

        if (this._hasTrack) {
            const shown = splitArtistTitle(md.title, md.artists.join(', '));
            const title = shown.title || md.title;
            const esc = t => GLib.markup_escape_text(t, -1);
            let markup = `<b>${esc(title)}</b>`;
            if (shown.artist)
                markup += `<span fgalpha="70%">  ·  ${esc(shown.artist)}</span>`;
            if (markup !== this._markup) {
                this._markup = markup;
                this._title.clutter_text.set_markup(markup);
                this._stopMarquee();
            }
            this.accessible_name = shown.artist ? `${title} — ${shown.artist}` : title;
        } else {
            this.accessible_name = _('Music');
        }

        // Capa.
        const art = this._showCover ? md?.artUrl ?? '' : '';
        if (art !== this._artUrl) {
            this._artUrl = art;
            this._loadCover(art);
        }

        // Troca de faixa: expande por alguns segundos (opção), se tocando.
        // (A primeira faixa vista não conta: o widget acabou de aparecer.)
        const key = this._hasTrack ? player.trackKey : null;
        if (key !== this._trackKey) {
            this._trackKey = key;
            if (key && this._playing && this._seenTrack)
                this._startPeek();
            if (key)
                this._seenTrack = true;
        }

        // Pausado: mais apagado, barrinhas paradas.
        const dim = this._playing || !this._hasTrack ? 255 : PAUSED_OPACITY;
        this._coverWrap.opacity = dim;
        this._details.opacity = this._details.visible ? dim : 0;
        this._chipEq.playing = this._playing;
        this._trailEq.playing = this._playing;
        this._chip.visible = this._hasTrack;
        if (this._playing)
            this._pill.remove_style_class_name('wavebar-music-pill-paused');
        else
            this._pill.add_style_class_name('wavebar-music-pill-paused');

        // Botões: ícone do play/pause e os que o player não suporta.
        this._play.child.icon_name = this._playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._setEnabled(this._prev, Boolean(player?.canGoPrevious));
        this._setEnabled(this._next, Boolean(player?.canGoNext));
        this._setEnabled(this._play, Boolean(player && (this._playing ? player.canPause : player.canPlay)));

        this._update();
        this._syncMarquee();
    }

    _setEnabled(button, enabled) {
        button.reactive = enabled;
        if (enabled)
            button.remove_style_pseudo_class('insensitive');
        else
            button.add_style_pseudo_class('insensitive');
    }

    _startPeek() {
        if (this._expandedMode || !this._settings.get_boolean(`${KEY}expand-on-track-change`))
            return;
        const seconds = Math.min(10, Math.max(2, this._settings.get_int(`${KEY}track-change-duration`)));
        this._peek.start(seconds * 1000, () => this._update());
    }

    _onHover() {
        if (this.hover) {
            this._leave.cancel();
            this._hovering = true;
            this._update();
        } else {
            // Uma pequena espera: a pílula muda de tamanho e o ponteiro pode
            // sair por um instante da borda.
            this._leave.start(LEAVE_DELAY_MS, () => {
                this._hovering = false;
                this._update();
            });
        }
    }

    /** Qual estado deve valer agora. */
    _wantedState() {
        if (!this._hasTrack)
            return 'compact';
        const vertical = this._geometry?.axis.vertical;
        const hoverExpand = this._hovering && this._settings.get_boolean(`${KEY}expand-on-hover`);
        const wide = this._expandedMode || this._peek.active || hoverExpand;
        if (vertical)
            return this._controlsOn && (wide || this._hovering) ? 'controls' : 'compact';
        if (wide)
            return 'expanded';
        if (this._controlsOn && this._hovering)
            return 'controls';
        return 'compact';
    }

    /** Comprimento extra (além do ícone) de cada estado. */
    _extraFor(state) {
        const g = this._geometry;
        if (!g || state === 'compact')
            return 0;
        const node = this._pill.get_theme_node();
        const spacing = this._pill.get_stage() ? node.get_length('spacing') : 6;
        const padEnd = Math.round(g.iconSize * 0.18);
        const [, controlsNat] = this._controls.get_preferred_width(-1);
        const [, controlsNatH] = this._controls.get_preferred_height(-1);
        if (state === 'controls')
            return Math.round(spacing + (g.axis.vertical ? controlsNatH : controlsNat) + padEnd / 2);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const max = this._settings.get_int(`${KEY}max-width`) * scale;
        const [, eqNat] = this._trailEq.get_preferred_width(-1);
        const trail = this._controlsOn ? controlsNat : eqNat;
        // Com a letra, a largura é a máxima (a linha muda a toda hora e a
        // pílula não pode ficar mudando de tamanho).
        const [, textNat] = this._titleView.get_child().get_preferred_width(-1);
        const text = this._lyricsOn ? Infinity : textNat;
        const total = g.iconSize + spacing + text + spacing + trail + padEnd;
        return Math.round(Math.max(0, Math.min(max, total) - g.iconSize));
    }

    _update({animate = true} = {}) {
        if (!this._geometry || !this._service || !this._pill.get_stage())
            return;
        const state = this._wantedState();
        const wide = state !== 'compact';
        this._state = state;

        // Letra: só no expandido com a opção ligada (senão, nada roda).
        const lyrics = state === 'expanded' && this._lyricsOn;
        this._lyrics.active = lyrics;
        if (!lyrics)
            this._lyric.visible = false;

        // O que aparece em cada estado.
        this._controls.visible = this._controlsOn && wide;
        this._trailEq.visible = !this._controls.visible;
        this._chip.visible = this._hasTrack && state === 'compact';
        if (wide) {
            this._pill.add_style_class_name('wavebar-music-pill-wide');
            this._trail.show();
            if (state === 'expanded')
                this._details.show();
        }
        const target = this._extraFor(state);
        const fade = (actor, show) => {
            const opacity = show ? (actor === this._details && !this._playing ? PAUSED_OPACITY : 255) : 0;
            if (animate && this.mapped && St.Settings.get().enable_animations)
                actor.ease({opacity, duration: EXPAND_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            else
                actor.opacity = opacity;
        };
        fade(this._details, state === 'expanded');
        fade(this._trail, wide);
        this._animateExtra(target, animate);
    }

    /** Anima o comprimento extra; a dock reposiciona os itens a cada quadro. */
    _animateExtra(target, animate) {
        if (target === this._extraTo && (this._timeline?.is_playing() || this._extra === target))
            return;
        this._extraFrom = this._extra;
        this._extraTo = target;
        const done = () => {
            if (this._extraTo === 0) {
                // Compacto de novo: esconde o que ficou de fora.
                this._details.hide();
                this._trail.hide();
                this._pill.remove_style_class_name('wavebar-music-pill-wide');
            }
            this._syncMarquee();
            // Fora do quadro atual: a dock pode estar no meio de um relayout
            // (ex.: este item acabou de entrar).
            this._relayoutSoon.start(0, () => {
                if (!this.dock.destroyed)
                    this.dock.relayout();
            });
        };
        this._timeline?.stop();
        if (!animate || !this.mapped || !St.Settings.get().enable_animations) {
            this._extra = target;
            this._layoutPill();
            done();
            return;
        }
        if (!this._timeline) {
            this._timeline = new Clutter.Timeline({actor: this, duration: EXPAND_MS});
            this._timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._timeline.connect('new-frame', () => this._onExtraFrame());
            this._timeline.connect('completed', () => {
                this._onExtraFrame(1);
                this._extraDone?.();
            });
        }
        this._extraDone = done;
        this._timeline.rewind();
        this._timeline.start();
    }

    _onExtraFrame(progress = null) {
        const t = progress ?? this._timeline.get_progress();
        this._extra = this._extraFrom + (this._extraTo - this._extraFrom) * t;
        this.dock.layoutItemsNow();
        this._layoutPill();
    }

    // ---------- Letra ----------

    _showLyricLine({kind, lines, index}) {
        const text = kind === 'synced' && index >= 0 ? lines[index]?.text ?? '' : '';
        const show = this._state === 'expanded' && this._lyricsOn && kind === 'synced';
        // A linha existe (mesmo vazia) com letra sincronizada: a pílula não
        // muda de altura nem pula entre "com" e "sem" letra.
        this._lyric.visible = show;
        if (!show || text === this._lyricText)
            return;
        this._lyricText = text;
        if (!this.mapped || !St.Settings.get().enable_animations) {
            this._lyric.text = text;
            return;
        }
        // Troca suave: a linha antiga sobe e some; a nova entra de baixo.
        this._lyric.remove_all_transitions();
        this._lyric.ease({
            opacity: 0, translation_y: -3, duration: LINE_FADE_MS / 2, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._lyric.text = this._lyricText ?? '';
                this._lyric.translation_y = 3;
                this._lyric.ease({opacity: 255, translation_y: 0, duration: LINE_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            },
        });
    }

    // ---------- Capa ----------

    _coverStyle(size) {
        const radius = Math.round(size * 0.24);
        const image = this._coverPath ? ` background-image: url("${GLib.filename_to_uri(this._coverPath, null)}");` : '';
        return `border-radius: ${radius}px;${image}`;
    }

    async _loadCover(url) {
        this._coverCancellable?.cancel();
        this._coverCancellable = null;
        // Faixa nova: some a capa antiga na hora (nada de capa errada).
        this._setCover(null);
        if (!url || !this._service)
            return;
        const cancellable = new Gio.Cancellable();
        this._coverCancellable = cancellable;
        let path = null;
        try {
            path = await this._service.covers.load(url, cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        if (!cancellable.is_cancelled() && this._service)
            this._setCover(path);
    }

    _setCover(path) {
        this._coverPath = path;
        this._cover.set_style(this._coverStyle(this._coverSize ?? 32));
        if (path)
            this._cover.remove_style_class_name('wavebar-music-pill-no-cover');
        else
            this._cover.add_style_class_name('wavebar-music-pill-no-cover');
        this._cover.child.visible = !path;
    }

    // ---------- Rolagem do título (marquee) ----------
    //
    // Sem timers: cada trecho é um ease() do hadjustment, com "delay" como
    // pausa; o onComplete encadeia o próximo. Pausado ou desligado: parado.

    _marqueeOk() {
        return this._scrollTitle && this._playing && this._state === 'expanded' && this.mapped &&
            !this._timeline?.is_playing() && St.Settings.get().enable_animations &&
            this._hadj.upper - this._hadj.page_size >= 1;
    }

    _syncMarquee() {
        if (!this._marqueeOk()) {
            this._stopMarquee();
            return;
        }
        const range = this._hadj.upper - this._hadj.page_size;
        if (Math.abs(range - this._marqueeRange) < 0.5)
            return;
        this._stopMarquee();
        this._marqueeRange = range;
        this._marqueeStep(true);
    }

    _marqueeStep(forward) {
        if (this._marqueeRange < 0 || !this._marqueeOk()) {
            this._stopMarquee();
            return;
        }
        const range = this._hadj.upper - this._hadj.page_size;
        this._marqueeRange = range;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const speed = (forward ? MARQUEE_SPEED : MARQUEE_RETURN_SPEED) * scale;
        this._hadj.ease(forward ? range : 0, {
            duration: Math.max(1, range / speed * 1000),
            delay: forward ? MARQUEE_START_PAUSE_MS : MARQUEE_END_PAUSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => this._marqueeStep(!forward),
        });
    }

    _stopMarquee() {
        this._marqueeRange = -1;
        this._hadj.remove_transition('value');
        this._hadj.value = 0;
    }

    // ---------- Mouse ----------

    /** O ponto (da tela) está sobre os botões de controle? */
    _overControls(event) {
        if (!this._controls.mapped)
            return false;
        const [x, y] = event.get_coords();
        const [cx, cy] = this._controls.get_transformed_position();
        const [cw, ch] = this._controls.get_transformed_size();
        return x >= cx && x <= cx + cw && y >= cy && y <= cy + ch;
    }

    vfunc_button_press_event(event) {
        // Sobre os botões de controle, só eles respondem (nem card, nem
        // tocar/pausar pelo clique do meio no item).
        this._pressOnControls = this._overControls(event);
        if (this._pressOnControls && event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            if (this._service?.current)
                this.dock.manager.toggleMusicCard(this);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Rodinha: volume do player (os que informam volume). */
    onScroll(event) {
        const player = this._service?.current;
        if (!player || player.volume === null)
            return;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = VOLUME_STEP;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -VOLUME_STEP;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            delta = -dy * VOLUME_STEP;
            break;
        }
        }
        if (delta)
            player.setVolume(player.volume + delta);
    }

    // ---------- Fim ----------

    /** O serviço vai sumir (widget desligado): larga tudo o que é dele. */
    _detach() {
        if (!this._service)
            return;
        this._lyrics.destroy();
        this._coverCancellable?.cancel();
        this._coverCancellable = null;
        this._peek.cancel();
        this._leave.cancel();
        this._relayoutSoon.cancel();
        this._stopMarquee();
        this._chipEq.playing = false;
        this._trailEq.playing = false;
        this._service.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._service = null;
    }

    destroy() {
        this._detach();
        this._timeline?.stop();
        this._timeline = null;
        this._extraDone = null;
        this._hadj.remove_transition('value');
        super.destroy();
    }
});
