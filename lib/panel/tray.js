// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// panel/tray.js — a bandeja do modo Painel: os indicadores de outras
// extensões (AppIndicator, clima, área de transferência…).
//
// Cada indicador do painel do GNOME cai num de dois lugares:
//   - na BARRA, ao lado do relógio;
//   - na BANDEJA, um menu que abre na seta (^) do fim da barra.
// Por padrão, os indicadores que são só um ícone vão para a bandeja e os
// que têm texto ficam na barra. No modo "Gerenciar" da bandeja dá para
// trocar cada um de lugar e mudar a ordem; as escolhas ficam salvas:
//   tray-panel-indicators  ícones fixados na barra
//   tray-wide-indicators   indicadores com texto mandados para a bandeja
//   panel-applet-order     ordem na barra
//   tray-order             ordem na bandeja
//
// Como no relógio, os indicadores são MOVIDOS (não copiados): o menu de
// cada um continua sendo o dele. O PanelSlot devolve tudo no fim.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RoundedBlurEffect} from '../blur.js';
import {glassParams} from '../glassMath.js';
import {IdleRunner} from '../utils.js';
import {PanelSlot} from './panelSlot.js';

// Partes do próprio GNOME que o modo Painel trata à parte (ou esconde).
const SYSTEM = new Set([
    'activities', 'appMenu', 'dateMenu', 'quickSettings', 'a11y', 'keyboard',
    'dwellClick', 'screenRecording', 'screenSharing', 'screenShield',
]);

const PINNED_TO_BAR = 'tray-panel-indicators';
const SENT_TO_TRAY = 'tray-wide-indicators';
const BAR_ORDER = 'panel-applet-order';
const TRAY_ORDER = 'tray-order';
const GAP = 8;

/** O indicador mostra algum texto (não é só um ícone)? */
function hasText(actor) {
    if (!actor.visible)
        return false;
    if (actor instanceof St.Label)
        return actor.text.trim().length > 0;
    return actor.get_children().some(hasText);
}

/**
 * Um nome para mostrar no "Gerenciar": o nome acessível do indicador ou,
 * sem ele, o id da extensão em palavras ("clipboard-indicator@x" →
 * "Clipboard Indicator").
 */
function displayName(id, indicator) {
    if (indicator.accessible_name)
        return indicator.accessible_name;
    const [local] = id.split('@');
    const words = local.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.map(w => w[0].toLocaleUpperCase() + w.slice(1)).join(' ') || id;
}

/** Ordena `items` (com .name) pela lista salva; os novos vão para o fim. */
function sortBy(items, order) {
    const rank = name => {
        const i = order.indexOf(name);
        return i < 0 ? order.length : i;
    };
    return items.sort((a, b) => rank(a.name) - rank(b.name));
}

export class PanelTray {
    /**
     * @param {object} dock - a dock da Orla
     * @param {object} options
     * @param {Function} options.onResize - avisa a barra que o tamanho mudou
     */
    constructor(dock, {onResize}) {
        this._dock = dock;
        this._settings = dock.settings;
        this._onResize = onResize;
        this._slot = null;
        this._popup = null;
        this._resync = new IdleRunner(() => this._rebuild());

        // Indicadores que ficam no começo da barra (vieram da esquerda do
        // painel do GNOME) e os do fim, antes do relógio.
        const zone = () => new St.BoxLayout({
            style_class: 'orla-tray-zone',
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.startBox = zone();
        this.endBox = zone();

        this._arrow = new St.Button({
            style_class: 'panel-button orla-tray-arrow',
            can_focus: false,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({style_class: 'system-status-icon'}),
        });
        this._arrow.connect('clicked', () => this.toggle());

        // Extensões ligando/desligando e indicadores entrando/saindo do
        // painel mudam a lista: refazemos tudo (uma vez só, na fila ociosa).
        // Os movimentos feitos pela PRÓPRIA bandeja também geram esses
        // avisos; eles são ignorados (`_moving`), senão a bandeja se
        // refaria sem parar.
        this._moving = false;
        const queue = () => {
            if (!this._moving)
                this._resync.queue();
        };
        Main.extensionManager.connectObject('extension-state-changed', queue, this);
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
            box.connectObject('child-added', queue, 'child-removed', queue, this);
        this._settings.connectObject(
            `changed::${PINNED_TO_BAR}`, queue,
            `changed::${SENT_TO_TRAY}`, queue,
            `changed::${BAR_ORDER}`, queue,
            `changed::${TRAY_ORDER}`, queue,
            this);
    }

    get _side() {
        return [St.Side.BOTTOM, St.Side.TOP, St.Side.LEFT, St.Side.RIGHT][this._dock.axis.position];
    }

    get _vertical() {
        return this._dock.axis.vertical;
    }

    /** Os indicadores de outras extensões, separados em barra e bandeja. */
    classify() {
        const pinned = new Set(this._settings.get_strv(PINNED_TO_BAR));
        const wide = new Set(this._settings.get_strv(SENT_TO_TRAY));
        const panel = [], tray = [];
        for (const [name, indicator] of Object.entries(Main.panel.statusArea)) {
            if (SYSTEM.has(name) || !indicator?.container || !indicator.visible)
                continue;
            const iconOnly = !hasText(indicator.container);
            const item = {
                name, indicator, iconOnly,
                title: displayName(name, indicator),
                fromLeft: indicator.container.get_parent() === Main.panel._leftBox,
            };
            const inTray = iconOnly ? !pinned.has(name) : wide.has(name);
            (inTray ? tray : panel).push(item);
        }
        return {
            panel: sortBy(panel, this._settings.get_strv(BAR_ORDER)),
            tray: sortBy(tray, this._settings.get_strv(TRAY_ORDER)),
        };
    }

    /** Monta a barra: indicadores da barra + a seta (se a bandeja tiver algo). */
    build() {
        this._moving = true;
        try {
            this._build();
        } finally {
            this._moving = false;
        }
    }

    _build() {
        this._release();
        const slot = this._slot = new PanelSlot();
        const {panel, tray} = this.classify();
        const side = this._side;
        const vertical = this._vertical;
        for (const box of [this.startBox, this.endBox]) {
            box.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        }

        for (const item of panel) {
            const button = item.indicator;
            slot.set(button, {
                style: vertical ? 'padding: 6px 4px; border-radius: 8px;' : 'padding: 0 6px; border-radius: 8px;',
            });
            this._pointMenu(slot, item.indicator, side);
            slot.move(item.indicator.container, item.fromLeft ? this.startBox : this.endBox);
        }
        this._trayItems = tray;
        this._syncArrow(false);
        if (tray.length)
            this.endBox.add_child(this._arrow);
        this.startBox.visible = this.startBox.get_n_children() > 0;
        this._onResize();
    }

    /** O menu do indicador abre em direção à barra. */
    _pointMenu(slot, indicator, side) {
        const pointer = indicator.menu?._boxPointer;
        if (!pointer?.updateArrowSide)
            return;
        const original = pointer._arrowSide;
        pointer.updateArrowSide(side);
        slot.watch(pointer);
        (this._arrows ??= []).push([pointer, original]);
    }

    _syncArrow(open) {
        const vertical = this._vertical;
        const towardScreen = {
            [St.Side.BOTTOM]: ['pan-up-symbolic', 'pan-down-symbolic'],
            [St.Side.TOP]: ['pan-down-symbolic', 'pan-up-symbolic'],
            [St.Side.LEFT]: ['pan-end-symbolic', 'pan-start-symbolic'],
            [St.Side.RIGHT]: ['pan-start-symbolic', 'pan-end-symbolic'],
        }[this._side];
        this._arrow.child.icon_name = towardScreen[open ? 1 : 0];
        this._arrow.style = vertical ? 'padding: 6px 4px; border-radius: 8px;' : 'padding: 0 4px; border-radius: 8px;';
        if (open)
            this._arrow.add_style_pseudo_class('checked');
        else
            this._arrow.remove_style_pseudo_class('checked');
    }

    _rebuild() {
        const wasOpen = Boolean(this._popup);
        this.close();
        this.build();
        if (wasOpen && this._trayItems.length)
            this.open();
    }

    // ---------- O menu da bandeja ----------

    get isOpen() {
        return Boolean(this._popup);
    }

    /** Algum menu da bandeja ou dos indicadores está aberto? */
    get busy() {
        if (this._popup)
            return true;
        return Object.values(Main.panel.statusArea).some(indicator => indicator?.menu?.isOpen);
    }

    toggle() {
        if (this._popup)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._popup)
            return;
        this._popup = new TrayPopup(this, this._dock);
        this._popup.connect('destroy', () => {
            this._popup = null;
            this._syncArrow(false);
            this._dock.autohide?.sync();
        });
        this._popup.show(this._arrow);
        this._syncArrow(true);
        this._dock.autohide?.show?.();
    }

    close() {
        this._popup?.destroy();
    }

    // ---------- Ações do modo "Gerenciar" ----------

    _toggleName(key, name, on) {
        const list = this._settings.get_strv(key).filter(n => n !== name);
        if (on)
            list.push(name);
        this._settings.set_strv(key, list);
    }

    /** Leva um indicador da bandeja para a barra, ou o contrário. */
    moveToPanel(item, toPanel) {
        if (item.iconOnly)
            this._toggleName(PINNED_TO_BAR, item.name, toPanel);
        else
            this._toggleName(SENT_TO_TRAY, item.name, !toPanel);
    }

    /** Sobe (−1) ou desce (+1) um indicador na sua lista. */
    move(item, inTray, step) {
        const {panel, tray} = this.classify();
        const list = (inTray ? tray : panel).map(i => i.name);
        const from = list.indexOf(item.name);
        const to = from + step;
        if (from < 0 || to < 0 || to >= list.length)
            return;
        [list[from], list[to]] = [list[to], list[from]];
        this._settings.set_strv(inTray ? TRAY_ORDER : BAR_ORDER, list);
    }

    resetChoices() {
        for (const key of [PINNED_TO_BAR, SENT_TO_TRAY, BAR_ORDER, TRAY_ORDER])
            this._settings.reset(key);
    }

    // ---------- Fim ----------

    _release() {
        for (const [pointer, original] of this._arrows ?? []) {
            if (this._slot?.alive(pointer))
                pointer.updateArrowSide(original);
        }
        this._arrows = [];
        this._arrow.get_parent()?.remove_child(this._arrow);
        this._slot?.restore();
        this._slot = null;
    }

    /** Movimentos de indicadores feitos por nós (ver `_moving`). */
    withMoves(fn) {
        const was = this._moving;
        this._moving = true;
        try {
            return fn();
        } finally {
            this._moving = was;
        }
    }

    destroy() {
        this._resync.cancel();
        this._moving = true;
        this.close();
        Main.extensionManager.disconnectObject(this);
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
            box.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._release();
        this._arrow.destroy();
        this.startBox.destroy();
        this.endBox.destroy();
    }
}

/**
 * O menu da bandeja: uma "bolha" perto da seta com os ícones em grade
 * (os indicadores de verdade, que continuam abrindo o próprio menu). No
 * modo "Gerenciar", vira duas listas (Na bandeja / Na barra) com botões
 * para trocar de lugar e mudar a ordem.
 */
const TrayPopup = GObject.registerClass(
class OrlaTrayPopup extends St.BoxLayout {
    _init(tray, dock) {
        const dark = dock.look?.dark !== false;
        super._init({
            style_class: `orla-tray ${dark ? 'orla-dark' : 'orla-light'}`,
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._tray = tray;
        this._dock = dock;
        this._managing = false;
        this._slot = new PanelSlot();
        this._applyLook();
        Main.layoutManager.addTopChrome(this);

        // Clique fora fecha (mas não enquanto o menu de um ícone estiver
        // aberto: ele pertence a um ícone que está aqui dentro).
        this._stageHandler = global.stage.connect('captured-event', (_s, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords());
            const inside = this.contains(target) || tray._arrow.contains(target);
            const menuOpen = tray._trayItems.some(item => item.indicator.menu?.isOpen);
            if (!inside && !menuOpen)
                this.destroy();
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => {
            global.stage.disconnect(this._stageHandler);
            tray.withMoves(() => this._slot.restore());
        });
    }

    /** Fundo: o mesmo das Stacks e rótulos, ou o Vidro da Orla. */
    _applyLook() {
        const settings = this._dock.settings;
        if (settings.get_boolean('blur-enabled')) {
            const glass = new RoundedBlurEffect({cornerRadius: 14});
            const params = glassParams(settings);
            glass.radius = params.radius;
            glass.setGlass(params);
            this.add_effect(glass);
            this.set_style('background-color: transparent;');
        } else {
            this.set_style(this._dock.look?.popupCss ?? '');
        }
    }

    show(anchor) {
        this._anchor = anchor;
        this._build();
        this.opacity = 0;
        this._place();
        this.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _build() {
        this._tray.withMoves(() => this._fill());
        this._place();
    }

    _fill() {
        this._slot.restore();
        this.destroy_all_children();
        this.add_child(this._header());
        if (this._managing)
            this._buildManager();
        else
            this._buildGrid();
    }

    _header() {
        const header = new St.BoxLayout({style_class: 'orla-tray-header'});
        header.add_child(new St.Label({
            text: this._managing ? _('Manage tray') : _('Tray'),
            style_class: 'orla-tray-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const button = new St.Button({
            style_class: 'orla-tray-action',
            can_focus: true,
            label: this._managing ? _('Done') : _('Manage'),
        });
        button.connect('clicked', () => {
            this._managing = !this._managing;
            this._build();
        });
        header.add_child(button);
        return header;
    }

    _buildGrid() {
        const items = this._tray._trayItems;
        if (!items.length) {
            this.add_child(new St.Label({text: _('No icons in the tray'), style_class: 'orla-tray-empty'}));
            return;
        }
        const side = this._tray._side;
        const icons = items.filter(item => item.iconOnly);
        const rows = items.filter(item => !item.iconOnly);
        const perRow = 4;
        let row = null;
        icons.forEach((item, i) => {
            if (i % perRow === 0) {
                row = new St.BoxLayout({style_class: 'orla-tray-grid'});
                this.add_child(row);
            }
            row.add_child(this._adopt(item, side, 'orla-tray-cell'));
        });
        for (const item of rows)
            this.add_child(this._adopt(item, side, 'orla-tray-wide'));
    }

    /** Põe o indicador de verdade dentro de uma célula da bandeja. */
    _adopt(item, side, styleClass) {
        const cell = new St.Bin({style_class: styleClass, x_expand: styleClass === 'orla-tray-wide'});
        const pointer = item.indicator.menu?._boxPointer;
        if (pointer?.updateArrowSide) {
            this._slot.watch(pointer);
            const original = pointer._arrowSide;
            pointer.updateArrowSide(side);
            this.connect('destroy', () => {
                if (this._slot.alive(pointer))
                    pointer.updateArrowSide(original);
            });
        }
        this._slot.set(item.indicator, {style: 'padding: 6px; border-radius: 8px;'});
        this._slot.move(item.indicator.container, cell);
        return cell;
    }

    _buildManager() {
        const {panel, tray} = this._tray.classify();
        this.add_child(this._section(_('In the tray'), tray, true));
        this.add_child(this._section(_('On the bar'), panel, false));
        const footer = new St.BoxLayout({style_class: 'orla-tray-footer'});
        footer.add_child(new St.Label({
            text: _('Choices are saved'),
            style_class: 'orla-tray-note',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const reset = new St.Button({style_class: 'orla-tray-action', label: _('Reset'), can_focus: true});
        reset.connect('clicked', () => this._tray.resetChoices());
        footer.add_child(reset);
        this.add_child(footer);
    }

    _section(title, items, inTray) {
        const box = new St.BoxLayout({style_class: 'orla-tray-section', orientation: Clutter.Orientation.VERTICAL});
        box.add_child(new St.Label({text: title, style_class: 'orla-tray-section-title'}));
        if (!items.length)
            box.add_child(new St.Label({text: _('Nothing here'), style_class: 'orla-tray-empty'}));
        items.forEach((item, i) => {
            const row = new St.BoxLayout({style_class: 'orla-tray-row'});
            row.add_child(new St.Label({text: item.title, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(this._iconButton('go-up-symbolic', _('Move up'), i > 0,
                () => this._tray.move(item, inTray, -1)));
            row.add_child(this._iconButton('go-down-symbolic', _('Move down'), i < items.length - 1,
                () => this._tray.move(item, inTray, 1)));
            row.add_child(inTray
                ? this._iconButton('view-pin-symbolic', _('Show on the bar'), true, () => this._tray.moveToPanel(item, true))
                : this._iconButton('go-bottom-symbolic', _('Move to the tray'), true, () => this._tray.moveToPanel(item, false)));
            box.add_child(row);
        });
        return box;
    }

    _iconButton(icon, name, enabled, action) {
        const button = new St.Button({
            style_class: 'orla-tray-icon-button',
            child: new St.Icon({icon_name: icon, icon_size: 14}),
            accessible_name: name,
            reactive: enabled,
            can_focus: enabled,
            opacity: enabled ? 255 : 90,
        });
        button.connect('clicked', action);
        return button;
    }

    /** Perto da seta, do lado da tela, sem sair do monitor. */
    _place() {
        const anchor = this._anchor;
        if (!anchor)
            return;
        const monitor = this._dock.monitor;
        const [, , width, height] = this.get_preferred_size();
        const [ax, ay] = anchor.get_transformed_position();
        const [aw, ah] = anchor.get_transformed_size();
        const [bx, by] = this._dock.backgroundActor.get_transformed_position();
        const [bw, bh] = this._dock.backgroundActor.get_transformed_size();
        let x, y;
        switch (this._tray._side) {
        case St.Side.TOP:
            x = ax + aw / 2 - width / 2;
            y = by + bh + GAP;
            break;
        case St.Side.LEFT:
            x = bx + bw + GAP;
            y = ay + ah / 2 - height / 2;
            break;
        case St.Side.RIGHT:
            x = bx - GAP - width;
            y = ay + ah / 2 - height / 2;
            break;
        default:
            x = ax + aw / 2 - width / 2;
            y = by - GAP - height;
        }
        x = Math.max(monitor.x + GAP, Math.min(x, monitor.x + monitor.width - width - GAP));
        y = Math.max(monitor.y + GAP, Math.min(y, monitor.y + monitor.height - height - GAP));
        if (Number.isFinite(x) && Number.isFinite(y))
            this.set_position(Math.round(x), Math.round(y));
    }
});
