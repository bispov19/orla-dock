// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
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
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
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
import {WavebarMusicPill} from './music/wavebarMusicPill.js';
import {StackItem} from './stacks.js';
import {getStyle} from './styles.js';
import {PanelMode} from './panel/panelMode.js';
import {readInfo} from './files.js';
import {backdropPath} from './glassBackdrops.js';
import {glassParams} from './glassMath.js';
import {TaskbarClock} from './taskbarClock.js';
import {accentHex, dockStyle, hexToRgb, pickColor, rgba} from './themes.js';
import {TrashItem} from './trash.js';
import {Axis, Position, Timeout, animationsEnabled} from './utils.js';
import {WindowPreviews} from './windowPreviews.js';

const GROW_MS = 260;
const MOVE_MS = 180;
const EDGE_GAP = 12;
const HUG_MS = 260;          // deslize até a borda (janela maximizada)

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
        // O modo Painel se monta depois que a barra já tem medidas.
        this._panel?.integrate();
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
        // Ao encerrar a sessão, o Shell destrói os atores da tela SEM chamar
        // o disable(). Marcamos a dock como destruída para que trabalho
        // atrasado (filas ociosas) não leia atores que já não existem.
        this._root.connect('destroy', () => {
            this._destroyed = true;
        });

        // _bar: a barra em si (fundo + ícones + fim). Fica separada do _root
        // para poder deslizar até a borda da tela sem mexer no resto (opção
        // "encostar na borda com janela maximizada").
        this._bar = new Clutter.Actor();
        this._root.add_child(this._bar);
        this._hugTarget = null;      // margem "comida" agora (0 = flutuando)
        // Enquanto a barra desliza, o vidro estático e o rótulo acompanham.
        this._bar.connect('notify::translation-x', () => this._onBarMoved());
        this._bar.connect('notify::translation-y', () => this._onBarMoved());

        // O fundo tem duas camadas:
        //   _background  o "envelope" do vidro: um retângulo que só muda de
        //                tamanho quando o layout muda (nunca durante a
        //                ampliação). É nele que fica o efeito de desfoque —
        //                mudar o tamanho de um ator com desfoque obriga o
        //                GNOME a recriar as texturas do blur, e fazer isso a
        //                cada quadro era o que engasgava a ampliação.
        //   _skin        o fundo VISÍVEL (cor, borda, cantos), que acompanha
        //                a onda a cada quadro. Redimensionar só ele é barato;
        //                o shader do vidro recorta o desfoque no mesmo
        //                retângulo (RoundedBlurEffect.setMask).
        this._background = new St.Widget({style_class: 'orla-glass'});
        this._blurEffect = new RoundedBlurEffect();
        this._background.add_effect(this._blurEffect);
        this._bar.add_child(this._background);
        this._envelope = null;       // [início, fim] do envelope, no eixo principal

        this._skin = new St.Widget({
            style_class: 'orla-background',
            reactive: true,
        });
        this._background.add_child(this._skin);

        // Vidro ESTÁTICO: uma imagem do tamanho do monitor, posicionada como
        // se estivesse "atrás" da dock, que o efeito desfoca (modo ACTOR).
        this._staticLayer = new St.Widget({style_class: 'orla-static-glass', visible: false});
        this._background.add_child(this._staticLayer);

        this._itemsLayer = new Clutter.Actor();
        this._bar.add_child(this._itemsLayer);

        // trackFullscreen: esconde a dock quando há janela em tela cheia.
        Main.layoutManager.addChrome(this._root, {trackFullscreen: true});

        // Rótulo com o nome do app (fica no topo de tudo).
        this._tooltip = new St.Label({style_class: 'orla-tooltip', visible: false});
        Main.layoutManager.addTopChrome(this._tooltip);

        // Movimento do mouse. O Clutter só repassa eventos a atores
        // REATIVOS; o _root não é (senão a faixa inteira da borda bloquearia
        // cliques nas janelas). Por isso escutamos o fundo e cada item.
        this._trackPointer(this._skin);
        // Botão direito no fundo da dock: o menu da dock.
        this._skin.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.openDockMenu(this._skin);
            return Clutter.EVENT_STOP;
        });

        this._menuManager = new PopupMenu.PopupMenuManager(this._root);

        // Barras de tarefas: o modo Painel (lib/panel/) e o Menu Iniciar
        // (lib/start/).
        this._panel = null;
        this._startBox = null;      // começo: workspaces e itens da esquerda
        this._endActor = null;      // fim: bandeja, configurações, relógio
        if (this._wantsPanelMerge()) {
            // O monitor principal recebe a barra de cima inteira; os outros
            // ganham só o relógio.
            this._panel = new PanelMode(this,
                this.monitorIndex === Main.layoutManager.primaryIndex);
            this._startBox = this._panel.startBox;
            this._endActor = this._panel.endBox;
            this._bar.add_child(this._startBox);
            this._bar.add_child(this._endActor);
        } else if (this.style.clock && this.settings.get_boolean('taskbar-clock')) {
            this._endActor = new TaskbarClock();
            this._bar.add_child(this._endActor);
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

    /** A barra superior entra na barra de tarefas (modo Painel)? */
    _wantsPanelMerge() {
        return this.style.mergePanel && this.style.fullWidth &&
            this.settings.get_boolean('taskbar-merge-panel') &&
            !Main.sessionMode.isLocked;
    }

    get destroyed() {
        return Boolean(this._destroyed);
    }

    /** O botão Iniciar/aplicativos (o Menu Iniciar abre acima dele). */
    get startButton() {
        return this._items.get('show-apps') ?? null;
    }

    /** O fundo visível da barra (os menus do modo Painel se alinham a ele). */
    get backgroundActor() {
        return this._skin;
    }

    /**
     * Botão Iniciar das barras de tarefas: o Menu Iniciar, se estiver
     * ligado. Devolve false para o botão seguir o normal (grade de apps).
     */
    toggleStartMenu() {
        if (!this.style.fullWidth || !this.settings.get_boolean('start-menu'))
            return false;
        this.manager.toggleStartMenu(this);
        return true;
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
        // PRIMEIRO devolvemos os itens da barra superior: eles moram dentro
        // do _root, e destruir o _root os destruiria junto.
        this._panel?.destroy();
        this._panel = null;
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
        this._skin.set_style(css);

        this._syncGlass(glass, barStyle.roundCorners ? s.get_int('corner-radius') : 0);
        // Vidro ligado/desligado muda o envelope do fundo.
        if (this._geometry && this._baseStart !== undefined)
            this._magnifier.layoutChanged();

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
        this._glassDynamic = enabled && !isStatic;
        this._glassOn = enabled;
        effect.enabled = enabled;
        this._staticLayer.visible = enabled && isStatic;
        this._background.clip_to_allocation = enabled && isStatic;
        if (!enabled)
            return;

        effect.mode = isStatic ? Shell.BlurMode.ACTOR : Shell.BlurMode.BACKGROUND;
        // Os parâmetros vêm da receita única do vidro (lib/glassMath.js),
        // a mesma usada pela prévia nas preferências.
        const params = glassParams(s);
        effect.radius = params.radius;
        effect.brightness = 1.0;
        effect.cornerRadius = radius;
        effect.setGlass(params);

        if (isStatic) {
            const imageStyle = path => `background-image: url("${path}"); background-size: cover;`;
            const preset = backdropPath(this.manager.extensionPath, s.get_string('blur-static-preset'));
            const photo = s.get_string('blur-static-source') === 'custom' ? s.get_string('blur-custom-photo') : '';
            this._staticLayer.set_style(imageStyle(photo || preset));
            // A foto pode ter sido apagada ou movida: confere sem travar e,
            // se ela não existir mais, volta para o fundo pronto.
            if (photo) {
                readInfo(Gio.File.new_for_path(photo), 'standard::type').catch(() => {
                    if (!this._destroyed)
                        this._staticLayer.set_style(imageStyle(preset));
                });
            }
            this._placeStaticLayer();
        }
    }

    /**
     * O vidro DINÂMICO lê a tela atrás da dock. Para economizar, o GNOME
     * redesenha só o pedaço da tela que mudou (ex.: o ícone que quicou).
     * Fora desse pedaço, "atrás da dock" ainda está o quadro ANTERIOR — com
     * a dock e os ícones já desenhados —, e o vidro acabaria desfocando os
     * próprios ícones (a "sombra" e o "quadrado" que ficavam no lugar).
     * Por isso, sempre que algo na dock muda, pedimos o vidro inteiro de
     * novo: aí a área atrás dele é refeita do zero.
     */
    queueGlassRedraw() {
        // Num quadro de ampliação, dezenas de propriedades mudam (escala e
        // translação de cada ícone) e cada uma pedia o vidro de novo. Um
        // pedido por quadro basta: a marca é limpa logo antes do desenho.
        if (!this._glassDynamic || this._destroyed || this._glassQueued)
            return;
        this._glassQueued = true;
        this._background.queue_redraw();
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._glassQueued = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** A imagem estática cobre o monitor; a dock "enxerga" o pedaço dela. */
    _placeStaticLayer() {
        if (!this._staticLayer.visible || !this._rootPosition)
            return;
        const m = this.monitor;
        const [rx, ry] = this._rootPosition;
        this._staticLayer.set_size(m.width, m.height);
        const [bx, by] = this._barShift;
        this._staticLayer.set_position(m.x - rx - this._background.x - bx,
            m.y - ry - this._background.y - by);
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

        const appsButton = s.get_boolean('show-apps-button');
        // Estilo GNOME: o botão de aplicativos vai para o FIM (ver abaixo).
        const appsAtEnd = this.style.appsButtonAtEnd;
        if (appsButton && !appsAtEnd)
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
        // Ordem: Locais → unidades → pastas extras → Lixeira.
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
        const result = [];
        const appsFirst = appsButton && !appsAtEnd;
        // Widget de música (lib/music/), em um de dois lugares (opção):
        //   'apps' (padrão)  no extremo esquerdo (início) da dock, ao lado do
        //                    botão Aplicativos, com uma divisória entre os dois;
        //   'end'            no fim, ao lado da Lixeira, com uma divisória
        //                    entre os dois.
        // Os itens e divisórias mantêm as mesmas chaves nos dois lugares:
        // trocar a opção faz o widget DESLIZAR até o lugar novo.
        const music = this.manager.music;
        const musicShown = Boolean(music?.visible);
        const musicSeps = separators && s.get_boolean('wavebar-music-pill-separators');
        const musicItem = ['music', () => new WavebarMusicPill(this, music)];
        const atEnd = s.get_string('wavebar-music-pill-position') === 'end';
        const musicAtStart = musicShown && !atEnd;
        if (musicAtStart) {
            result.push(musicItem);
            if (musicSeps && first.length + second.length + third.length > 0)
                result.push(['sep:music-a', () => new DockSeparator(this)]);
        }
        // O botão Aplicativos e a divisória dele (como sempre).
        if (appsFirst && separators && s.get_boolean('apps-button-separator') &&
            first.length + second.length > 1) {
            // Divisória entre o botão Aplicativos e os apps (como a que separa
            // as pastas e a Lixeira). Só quando há algum app depois dele.
            result.push(first[0], ['sep:0', () => new DockSeparator(this)], ...first.slice(1));
        } else {
            result.push(...first);
        }
        if (separators && first.length > (appsFirst ? 1 : 0) && second.length)
            result.push(['sep:1', () => new DockSeparator(this)]);
        result.push(...second);
        if (separators && (first.length || second.length) && third.length)
            result.push(['sep:2', () => new DockSeparator(this)]);
        result.push(...third);
        // No fim: depois da Lixeira (e antes do botão Aplicativos, no estilo
        // GNOME, que o põe no fim).
        if (musicShown && atEnd) {
            if (musicSeps && result.length)
                result.push(['sep:music-a', () => new DockSeparator(this)]);
            result.push(musicItem);
        }
        if (appsButton && appsAtEnd) {
            if (separators && result.length && s.get_boolean('apps-button-separator'))
                result.push(['sep:0', () => new DockSeparator(this)]);
            result.push(['show-apps', () => new ShowAppsItem(this)]);
        }
        return result;
    }

    /**
     * Sincroniza os atores com a lista desejada. Itens novos "crescem",
     * itens que saíram "encolhem" e só então são destruídos.
     */
    rebuild({animate = true} = {}) {
        // Ao encerrar a sessão os atores somem antes do disable(); um aviso
        // atrasado (ex.: um app mudou de estado) não pode mexer neles.
        if (this._destroyed)
            return;
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

    /**
     * Reposiciona os itens agora, sem recalcular tamanhos (um item mudando
     * de comprimento a cada quadro, como o widget de música expandindo).
     */
    layoutItemsNow() {
        if (this._destroyed || !this._geometry)
            return;
        this._layoutItems(false);
        this.queueGlassRedraw();
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
        let total = geometry.endPadding * 2 + this._startLength();
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
        // A barra foi para baixo (lib/panelMover.js): o topo é todo da dock.
        // Enquanto ela ainda está descendo, a dock espera no lugar antigo,
        // para não subir por baixo da barra.
        if (Main.panel.has_style_class_name('orla-panel-bottom') && !panelBox.get_transition('translation-y'))
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
        if (this._destroyed)
            return;
        const wanted = this.settings.get_int(this.style.iconSizeKey);
        const available = this.monitorLength - (this.style.fullWidth ? this._endLength() : EDGE_GAP * 2);
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
        this.syncHug();
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
        this._syncTrayStyle();
        this._placeEnd();
    }

    // ===================================================================
    // Encostar na borda quando houver janela maximizada
    // ===================================================================

    /** A opção "encostar na borda" vale para esta dock? */
    get _hugEnabled() {
        const g = this._geometry;
        return Boolean(g) && this.settings.get_boolean('hug-edge-when-maximized') &&
            !this.style.fullWidth && g.margin > 0;
    }

    /**
     * Com uma janela maximizada no monitor, a dock desliza até a borda (a
     * margem some); sem nenhuma, volta a flutuar. Quem desliza é a _bar
     * (fundo + ícones), com uma animação suave; o _root fica parado.
     *
     * A reserva de espaço (strut) NÃO depende disto: com a opção ligada ela
     * já é, o tempo todo, só a espessura da dock (ver strutRect). Assim a
     * janela maximiza direto até a dock, no mesmo instante, em vez de parar
     * na margem e esticar depois que a dock termina de deslizar.
     */
    syncHug() {
        const g = this._geometry;
        if (!g || this._destroyed)
            return;
        const wanted = this._hugEnabled &&
            this.manager.maximizeWatcher.hasMaximized(this.monitorIndex, this.axis.position);
        const target = wanted ? g.margin : 0;
        if (target === this._hugTarget)
            return;
        const first = this._hugTarget === null;
        this._hugTarget = target;
        const prop = this.axis.crossTranslation;
        // Em direção à borda é o contrário de "para longe dela".
        const value = -this.axis.awaySign * target;
        this._bar.remove_transition(prop);
        if (first || !animationsEnabled()) {
            this._bar[prop] = value;
            this.manager.queueIconGeometry();
            return;
        }
        this._bar.ease({
            [prop]: value,
            duration: HUG_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this.manager.queueIconGeometry(),
        });
    }

    _onBarMoved() {
        this._placeStaticLayer();
        this.queueGlassRedraw();
        this._positionTooltip();
    }

    /** Deslocamento atual da barra em direção à borda (x, y). */
    get _barShift() {
        return [this._bar.translation_x, this._bar.translation_y];
    }

    /**
     * Área reservada às janelas. Com "encostar na borda" ligado, é só a
     * espessura da dock (a posição encostada), SEMPRE — mesmo enquanto ela
     * flutua. Só janelas que ocupam a tela até a dock usam essa faixa, e
     * com elas a dock já está encostada; então nada fica escondido.
     */
    get strutRect() {
        const {x, y, width, height} = this._hugStrutRect();
        // O Shell só aceita reserva (strut) que encoste numa borda da tela.
        // A dock superior fica ABAIXO da barra do GNOME, então estendemos a
        // reserva até o topo (a faixa da barra já é reservada mesmo). Sem
        // isso o Shell ignora a reserva e as janelas maximizadas ficam por
        // baixo da dock.
        if (this.axis.position === Position.TOP && y > this.monitor.y) {
            const inset = y - this.monitor.y;
            return {x, y: this.monitor.y, width, height: height + inset};
        }
        return {x, y, width, height};
    }

    _hugStrutRect() {
        const rect = this.dockRect;
        const hug = this._hugEnabled ? this._geometry.margin : 0;
        if (!hug)
            return rect;
        const {x, y, width, height} = rect;
        switch (this.axis.position) {
        case Position.BOTTOM: return {x, y: y + hug, width, height: height - hug};
        case Position.TOP: return {x, y, width, height: height - hug};
        case Position.LEFT: return {x, y, width: width - hug, height};
        default: return {x: x + hug, y, width: width - hug, height};
        }
    }

    /** Espaço reservado no fim da barra de tarefas (relógio ou bandeja). */
    _endLength() {
        if (!this._endActor)
            return 0;
        this._endActor.setVertical?.(this.axis.vertical);
        const [, , w, h] = this._endActor.get_preferred_size();
        return Math.ceil(this.axis.vertical ? h : w) + 12;
    }

    /** Espaço do começo do painel (indicador de workspaces e afins). */
    _startLength() {
        const box = this._startBox;
        if (!box || !this._panel?.hasStartItems())
            return 0;
        const [, , w, h] = box.get_preferred_size();
        return Math.ceil(this.axis.vertical ? h : w) + 8;
    }

    /** As caixas do painel ficam centralizadas na espessura da barra. */
    _syncTrayStyle() {
        if (!this._panel || !this._geometry)
            return;
        const thick = Math.max(24, this._geometry.thickness - 4);
        const css = this.axis.vertical ? `width: ${thick}px;` : `height: ${thick}px;`;
        this._startBox.set_style(css);
        this._endActor.set_style(css);
    }

    _placeEnd() {
        const actor = this._endActor;
        if (!actor)
            return;
        const g = this._geometry;
        const [, , w, h] = actor.get_preferred_size();
        const length = this.axis.vertical ? h : w;
        const thick = this.axis.vertical ? w : h;
        const [x, y] = this.axis.toXY(
            Math.round(this.monitorLength - length - 6),
            Math.round(this._barCross + (g.thickness - thick) / 2));
        actor.set_position(x, y);
        if (actor instanceof TaskbarClock)
            actor.set_style(this.look?.dark === false ? 'color: #1c1c1e;' : 'color: #f2f2f2;');
    }

    /** Põe o começo do painel em `main` (eixo da barra), centralizado. */
    _placeStartBox(main) {
        const g = this._geometry;
        const [, , w, h] = this._startBox.get_preferred_size();
        const thick = this.axis.vertical ? w : h;
        this._startBox.set_position(...this.axis.toXY(Math.round(main + 4),
            Math.round(this._barCross + (g.thickness - thick) / 2)));
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

        // Sem botão de aplicativos, os itens da esquerda da barra superior
        // abrem a barra.
        if (this._startLength() > 0 && !this._items.has('show-apps')) {
            this._placeStartBox(cursor);
            cursor += this._startLength();
        }

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

            // Barra fundida: os itens da esquerda da barra superior (ex.:
            // Atividades) ficam logo depois do botão de aplicativos.
            if (item.key === 'show-apps' && this._startLength() > 0) {
                this._placeStartBox(cursor);
                cursor += this._startLength();
            }
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
        if (this.style.magnification && this._geometry.maxScale > 1.001) {
            const main = this.axis.main(lx, ly);
            // Sobre um item que não amplia (o widget de música expandido), a
            // onda relaxa: senão ela empurraria o item para longe do mouse.
            const still = this._order.find(item => item.magnifies === false && !item.removing &&
                main >= item.baseMain && main <= item.baseMain + item.baseLength);
            if (still)
                this._magnifier.leave();
            else
                this._magnifier.pointerMoved(main);
        }
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
        start = Math.round(start);
        end = Math.round(end);

        // O envelope cobre até onde a onda consegue esticar o fundo (o
        // Magnifier calcula esse alcance a partir das opções). Ele só muda
        // quando o layout ou as opções mudam — nunca a cada quadro.
        const reach = this._glassOn ? this._magnifier.backgroundReach : 0;
        const envStart = Math.min(start, Math.floor(this._baseStart - reach));
        const envEnd = Math.max(end, Math.ceil(this._baseEnd + reach));
        const env = this._envelope;
        if (!env || env[0] !== envStart || env[1] !== envEnd) {
            this._envelope = [envStart, envEnd];
            const [x, y] = this.axis.toXY(envStart, this._barCross);
            const [w, h] = this.axis.toXY(envEnd - envStart, g.thickness);
            this._background.set_position(x, y);
            this._background.set_size(w, h);
            this._placeStaticLayer();
        }

        // O fundo visível, dentro do envelope.
        const [sx, sy] = this.axis.toXY(start - envStart, 0);
        const [sw, sh] = this.axis.toXY(end - start, g.thickness);
        this._skin.set_position(sx, sy);
        this._skin.set_size(sw, sh);
        this._blurEffect.setMask(sx, sy, sw, sh);
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
            this._order.some(item => item.popupOpen) ||
            Boolean(this._panel?.busy || this.manager.startMenuOpenAt(this) || this.manager.musicCardOpenAt(this));
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
        if (!g || !this._rootPosition || this._destroyed)
            return null;
        const [rx, ry] = this._rootPosition;
        const [x, y] = this.axis.toXY(item.layoutMain + g.gap, this._barCross + g.iconCross);
        const [bx, by] = this._barShift;
        return {x: rx + x + bx, y: ry + y + by, width: g.iconSize, height: g.iconSize};
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
