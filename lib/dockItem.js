// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// dockItem.js — a "célula" base da dock. Ícones de apps, separadores,
// stacks e a lixeira herdam daqui.
//
// Estrutura de atores (o Clutter organiza a tela como uma árvore de atores):
//
//   DockItem (St.Button)            ← recebe clique, hover; tamanho = célula
//   └─ _content (Clutter.Actor)     ← posiciona os filhos livremente
//      ├─ _cellBg (St.Widget)       ← destaque da célula (barra de tarefas)
//      ├─ _reflection               ← reflexo opcional do ícone
//      ├─ _riseBox (Clutter.Actor)  ← "elevação" do ícone ampliado
//      │  └─ _iconBin (St.Widget)   ← o ícone + extras (bolinha, progresso)
//      └─ _indicator (Clutter.Actor)← pontinho(s)/traço de "app aberto"
//
// Geometria no eixo cruzado (ex.: dock inferior, de cima para baixo):
//
//   farPad   (espaço do lado de dentro da tela)
//   ícone    (iconSize)
//   edgePad  (espaço do lado da borda — é onde fica o indicador)
//
// O edgePad é maior que o farPad justamente para o indicador caber INTEIRO
// dentro da dock, com folga dos dois lados.
//
// Truque de nitidez: o ícone é renderizado já no tamanho AMPLIADO máximo e
// mostrado reduzido (scale < 1) em repouso. Ao ampliar, a escala volta a 1
// e o ícone continua nítido, em vez de esticar uma imagem pequena.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {bounce} from './animations.js';
import {Position} from './utils.js';

const MAX_DOTS = 3;

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
        this._indicatorCount = 0;
        this._focused = false;
        this._attentionHighlight = false;

        this._content = new Clutter.Actor();
        this.set_child(this._content);

        this._cellBg = new St.Widget({style_class: 'orla-cell-bg', visible: false});
        this._content.add_child(this._cellBg);

        // _riseBox: só serve para "elevar" o ícone ampliado (opção
        // Elevação). Fica separado do _iconBin porque o quique anima a
        // translação do _iconBin, e as duas coisas não podem brigar.
        this._riseBox = new Clutter.Actor();
        this._content.add_child(this._riseBox);
        this._iconBin = new St.Widget({style_class: 'orla-icon-bin'});
        this._riseBox.add_child(this._iconBin);

        this._indicator = new Clutter.Actor({visible: false});
        this._content.add_child(this._indicator);

        // Escurece o ícone enquanto está pressionado, como no Mac.
        this._pressEffect = new Clutter.BrightnessContrastEffect({enabled: false});
        this._pressEffect.set_brightness(-0.25);
        this._iconBin.add_effect(this._pressEffect);
        this.connect('notify::pressed', () => {
            this._pressEffect.enabled = this.pressed;
        });

        this.connect('notify::hover', () => {
            this._syncCellBg();
            this.dock.onItemHoverChanged(this);
        });
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
        const binCross = axis.edgeAtEnd ? g.iconCross + g.iconSize - binSize : g.iconCross;
        const [x, y] = axis.toXY(iconMain, binCross);
        this._iconBin.set_position(x, y);
        const [px, py] = axis.edgePivot;
        this._iconBin.set_pivot_point(px, py);
        this._restScale = g.iconSize / binSize;
        this._applyScale();

        const [cw, ch] = axis.toXY(this.cellLength(g), g.thickness);
        this._indicator.set_size(cw, ch);

        this.syncAppearance();
        this._syncReflection();
    }

    /** Reaplica cores/estilos (indicador, destaque). Subclasses estendem. */
    syncAppearance() {
        if (!this._geometry)
            return;
        this._layoutIndicator();
        this._syncCellBg();
    }

    /** Gancho para subclasses ajustarem extras (bolinha, progresso). */
    onBinSizeChanged(_binSize) {
    }

    /**
     * Recebe o resultado da onda de ampliação: escala, deslocamento no eixo
     * principal e elevação (px). Não causa relayout, só redesenho.
     */
    setWave(scale, offset, lift = 0) {
        const {axis} = this._geometry;
        this._waveScale = scale;
        this[axis.mainTranslation] = offset;
        this._riseBox[axis.crossTranslation] = axis.awaySign * lift;
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

    // ---------- Indicador de "app aberto" ----------

    /** 0 esconde; 1+ = quantas janelas (o estilo "Janelas" mostra até 3). */
    setIndicatorCount(count) {
        if (count === this._indicatorCount)
            return;
        this._indicatorCount = count;
        if (this._geometry)
            this._layoutIndicator();
    }

    setIndicatorVisible(visible) {
        this.setIndicatorCount(visible ? Math.max(1, this._indicatorCount) : 0);
    }

    _layoutIndicator() {
        const g = this._geometry;
        const look = this.dock.look?.indicator;
        const count = look?.enabled ? this._indicatorCount : 0;
        this._indicator.visible = count > 0;
        if (!count)
            return;
        const {axis} = g;
        const size = look.size;

        // Formato: comprimento (eixo principal) × espessura (eixo cruzado).
        let length, thick, radius, dots = 1;
        if (g.edgeIndicator) {
            // Estilo barra de tarefas: um traço sob a célula inteira, colado na borda.
            length = this.cellLength(g) - 8;
            thick = Math.max(2, Math.round(size * 0.6));
            radius = 1;
        } else {
            switch (look.style) {
            case 'dash':
                length = Math.max(10, Math.round(size * 2.6));
                thick = Math.max(2, Math.round(size * 0.75));
                radius = thick;
                break;
            case 'line':
                length = Math.round(g.iconSize * 0.6);
                thick = Math.max(2, Math.round(size * 0.6));
                radius = thick;
                break;
            case 'square':
                length = thick = size;
                radius = 1;
                break;
            case 'windows':
                length = thick = size;
                radius = size;
                dots = Math.min(MAX_DOTS, count);
                break;
            default:   // 'dot'
                length = thick = size;
                radius = size;
            }
        }

        while (this._indicator.get_n_children() < dots)
            this._indicator.add_child(new St.Widget({style_class: 'orla-indicator'}));
        const children = this._indicator.get_children();
        const gapBetween = Math.max(2, Math.round(size * 0.7));
        const total = dots * length + (dots - 1) * gapBetween;
        const centerMain = g.edgeIndicator ? this.cellLength(g) / 2 : g.gap + g.iconSize / 2;
        // No meio do espaço da borda (ou colado nela, na barra de tarefas).
        const crossStart = g.edgeIndicator
            ? (axis.edgeAtEnd ? g.thickness - thick : 0)
            : (axis.edgeAtEnd ? g.thickness - g.edgePad / 2 : g.edgePad / 2) - thick / 2;
        const style = `background-color: ${look.color}; border-radius: ${radius}px;` +
            (look.glow ? ` box-shadow: 0 0 6px ${look.color};` : '');

        children.forEach((child, i) => {
            child.visible = i < dots;
            if (!child.visible)
                return;
            const main = centerMain - total / 2 + i * (length + gapBetween);
            const [x, y] = axis.toXY(Math.round(main), Math.round(crossStart));
            const [w, h] = axis.toXY(length, thick);
            child.set_position(x, y);
            child.set_size(w, h);
            child.set_style(style);
        });
    }

    // ---------- Destaque da célula (modo barra de tarefas) ----------

    setFocused(focused) {
        if (focused === this._focused)
            return;
        this._focused = focused;
        this._syncCellBg();
    }

    setAttention(attention) {
        if (attention === this._attentionHighlight)
            return;
        this._attentionHighlight = attention;
        this._syncCellBg();
    }

    _syncCellBg() {
        const g = this._geometry;
        const look = this.dock.look;
        if (!g?.cellHighlight || !look) {
            this._cellBg.visible = false;
            return;
        }
        let color = null;
        if (this._attentionHighlight)
            color = look.attentionColor;
        else if (this._focused)
            color = look.focusColor;
        else if (this.hover)
            color = look.hoverColor;
        this._cellBg.visible = color !== null;
        if (!color)
            return;
        const [w, h] = g.axis.toXY(this.cellLength(g) - 2, g.thickness - 2);
        this._cellBg.set_position(1, 1);
        this._cellBg.set_size(w, h);
        this._cellBg.set_style(`background-color: ${color}; border-radius: 3px;`);
    }

    // ---------- Reflexo ----------

    _syncReflection() {
        const g = this._geometry;
        // Como no macOS, o reflexo só existe na dock inferior: é o "chão".
        const wanted = g?.reflection &&
            g.axis.position === Position.BOTTOM && this._icon;
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
            this._content.insert_child_at_index(this._reflection, 1);
        }
        this._reflection.set_position(0, g.iconCross + g.iconSize);
        this._reflection.set_size(g.cellLength, g.edgePad);
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
 * mouse redimensiona a dock.
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
        this.syncAppearance();
        // cursor_type (GNOME 50+): o cursor que aparece sobre este ator.
        this.cursor_type = geometry.axis.vertical
            ? Clutter.CursorType.EW_RESIZE
            : Clutter.CursorType.NS_RESIZE;
    }

    syncAppearance() {
        const g = this._geometry;
        const look = this.dock.look?.separator;
        if (!g || !look)
            return;
        const {axis} = g;
        this._line.visible = look.thickness > 0;
        const length = this.cellLength(g);
        const lineLength = Math.round(g.iconSize * look.length);
        const [w, h] = axis.toXY(look.thickness, lineLength);
        this._line.set_size(w, h);
        // Centralizado na altura do ÍCONE (não da dock inteira).
        const center = g.iconCross + g.iconSize / 2;
        const [x, y] = axis.toXY(Math.round((length - look.thickness) / 2), Math.round(center - lineLength / 2));
        this._line.set_position(x, y);
        this._line.set_style(`background-color: ${look.color};`);
    }

    setWave(_scale, offset, _lift) {
        this[this._geometry.axis.mainTranslation] = offset;
    }

    // Redimensionar arrastando: ao pressionar, "agarramos" os eventos do
    // mouse (global.stage.grab) para continuar recebendo-os mesmo se o
    // cursor sair do separador.
    vfunc_button_press_event(event) {
        // Botão direito na divisória: o menu da dock (como no macOS).
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this.dock.openDockMenu(this);
            return Clutter.EVENT_STOP;
        }
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
