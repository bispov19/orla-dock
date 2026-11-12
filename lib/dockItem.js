// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// dockItem.js — a "célula" base da dock. Ícones de apps, separadores,
// stacks e a lixeira herdam daqui.
//
// Estrutura de atores (o Clutter organiza a tela como uma árvore de atores):
//
//   DockItem (St.Button)          ← recebe clique, hover; tamanho = célula
//   └─ _content (Clutter.Actor)   ← posiciona os filhos livremente
//      ├─ _reflection             ← reflexo opcional do ícone
//      ├─ _iconBin (St.Widget)    ← o ícone + extras (bolinha, progresso)
//      └─ _indicator (St.Widget)  ← o pontinho de "app aberto"
//
// Truque de nitidez: o ícone é renderizado já no tamanho AMPLIADO máximo e
// mostrado reduzido (scale < 1) em repouso. Ao ampliar, a escala volta a 1
// e o ícone continua nítido, em vez de esticar uma imagem pequena.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {bounce} from './animations.js';
import {Position} from './utils.js';

export const DockItem = GObject.registerClass(
class OrlaDockItem extends St.Button {
    _init(dock, params = {}) {
        super._init({
            style_class: 'orla-item',
            reactive: true,
            track_hover: true,
            can_focus: false,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE,
            ...params,
        });
        // O sistema de arrastar e soltar do Shell (dnd.js) procura métodos
        // como acceptDrop() em `actor._delegate`.
        this._delegate = this;
        this.dock = dock;
        this.key = null;           // identificador único na dock
        this.growth = 1;           // 0..1, usado nas animações de entrada/saída
        this.baseMain = 0;         // posição (eixo principal) sem a onda
        this.removing = false;
        this._geometry = null;
        this._binSize = 0;
        this._waveScale = 1;
        this._stopBounce = null;

        this._content = new Clutter.Actor();
        this.set_child(this._content);

        this._iconBin = new St.Widget({style_class: 'orla-icon-bin'});
        this._content.add_child(this._iconBin);

        this._indicator = new St.Widget({style_class: 'orla-indicator', visible: false});
        this._content.add_child(this._indicator);

        // Escurece o ícone enquanto está pressionado, como no Mac.
        this._pressEffect = new Clutter.BrightnessContrastEffect({enabled: false});
        this._pressEffect.set_brightness(-0.25);
        this._iconBin.add_effect(this._pressEffect);
        this.connect('notify::pressed', () => {
            this._pressEffect.enabled = this.pressed;
        });

        this.connect('notify::hover', () => this.dock.onItemHoverChanged(this));
    }

    /** Texto do rótulo (tooltip). Subclasses sobrescrevem. */
    get labelText() {
        return null;
    }

    /** Cria o ator do ícone no tamanho `size`. Subclasses sobrescrevem. */
    createIcon(_size) {
        return null;
    }

    /** Comprimento da célula no eixo principal. */
    cellLength(geometry) {
        return geometry.cellLength;
    }

    get geometry() {
        return this._geometry;
    }

    get iconActor() {
        return this._icon ?? null;
    }

    /** Recria o ícone (ex.: o tema de ícones mudou ou a lixeira encheu). */
    refreshIcon() {
        this._icon?.destroy();
        this._icon = null;
        if (!this._binSize)
            return;
        this._icon = this.createIcon(this._binSize);
        if (this._icon) {
            this._icon.set_size(this._binSize, this._binSize);
            this._iconBin.insert_child_at_index(this._icon, 0);
        }
        this._syncReflection();
    }

    /**
     * Aplica o tamanho/posição dos filhos. Chamado pela dock quando o tamanho
     * dos ícones, a posição ou a ampliação mudam.
     */
    applyGeometry(geometry) {
        const g = this._geometry = geometry;
        const {axis} = g;
        const binSize = Math.round(g.iconSize * g.maxScale);
        if (binSize !== this._binSize) {
            this._binSize = binSize;
            this._iconBin.set_size(binSize, binSize);
            this.refreshIcon();
            this.onBinSizeChanged(binSize);
        }

        // Posiciona o _iconBin: centralizado no eixo principal e com o lado
        // da borda alinhado ao ícone. Depois reduz pela escala de repouso.
        const iconMain = g.gap + g.iconSize / 2 - binSize / 2;
        const iconCross = axis.edgeAtEnd ? g.padding + g.iconSize - binSize : g.padding;
        const [x, y] = axis.toXY(iconMain, iconCross);
        this._iconBin.set_position(x, y);
        const [px, py] = axis.edgePivot;
        this._iconBin.set_pivot_point(px, py);
        this._restScale = g.iconSize / binSize;
        this._applyScale();

        // Indicador: no espaço entre o ícone e a borda da tela.
        const dot = g.indicatorSize;
        const dotMain = g.gap + g.iconSize / 2 - dot / 2;
        const dotCross = axis.edgeAtEnd
            ? g.thickness - g.padding / 2 - dot / 2
            : g.padding / 2 - dot / 2;
        const [dx, dy] = axis.toXY(dotMain, dotCross);
        this._indicator.set_position(Math.round(dx), Math.round(dy));
        this._indicator.set_size(dot, dot);
        this._indicator.set_style(`border-radius: ${dot}px;`);

        this._syncReflection();
    }

    /** Gancho para subclasses ajustarem extras (bolinha, progresso). */
    onBinSizeChanged(_binSize) {
    }

    /** Recebe o resultado da onda de ampliação. Não causa relayout. */
    setWave(scale, offset) {
        this._waveScale = scale;
        this[this._geometry.axis.mainTranslation] = offset;
        this._applyScale();
    }

    _applyScale() {
        const s = (this._restScale ?? 1) * this._waveScale;
        this._iconBin.set_scale(s, s);
        this._reflectionClone?.set_scale(s, -s);
    }

    /** Escala visual atual do ícone (1 = tamanho normal). */
    get waveScale() {
        return this._waveScale;
    }

    setIndicatorVisible(visible) {
        this._indicator.visible = visible;
    }

    // ---------- Reflexo ----------

    _syncReflection() {
        const g = this._geometry;
        // Como no macOS, o reflexo só existe na dock inferior: é o "chão".
        const wanted = g?.reflection && g.axis.position === Position.BOTTOM && this._icon;
        if (!wanted) {
            this._reflection?.destroy();
            this._reflection = null;
            this._reflectionClone = null;
            return;
        }
        if (!this._reflection) {
            // Um Clutter.Clone desenha outro ator (o _iconBin) sem duplicar a
            // textura. Com escala Y negativa ele fica de cabeça para baixo e
            // vira o reflexo. O contêiner com clip_to_allocation corta o que
            // passar da área entre o ícone e a borda da dock.
            this._reflection = new Clutter.Actor({clip_to_allocation: true, opacity: 60});
            this._reflectionClone = new Clutter.Clone({source: this._iconBin});
            this._reflection.add_child(this._reflectionClone);
            this._content.insert_child_at_index(this._reflection, 0);
        }
        this._reflection.set_position(0, g.padding + g.iconSize);
        this._reflection.set_size(g.cellLength, g.padding);
        // O clone fica logo ACIMA do contêiner e gira em torno da própria
        // base: invertido, ele "desce" para dentro da área visível.
        this._reflectionClone.set_position(g.gap + g.iconSize / 2 - this._binSize / 2, -this._binSize);
        this._reflectionClone.set_pivot_point(0.5, 1);
        this._applyScale();
    }

    // ---------- Animações ----------

    bounce(params) {
        this.stopBounce();
        this._stopBounce = bounce(this._iconBin, this._geometry.axis, {
            ...params,
            onComplete: () => {
                this._stopBounce = null;
                params.onComplete?.();
            },
        });
    }

    stopBounce() {
        this._stopBounce?.();
        this._stopBounce = null;
    }

    get bouncing() {
        return this._stopBounce !== null;
    }

    /** Retângulo do ícone em repouso, em coordenadas da tela. */
    getRestIconRect() {
        return this.dock.getItemIconRect(this);
    }

    vfunc_scroll_event(event) {
        this.onScroll?.(event);
        return Clutter.EVENT_STOP;
    }

    destroy() {
        this.stopBounce();
        super.destroy();
    }
});

/**
 * Separador entre seções. Também é a "divisória" do Mac: arrastar com o
 * mouse redimensiona a dock (ver dock.js → resize).
 */
export const DockSeparator = GObject.registerClass(
class OrlaDockSeparator extends DockItem {
    _init(dock) {
        super._init(dock, {style_class: 'orla-separator-item', button_mask: 0});
        this._line = new St.Widget({style_class: 'orla-separator'});
        this._content.add_child(this._line);
        this._resizeStart = null;
        this._grab = null;
    }

    cellLength(geometry) {
        return Math.round(geometry.iconSize * 0.36);
    }

    applyGeometry(geometry) {
        this._geometry = geometry;
        const {axis} = geometry;
        const length = this.cellLength(geometry);
        const lineLength = Math.round(geometry.iconSize * 0.8);
        const [w, h] = axis.toXY(1, lineLength);
        this._line.set_size(w, h);
        const [x, y] = axis.toXY(Math.round(length / 2), (geometry.thickness - lineLength) / 2);
        this._line.set_position(x, y);
        // cursor_type (GNOME 50+): o cursor que aparece sobre este ator.
        this.cursor_type = axis.vertical
            ? Clutter.CursorType.EW_RESIZE
            : Clutter.CursorType.NS_RESIZE;
    }

    setWave(_scale, offset) {
        this[this._geometry.axis.mainTranslation] = offset;
    }

    // Redimensionar arrastando: ao pressionar, "agarramos" os eventos do
    // mouse (global.stage.grab) para continuar recebendo-os mesmo se o
    // cursor sair do separador.
    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._resizeStart = {
            cross: this._geometry.axis.cross(x, y),
            size: this.dock.settings.get_int('icon-size'),
        };
        this._grab = global.stage.grab(this);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._resizeStart)
            return Clutter.EVENT_PROPAGATE;
        const {axis} = this._geometry;
        const [x, y] = event.get_coords();
        // Afastar da borda = aumentar. awaySign converte a direção.
        const delta = (axis.cross(x, y) - this._resizeStart.cross) * axis.awaySign;
        const size = Math.round(Math.min(128, Math.max(24, this._resizeStart.size + delta)));
        if (size !== this.dock.settings.get_int('icon-size'))
            this.dock.settings.set_int('icon-size', size);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(_event) {
        if (!this._resizeStart)
            return Clutter.EVENT_PROPAGATE;
        this._endResize();
        return Clutter.EVENT_STOP;
    }

    _endResize() {
        this._resizeStart = null;
        this._grab?.dismiss();
        this._grab = null;
    }

    destroy() {
        this._endResize();
        super.destroy();
    }
});
