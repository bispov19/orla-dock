// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// dock.js — a dock de UM monitor: atores, layout, ampliação, tooltip, menus
// e arrastar e soltar. O DockManager cria uma destas por monitor.
//
// Árvore de atores:
//
//   _root (St.Widget, "chrome" do Shell, faixa colada na borda da tela)
//   ├─ _background (St.Widget) ← fundo translúcido + blur arredondado
//   └─ _itemsLayer (Clutter.Actor) ← os DockItem, posicionados por nós
//
// "Chrome" é como o GNOME Shell chama a interface que fica por cima das
// janelas (painel, dock…). Main.layoutManager.addChrome() adiciona o ator e
// cuida de escondê-lo quando há uma janela em tela cheia.
//
// Desempenho: o layout (posição/tamanho dos itens) só é refeito quando a
// lista muda ou uma opção muda. Durante o movimento do mouse mexemos apenas
// em `scale` e `translation`, que não causam relayout.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {poof} from './animations.js';
import {AppIcon, ShowAppsItem, WindowItem} from './appIcon.js';
import {DockMenu} from './appMenu.js';
import {Autohide} from './autohide.js';
import {RoundedBlurEffect} from './blur.js';
import {DockItem, DockSeparator} from './dockItem.js';
import {Magnifier} from './magnifier.js';
import {MountItem, mountKey} from './mounts.js';
import {StackItem} from './stacks.js';
import {getStyle} from './styles.js';
import {TaskbarClock} from './taskbarClock.js';
import {accentHex, dockStyle, hexToRgb, pickColor, rgba} from './themes.js';
import {TrashItem} from './trash.js';
import {Axis, Position, Timeout} from './utils.js';
import {WindowPreviews} from './windowPreviews.js';

const GROW_MS = 260;
const MOVE_MS = 180;
const EDGE_GAP = 12;

export class Dock {
    constructor(manager, monitorIndex) {
        this.manager = manager;
        this.settings = manager.settings;
        this.monitorIndex = monitorIndex;
        this.monitor = Main.layoutManager.monitors[monitorIndex];
        this.axis = new Axis(this.settings.get_enum('position'));
        // Estilo da barra (ver lib/styles.js): dock do macOS, barra de
        // tarefas do Windows 10… Tudo o que muda entre eles vem daqui.
        this.style = getStyle(this.settings.get_string('bar-style'));
        this.dragging = false;
        this.look = null;   // cores e estilos calculados em syncStyle()

        this._items = new Map();   // key → DockItem
        this._order = [];          // itens na ordem de exibição
        this._geometry = null;
        this._hovered = false;
        this._tooltipItem = null;
        this._menu = null;
        this._placeholderIndex = -1;
        this._placeholderGrowth = 0;
        this._dragSource = null;
        this._dragDropped = null;
        this._waveStarts = new Float64Array(64);
        this._waveLengths = new Float64Array(64);
        this._waveCount = 0;
        this._leaveCheck = new Timeout();

        this._buildActors();
        this._magnifier = new Magnifier(this);
        this.autohide = new Autohide(this);
        this._previews = new WindowPreviews(this);

        this.syncStyle();
        this.rebuild({animate: false});
    }

    get root() {
        return this._root;
    }

    // ===================================================================
    // Construção
    // ===================================================================

    _buildActors() {
        this._root = new St.Widget({
            name: 'orlaDock',
            style_class: 'orla-dock',
            reactive: false,
        });
        // O _delegate faz a dock inteira ser um "alvo de soltar" no dnd.js.
        this._root._delegate = this;

        this._background = new St.Widget({
            style_class: 'orla-background',
            reactive: true,
        });
        this._blurEffect = new RoundedBlurEffect();
        this._background.add_effect(this._blurEffect);
        this._root.add_child(this._background);

        // Vidro ESTÁTICO: uma imagem do tamanho do monitor, posicionada como
        // se estivesse "atrás" da dock, que o efeito desfoca (modo ACTOR).
        this._staticLayer = new St.Widget({style_class: 'orla-static-glass', visible: false});
        this._background.add_child(this._staticLayer);

        this._itemsLayer = new Clutter.Actor();
        this._root.add_child(this._itemsLayer);

        // trackFullscreen: esconde a dock quando há janela em tela cheia.
        Main.layoutManager.addChrome(this._root, {trackFullscreen: true});

        // Rótulo com o nome do app (fica no topo de tudo).
        this._tooltip = new St.Label({style_class: 'orla-tooltip', visible: false});
        Main.layoutManager.addTopChrome(this._tooltip);

        // Movimento do mouse. O Clutter só repassa eventos a atores
        // REATIVOS; o _root não é (senão a faixa inteira da borda bloquearia
        // cliques nas janelas). Por isso escutamos o fundo e cada item.
        this._trackPointer(this._background);
        // Botão direito no fundo da dock: o menu da dock.
        this._background.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.openDockMenu(this._background);
            return Clutter.EVENT_STOP;
        });

        this._menuManager = new PopupMenu.PopupMenuManager(this._root);

        if (this.style.clock && this.settings.get_boolean('taskbar-clock')) {
            this._clock = new TaskbarClock();
            this._root.add_child(this._clock);
        }

        // App em foco: destacado na barra de tarefas.
        Shell.WindowTracker.get_default().connectObject('notify::focus-app',
            () => this._syncFocus(), this);

        // Se o painel superior mudar de tamanho ou sumir (ex.: Just
        // Perfection), refazemos o layout.
        Main.layoutManager.panelBox.connectObject(
            'notify::height', () => this.relayout(),
            'notify::visible', () => this.relayout(),
            this);
    }

    _trackPointer(actor) {
        actor.connect('motion-event', (_a, event) => this._onMotion(event));
        actor.connect('leave-event', () => this._scheduleLeaveCheck());
    }

    destroy() {
        // Destruir os itens dispara eventos de "saída do mouse"; a marca
        // impede que eles agendem trabalho numa dock que já não existe.
        this._destroyed = true;
        Main.layoutManager.panelBox.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        this._leaveCheck.cancel();
        this._magnifier.destroy();
        this._growTimeline?.stop();
        this._removeDragMonitor();
        this._closeMenu();
        this._previews.destroy();
        this.autohide.destroy();
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        this._order = [];
        this._tooltip.destroy();
        this._root.destroy();
        this._leaveCheck.cancel();
    }

    // ===================================================================
    // Aparência
    // ===================================================================

    /**
     * Calcula a aparência (tema, cores, contorno, vidro) e aplica no fundo,
     * no rótulo e em todos os itens. Os itens leem o resultado em `this.look`.
     */
    syncStyle() {
        const s = this.settings;
        const m = this.manager;
        const barStyle = this.style;
        const glass = s.get_boolean('blur-enabled');
        const style = dockStyle({
            theme: s.get_enum('theme'),
            backgroundColor: s.get_string('background-color'),
            useGradient: s.get_boolean('use-gradient'),
            gradientColor: s.get_string('gradient-color'),
            gradientDirection: s.get_enum('gradient-direction'),
            opacity: s.get_double('background-opacity'),
            borderWidth: s.get_int('border-width'),
            borderColor: s.get_string('border-color'),
            borderOpacity: s.get_double('border-opacity'),
            radius: barStyle.roundCorners ? s.get_int('corner-radius') : 0,
            glass,
            glassTint: s.get_string('blur-tint-color'),
            systemDark: m.darkMode,
            wallpaperRgb: m.wallpaperColor.rgb,
        });

        let css = style.background;
        if (barStyle.fullWidth) {
            // A barra encosta na borda: só o lado de DENTRO tem contorno.
            const inner = ['top', 'bottom', 'right', 'left'][this.axis.position];
            css = css.replace('border: ', `border: none; border-${inner}: `);
        }
        this._background.set_style(css);

        this._syncGlass(glass, barStyle.roundCorners ? s.get_int('corner-radius') : 0);

        const dark = style.dark;
        const accent = accentHex(m.accentName);
        const autoIndicator = barStyle.edgeIndicator
            ? rgba(hexToRgb(accent), 1)
            : (dark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.7)');
        this.look = {
            dark,
            indicator: {
                enabled: s.get_boolean('show-indicators'),
                style: s.get_string('indicator-style'),
                size: s.get_int('indicator-size'),
                glow: s.get_boolean('indicator-glow'),
                color: pickColor(s.get_enum('indicator-color-mode'),
                    s.get_string('indicator-color'), accent, autoIndicator),
            },
            badgeColor: pickColor(s.get_enum('badge-color-mode'),
                s.get_string('badge-color'), accent, '#ff3b30'),
            separator: {
                thickness: s.get_int('separator-thickness'),
                length: s.get_double('separator-length'),
                color: rgba(hexToRgb(s.get_string('separator-color')),
                    s.get_double('separator-opacity')),
            },
            hoverColor: dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(0, 0, 0, 0.07)',
            focusColor: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.12)',
            attentionColor: 'rgba(255, 140, 0, 0.55)',
            // Fundo dos rótulos, miniaturas e stacks: a cor do tema.
            popupCss: `background-color: ${rgba(style.base, s.get_double('popup-opacity'))};`,
        };

        const variant = dark ? 'orla-dark' : 'orla-light';
        for (const name of ['orla-dark', 'orla-light'])
            this._root.remove_style_class_name(name);
        this._root.add_style_class_name(variant);
        this._tooltip.set_style_class_name(`orla-tooltip ${variant}`);
        this._tooltip.set_style(this.look.popupCss);

        for (const item of this._order)
            item.syncAppearance();
    }

    /**
     * Vidro (aba Desfoque): dinâmico desfoca o que está atrás da dock;
     * estático desfoca uma imagem fixa. Os ajustes de cor ficam no shader.
     */
    _syncGlass(enabled, radius) {
        const s = this.settings;
        const effect = this._blurEffect;
        const isStatic = s.get_string('blur-mode') === 'static';
        effect.enabled = enabled;
        this._staticLayer.visible = enabled && isStatic;
        this._background.clip_to_allocation = enabled && isStatic;
        if (!enabled)
            return;

        effect.mode = isStatic ? Shell.BlurMode.ACTOR : Shell.BlurMode.BACKGROUND;
        effect.radius = Math.round(s.get_double('blur-intensity'));
        effect.brightness = 1.0;
        effect.cornerRadius = radius;
        const [r, g, b] = hexToRgb(s.get_string('blur-tint-color')).map(v => v / 255);
        effect.setGlass({
            saturation: s.get_double('blur-vibrancy'),
            lift: s.get_double('blur-brightness') * 0.18,
            tint: [r, g, b, s.get_double('blur-tint-opacity')],
            glow: s.get_double('blur-border-glow'),
            angle: s.get_double('blur-highlight-angle') * Math.PI / 180,
        });

        if (isStatic) {
            const path = this._staticImagePath();
            this._staticLayer.set_style(path
                ? `background-image: url("${path}"); background-size: cover;`
                : 'background-color: #222;');
            this._placeStaticLayer();
        }
    }

    _staticImagePath() {
        const s = this.settings;
        if (s.get_string('blur-static-source') === 'custom') {
            const photo = s.get_string('blur-custom-photo');
            if (photo && Gio.File.new_for_path(photo).query_exists(null))
                return photo;
        }
        const preset = s.get_string('blur-static-preset').replace(/[^a-z0-9-]/g, '');
        return `${this.manager.extensionPath}/icons/glass/${preset}.svg`;
    }

    /** A imagem estática cobre o monitor; a dock "enxerga" o pedaço dela. */
    _placeStaticLayer() {
        if (!this._staticLayer.visible || !this._rootPosition)
            return;
        const m = this.monitor;
        const [rx, ry] = this._rootPosition;
        this._staticLayer.set_size(m.width, m.height);
        this._staticLayer.set_position(m.x - rx - this._background.x, m.y - ry - this._background.y);
    }

    // ===================================================================
    // Itens (modelo → atores)
    // ===================================================================

    /** Lista desejada de itens: [chave, fábrica]. */
    _desiredItems() {
        const tracker = this.manager.appTracker;
        const s = this.settings;
        const first = [];
        const second = [];
        const third = [];

        if (s.get_boolean('show-apps-button'))
            first.push(['show-apps', () => new ShowAppsItem(this)]);
        for (const app of tracker.getPinned())
            first.push([`app:${app.get_id()}`, () => new AppIcon(this, app)]);

        const seen = new Set(first.map(([key]) => key));
        for (const app of [...tracker.getRunningUnpinned(), ...tracker.getRecent()]) {
            const key = `app:${app.get_id()}`;
            if (!seen.has(key)) {
                seen.add(key);
                second.push([key, () => new AppIcon(this, app)]);
            }
        }

        // Janelas minimizadas (opção "minimizar no ícone do app" desligada):
        // logo depois do separador, antes das pastas e da Lixeira — na
        // ordem em que foram minimizadas.
        if (!s.get_boolean('minimize-to-app')) {
            for (const win of this.manager.getMinimizedWindows())
                third.push([`win:${win.get_stable_sequence()}`, () => new WindowItem(this, win)]);
        }
        // Mesma ordem da Luma: Locais → unidades → pastas extras → Lixeira.
        for (const uri of this.manager.getPlaceUris())
            third.push([`stack:${uri}`, () => new StackItem(this, uri)]);
        for (const mount of this.manager.getMounts())
            third.push([mountKey(mount), () => new MountItem(this, mount)]);
        for (const uri of this.manager.getCustomFolderUris())
            third.push([`stack:${uri}`, () => new StackItem(this, uri)]);
        if (s.get_boolean('show-trash'))
            third.push(['trash', () => new TrashItem(this)]);

        // A barra de tarefas (estilo Windows) não usa separadores.
        const separators = this.style.separators;
        const result = [...first];
        if (separators && first.length && second.length)
            result.push(['sep:1', () => new DockSeparator(this)]);
        result.push(...second);
        if (separators && (first.length || second.length) && third.length)
            result.push(['sep:2', () => new DockSeparator(this)]);
        result.push(...third);
        return result;
    }

    /**
     * Sincroniza os atores com a lista desejada. Itens novos "crescem",
     * itens que saíram "encolhem" e só então são destruídos.
     */
    rebuild({animate = true} = {}) {
        const desired = this._desiredItems();
        const wanted = new Set(desired.map(([key]) => key));
        const newOrder = [];
        let changed = false;

        for (const [key, factory] of desired) {
            let item = this._items.get(key);
            if (!item) {
                item = factory();
                item.key = key;
                this._trackPointer(item);
                this._items.set(key, item);
                this._itemsLayer.add_child(item);
                if (this._geometry)
                    item.applyGeometry(this._geometry);
                item.growth = animate ? 0 : 1;
                changed = true;
            } else if (item.removing) {
                item.removing = false;
                changed = true;
            }
            item.targetGrowth = 1;
            newOrder.push(item);
        }

        // Itens que saíram ficam no lugar antigo enquanto encolhem.
        this._order.forEach((item, index) => {
            if (wanted.has(item.key))
                return;
            if (!item.removing) {
                item.removing = true;
                item.targetGrowth = 0;
                changed = true;
            }
            const before = this._order[index - 1];
            const at = before ? newOrder.indexOf(before) + 1 : 0;
            newOrder.splice(at, 0, item);
        });

        const reordered = newOrder.length !== this._order.length ||
            newOrder.some((item, i) => item !== this._order[i]);
        this._order = newOrder;

        if (!animate) {
            for (const item of [...this._order]) {
                if (item.removing)
                    this._destroyItem(item);
                else
                    item.growth = 1;
            }
        }
        if (changed || reordered || !this._geometry)
            this.relayout({animateMoves: animate && reordered});
        if (changed)
            this._syncFocus();
        if (animate && changed)
            this._startGrowAnimation();
    }

    _destroyItem(item) {
        if (this._tooltipItem === item)
            this._hideTooltip();
        this._items.delete(item.key);
        this._order = this._order.filter(i => i !== item);
        item.destroy();
    }

    getItems() {
        return this._order.filter(item => !item.removing);
    }

    findItem(key) {
        return this._items.get(key) ?? null;
    }

    // ===================================================================
    // Layout
    // ===================================================================

    /** Medidas da barra: cada estilo calcula as suas (lib/styles.js). */
    _makeGeometry(iconSize) {
        const style = this.style;
        return {
            axis: this.axis,
            iconSize,
            ...style.geometry(iconSize, this.settings, this.axis),
            // Comportamentos que os itens consultam:
            cellHighlight: style.cellHighlight,
            edgeIndicator: style.edgeIndicator,
        };
    }

    _totalLength(geometry) {
        let total = geometry.endPadding * 2;
        for (const item of this._order)
            total += item.cellLength(geometry) * item.growth;
        if (this._placeholderIndex >= 0)
            total += geometry.cellLength * this._placeholderGrowth;
        return total;
    }

    /**
     * Espaço ocupado pelo painel superior do GNOME neste monitor. A dock
     * superior fica abaixo dele, e as laterais começam abaixo dele.
     */
    get topInset() {
        const panelBox = Main.layoutManager.panelBox;
        if (this.monitorIndex !== Main.layoutManager.primaryIndex || !panelBox.visible)
            return 0;
        return panelBox.height;
    }

    get monitorLength() {
        return this.axis.vertical ? this.monitor.height - this.topInset : this.monitor.width;
    }

    /**
     * Calcula o tamanho dos ícones (encolhendo se não couber na tela — o
     * "tamanho dinâmico") e reposiciona tudo.
     */
    relayout({animateMoves = false} = {}) {
        const wanted = this.settings.get_int(this.style.iconSizeKey);
        const available = this.monitorLength - (this.style.fullWidth ? this._clockLength() : EDGE_GAP * 2);
        let size = wanted;
        // A célula cresce proporcionalmente ao ícone, então uma regra de três
        // (repetida 2x por causa dos arredondamentos) acha o tamanho que cabe.
        for (let i = 0; i < 3; i++) {
            const length = this._totalLength(this._makeGeometry(size));
            if (length <= available)
                break;
            size = Math.max(16, Math.floor(size * available / length));
        }

        const geometry = this._makeGeometry(size);
        const geometryChanged = !this._geometry ||
            ['iconSize', 'maxScale', 'margin', 'reflection', 'gap', 'farPad', 'edgePad']
                .some(k => this._geometry[k] !== geometry[k]) ||
            this._geometry.axis !== geometry.axis;
        this._geometry = geometry;
        if (geometryChanged) {
            for (const item of this._order)
                item.applyGeometry(geometry);
        }

        this._placeRoot();
        this._layoutItems(animateMoves);
        this.autohide.sync();
        this._previews.reposition();
        this.manager.queueIconGeometry();
    }

    /** A faixa do _root: toda a borda do monitor, com a espessura da dock. */
    _placeRoot() {
        const g = this._geometry;
        const m = this.monitor;
        const depth = g.thickness + g.margin;
        const [w, h] = this.axis.toXY(this.monitorLength, depth);
        let x = m.x, y = m.y;
        if (this.axis.position === Position.BOTTOM)
            y = m.y + m.height - depth;
        else if (this.axis.position === Position.RIGHT)
            x = m.x + m.width - depth;
        if (this.axis.position !== Position.BOTTOM)
            y += this.topInset;
        this._root.set_position(x, y);
        this._root.set_size(w, h);
        this._rootPosition = [x, y];
        this._barCross = this.axis.edgeAtEnd ? 0 : g.margin;
        this._placeClock();
    }

    /** Espaço reservado no fim da barra de tarefas para o relógio. */
    _clockLength() {
        if (!this._clock)
            return 0;
        this._clock.setVertical(this.axis.vertical);
        const [, , w, h] = this._clock.get_preferred_size();
        return Math.ceil(this.axis.vertical ? h : w) + 12;
    }

    _placeClock() {
        if (!this._clock)
            return;
        const g = this._geometry;
        const [, , w, h] = this._clock.get_preferred_size();
        const length = this.axis.vertical ? h : w;
        const thick = this.axis.vertical ? w : h;
        const [x, y] = this.axis.toXY(
            Math.round(this.monitorLength - length - 6),
            Math.round(this._barCross + (g.thickness - thick) / 2));
        this._clock.set_position(x, y);
        this._clock.set_style(this.look?.dark === false ? 'color: #1c1c1e;' : 'color: #f2f2f2;');
    }

    get geometry() {
        return this._geometry;
    }

    get barCross() {
        return this._barCross;
    }

    /** Posiciona os itens em fila (sem a onda) e o fundo. */
    _layoutItems(animateMoves) {
        const g = this._geometry;
        const axis = this.axis;
        const total = this._totalLength(g);
        // Dock: centralizada. Barra de tarefas: alinhada no início.
        const start = this.style.align === 'start' ? 0 : Math.round((this.monitorLength - total) / 2);
        let cursor = start + g.endPadding;
        let count = 0;

        this._ensureWaveCapacity(this._order.length + 1);

        const visible = this._order;
        for (let i = 0; i <= visible.length; i++) {
            if (i === this._placeholderIndex && this._placeholderGrowth > 0) {
                const length = g.cellLength * this._placeholderGrowth;
                cursor += length;
            }
            if (i === visible.length)
                break;

            const item = visible[i];
            const full = item.cellLength(g);
            const length = full * item.growth;
            item.baseMain = cursor;
            item.baseLength = length;
            item.waveIndex = count;
            this._waveStarts[count] = cursor;
            this._waveLengths[count] = length;
            count++;

            // A célula sempre tem o tamanho cheio; durante o "crescer",
            // ela fica centralizada no espaço (menor) que já ocupa.
            const mainPos = Math.round(cursor + (length - full) / 2);
            const [x, y] = axis.toXY(mainPos, this._barCross);
            const [w, h] = axis.toXY(full, g.thickness);
            item.set_size(w, h);
            item.layoutMain = mainPos;
            if (animateMoves && item.growth === 1 && item.mapped) {
                item.ease({x, y, duration: MOVE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                item.remove_transition('x');
                item.remove_transition('y');
                item.set_position(x, y);
            }
            const growth = item.growth;
            item.opacity = Math.round(255 * Math.min(1, growth * 1.4));
            item.set_pivot_point(0.5, 0.5);
            item.set_scale(0.3 + 0.7 * growth, 0.3 + 0.7 * growth);
            cursor += length;
        }
        this._waveCount = count;
        this._baseStart = start;
        // A barra de tarefas ocupa a borda inteira.
        this._baseEnd = this.style.fullWidth ? this.monitorLength : start + total;
        this._magnifier.layoutChanged();
    }

    _ensureWaveCapacity(n) {
        if (this._waveStarts.length >= n)
            return;
        const size = Math.max(n, this._waveStarts.length * 2);
        this._waveStarts = new Float64Array(size);
        this._waveLengths = new Float64Array(size);
    }

    // Dados lidos pelo Magnifier (lib/magnifier.js).
    get waveCount() {
        return this._waveCount;
    }

    get waveStarts() {
        return this._waveStarts;
    }

    get waveLengths() {
        return this._waveLengths;
    }

    get baseStart() {
        return this._baseStart;
    }

    get baseEnd() {
        return this._baseEnd;
    }

    get orderedItems() {
        return this._order;
    }

    // ---------- Animação de entrada/saída ----------

    _startGrowAnimation() {
        for (const item of this._order)
            item.growFrom = item.growth;
        this._placeholderFrom = this._placeholderGrowth;

        if (!this._growTimeline) {
            this._growTimeline = new Clutter.Timeline({actor: this._root, duration: GROW_MS});
            this._growTimeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._growTimeline.connect('new-frame', () => this._onGrowFrame(false));
            this._growTimeline.connect('completed', () => this._onGrowFrame(true));
        }
        this._growTimeline.stop();
        this._growTimeline.rewind();
        this._growTimeline.start();
    }

    _onGrowFrame(done) {
        const t = done ? 1 : this._growTimeline.get_progress();
        for (const item of this._order) {
            const target = item.targetGrowth ?? 1;
            item.growth = item.growFrom + (target - item.growFrom) * t;
        }
        const placeholderTarget = this._placeholderIndex >= 0 ? 1 : 0;
        this._placeholderGrowth = this._placeholderFrom +
            (placeholderTarget - this._placeholderFrom) * t;

        if (done) {
            for (const item of [...this._order]) {
                if (item.removing)
                    this._destroyItem(item);
            }
            this.relayout();
        } else {
            this._layoutItems(false);
        }
    }

    // ===================================================================
    // Ampliação (onda)
    // ===================================================================

    _onMotion(event) {
        if (this.dragging || this._menu)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [ok, lx, ly] = this._itemsLayer.transform_stage_point(x, y);
        if (!ok)
            return Clutter.EVENT_PROPAGATE;
        if (!this._hovered)
            this._setHovered(true);
        // Só atualiza o ALVO; o Magnifier anima a cada quadro.
        if (this.style.magnification && this._geometry.maxScale > 1.001)
            this._magnifier.pointerMoved(this.axis.main(lx, ly));
        return Clutter.EVENT_PROPAGATE;
    }

    _scheduleLeaveCheck() {
        if (this._destroyed)
            return;
        // Ao passar de um item para outro há um "leave" seguido de "enter";
        // esperamos um instante e conferimos o que está sob o cursor.
        this._leaveCheck.start(40, () => {
            if (!this.isPointerOver(this._root))
                this._setHovered(false);
        });
    }

    /** O cursor está sobre `actor` (ou um descendente dele)? */
    isPointerOver(actor) {
        const [x, y] = global.get_pointer();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        return Boolean(picked && actor.contains(picked));
    }

    get hovered() {
        return this._hovered;
    }

    _setHovered(hovered) {
        if (this._hovered === hovered)
            return;
        this._hovered = hovered;
        if (!hovered) {
            this._hideTooltip();
            this._magnifier.leave();
        }
        this.autohide.sync();
    }

    /** Zera a ampliação na hora (ex.: antes de abrir um menu). */
    resetZoom() {
        this._hovered = false;
        this._magnifier.reset();
    }

    /** Posiciona o fundo entre `start` e `end` (chamado pelo Magnifier). */
    placeBackground(start, end) {
        const g = this._geometry;
        const [x, y] = this.axis.toXY(Math.round(start), this._barCross);
        const [w, h] = this.axis.toXY(Math.round(end - start), g.thickness);
        this._background.set_position(x, y);
        this._background.set_size(w, h);
        this._placeStaticLayer();
        if (this._tooltipItem)
            this._positionTooltip();
    }

    /** Destaca o app em foco (visível no modo barra de tarefas). */
    _syncFocus() {
        const focusApp = Shell.WindowTracker.get_default().focus_app;
        for (const item of this._order) {
            if (item instanceof AppIcon)
                item.setFocused(item.app === focusApp);
        }
    }

    // ===================================================================
    // Rótulo (tooltip)
    // ===================================================================

    onItemHoverChanged(item) {
        if (item.hover && !this.dragging && !this._menu && !this._previews.visible &&
            item.labelText) {
            this._tooltipItem = item;
            this._tooltip.text = item.labelText;
            if (!this._tooltip.visible) {
                this._tooltip.opacity = 0;
                this._tooltip.show();
                this._tooltip.ease({opacity: 255, duration: 100});
            }
            this._positionTooltip();
        } else if (this._tooltipItem === item && !item.hover) {
            this._hideTooltip();
        }
    }

    _hideTooltip() {
        this._tooltipItem = null;
        this._tooltip.remove_all_transitions();
        this._tooltip.hide();
    }

    /** Põe `actor` do lado de fora do ícone (acima, na dock inferior). */
    placeOutside(actor, item, spacing = 10) {
        const ext = item._iconBin.get_transformed_extents();
        const [aw, ah] = actor.get_preferred_size().slice(2);
        const cx = ext.origin.x + ext.size.width / 2;
        const cy = ext.origin.y + ext.size.height / 2;
        let x, y;
        switch (this.axis.position) {
        case Position.BOTTOM: x = cx - aw / 2; y = ext.origin.y - ah - spacing; break;
        case Position.TOP: x = cx - aw / 2; y = ext.origin.y + ext.size.height + spacing; break;
        case Position.LEFT: x = ext.origin.x + ext.size.width + spacing; y = cy - ah / 2; break;
        default: x = ext.origin.x - aw - spacing; y = cy - ah / 2; break;
        }
        const m = this.monitor;
        x = Math.max(m.x + 4, Math.min(x, m.x + m.width - aw - 4));
        y = Math.max(m.y + 4, Math.min(y, m.y + m.height - ah - 4));
        actor.set_position(Math.round(x), Math.round(y));
    }

    _positionTooltip() {
        if (this._tooltipItem)
            this.placeOutside(this._tooltip, this._tooltipItem);
    }

    // ===================================================================
    // Menus e miniaturas
    // ===================================================================

    openMenu(item, menu) {
        this._closeMenu();
        this.hidePreviews();
        this._hideTooltip();
        this.resetZoom();

        this._menu = menu;
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open && this._menu === menu) {
                this._menu = null;
                this.autohide.sync();
            }
        });
        // Destruímos o menu só depois da animação de fechar terminar.
        menu.connect('menu-closed', () => {
            this._menuManager.removeMenu(menu);
            menu.destroy();
        });
        menu.open(BoxPointer.PopupAnimation.FULL);
        this.autohide.sync();
    }

    /** Menu da própria dock (posição, estilo, ocultação…). */
    openDockMenu(sourceActor) {
        this.openMenu(sourceActor, new DockMenu(sourceActor, this));
    }

    _closeMenu() {
        if (!this._menu)
            return;
        const menu = this._menu;
        this._menu = null;
        this._menuManager.removeMenu(menu);
        menu.destroy();
    }

    get busy() {
        return Boolean(this._menu) || this._previews.visible || this.dragging ||
            this._order.some(item => item.popupOpen);
    }

    showPreviews(appIcon, persistent) {
        this._hideTooltip();
        this._previews.show(appIcon, persistent);
        this.autohide.sync();
    }

    hidePreviews() {
        this._previews.hide();
    }

    onPopupClosed() {
        this.autohide.sync();
    }

    // ===================================================================
    // Arrastar e soltar
    // ===================================================================

    onDragBegin(item) {
        this.dragging = true;
        this._dragSource = item;
        this._dragDropped = null;
        this._hideTooltip();
        this.hidePreviews();
        this.resetZoom();
        this._addDragMonitor();

        // Um app fixado sendo arrastado: o lugar dele vira o "buraco".
        if (item instanceof AppIcon && this.manager.appTracker.isPinned(item.app)) {
            item.targetGrowth = 0;
            this._setPlaceholder(this._order.indexOf(item), item);
        }
        this.autohide.sync();
    }

    onDragCancelled(item) {
        // Soltou fora da dock um app fixado → remove com "fumacinha".
        const drop = this._dragDropped;
        const pinnedApp = item instanceof AppIcon && this.manager.appTracker.isPinned(item.app);
        // Conferimos também a geometria: soltar em qualquer ponto da faixa da
        // dock nunca remove o app.
        if (drop && pinnedApp && !this._root.contains(drop.targetActor) &&
            !this.pointerInDockRect()) {
            const [x, y] = global.get_pointer();
            poof(x, y, this._geometry.iconSize);
            // Destruir o ator arrastado faz o dnd.js encerrar sem a animação
            // de "voltar para o lugar".
            drop.dropActor?.destroy();
            this.manager.appTracker.unpin(item.app.get_id());
        }
    }

    onDragEnd(item) {
        this.dragging = false;
        this._dragSource = null;
        this._dragDropped = null;
        this._removeDragMonitor();
        if (item && !item.removing)
            item.targetGrowth = 1;
        this._setPlaceholder(-1);
        this.autohide.sync();
    }

    // Arrastes que começam fora da dock (ex.: da grade de apps do GNOME).
    onExternalDragBegin() {
        this._addDragMonitor();
        this.autohide.sync();
    }

    onExternalDragEnd() {
        this._removeDragMonitor();
        this._setPlaceholder(-1);
        this.autohide.sync();
    }

    _addDragMonitor() {
        if (this._dragMonitor)
            return;
        // Um "drag monitor" é avisado de todo movimento durante qualquer
        // arraste, mesmo fora da dock. Usamos para tirar o "buraco" quando
        // o cursor sai da dock e para saber onde o item foi solto.
        this._dragMonitor = {
            dragMotion: event => {
                if (!this._root.contains(event.targetActor))
                    this._setPlaceholder(-1);
                return DND.DragMotionResult.CONTINUE;
            },
            dragDrop: event => {
                this._dragDropped = event;
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _removeDragMonitor() {
        if (!this._dragMonitor)
            return;
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    _pinnedItems() {
        return this._order.filter(item => item instanceof AppIcon && !item.removing &&
            this.manager.appTracker.isPinned(item.app));
    }

    /** Índice (em _order) onde começa a seção de fixados. */
    _pinnedSectionStart() {
        const first = this._pinnedItems()[0];
        if (first)
            return this._order.indexOf(first);
        // Sem fixados: logo depois do botão da grade de apps (se houver).
        return this._order.filter(item => item instanceof ShowAppsItem).length;
    }

    _setPlaceholder(index, sourceItem = null) {
        if (index === this._placeholderIndex)
            return;
        this._placeholderIndex = index;
        this._placeholderSource = sourceItem;
        this._startGrowAnimation();
    }

    /** Chamado pelo dnd.js enquanto algo é arrastado sobre a dock. */
    handleDragOver(source, _dragActor, x, y, _time) {
        const app = source?.app;
        if (!app || !app.get_app_info() || source instanceof WindowItem)
            return DND.DragMotionResult.CONTINUE;

        // Em qual posição, entre os fixados, o app cairia?
        const main = this.axis.main(x, y);
        const pinned = this._pinnedItems().filter(item => item !== source);
        let index = pinned.length;
        for (let i = 0; i < pinned.length; i++) {
            const item = pinned[i];
            if (main < item.baseMain + item.baseLength / 2) {
                index = i;
                break;
            }
        }
        // Converte para índice em _order (o buraco fica antes daquele item).
        let orderIndex;
        if (index < pinned.length)
            orderIndex = this._order.indexOf(pinned[index]);
        else if (pinned.length)
            orderIndex = this._order.indexOf(pinned[pinned.length - 1]) + 1;
        else
            orderIndex = this._pinnedSectionStart();

        this._dropPinnedIndex = index;
        this._setPlaceholder(orderIndex, source);
        return source instanceof DockItem
            ? DND.DragMotionResult.MOVE_DROP
            : DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source, _dragActor, _x, _y, _time) {
        const app = source?.app;
        if (!app || !app.get_app_info() || this._placeholderIndex < 0 ||
            source instanceof WindowItem)
            return false;
        const index = this._dropPinnedIndex ?? -1;
        this._setPlaceholder(-1);
        this.manager.appTracker.pinAt(app.get_id(), index);
        return true;
    }

    // ===================================================================
    // Geometria para o efeito de minimizar
    // ===================================================================

    /** Retângulo do ícone de `item` em repouso, em coordenadas da tela. */
    getItemIconRect(item) {
        const g = this._geometry;
        if (!g || !this._rootPosition)
            return null;
        const [rx, ry] = this._rootPosition;
        const [x, y] = this.axis.toXY(item.layoutMain + g.gap, this._barCross + g.iconCross);
        return {x: rx + x, y: ry + y, width: g.iconSize, height: g.iconSize};
    }

    /** O cursor está na faixa da dock (incluindo a margem até a borda)? */
    pointerInDockRect() {
        const [px, py] = global.get_pointer();
        const {x, y, width, height} = this.dockRect;
        return px >= x && px < x + width && py >= y && py < y + height;
    }

    get dockRect() {
        const [x, y] = this._rootPosition;
        const [w, h] = this._root.get_size();
        return {x, y, width: w, height: h};
    }
}
