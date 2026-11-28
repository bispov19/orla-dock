// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// panel/panelMode.js — o modo Painel das barras de tarefas.
//
// A barra de cima do GNOME "entra" na barra de tarefas:
//   começo da barra: indicador de workspaces (+ indicadores que estavam à
//                    esquerda do painel do GNOME);
//   fim da barra:    indicadores de extensões e a seta da bandeja,
//                    configurações rápidas e o relógio com o calendário.
// A barra de cima some, e os avisos de notificação passam a surgir acima
// do relógio. Nos outros monitores entra só um relógio.
//
// Cada parte mora no seu arquivo em lib/panel/; aqui só montamos e
// desmontamos, sempre devolvendo o painel do GNOME exatamente como era.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {IdleRunner} from '../utils.js';
import {DateMenuSlot, secondaryClockButton} from './dateMenu.js';
import {NotificationPlacement} from './notifications.js';
import {QuickSettingsSlot} from './quickSettings.js';
import {TopBar} from './topBar.js';
import {PanelTray} from './tray.js';
import {WorkspaceIndicator} from './workspaceIndicator.js';

export class PanelMode {
    /**
     * @param {object} dock - a dock da Orla (lib/dock.js)
     * @param {boolean} primary - monitor principal (recebe o painel inteiro)
     */
    constructor(dock, primary) {
        this._dock = dock;
        this._primary = primary;
        this._active = false;
        this._resize = new IdleRunner(() => {
            if (!dock.destroyed)
                dock.relayout();
        });
        const box = align => new St.BoxLayout({
            style_class: 'orla-panel-box',
            reactive: true,
            x_align: align,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.startBox = box(Clutter.ActorAlign.START);
        this.endBox = box(Clutter.ActorAlign.CENTER);
    }

    get _side() {
        return [St.Side.BOTTOM, St.Side.TOP, St.Side.LEFT, St.Side.RIGHT][this._dock.axis.position];
    }

    /** Monta o painel na barra (a barra já precisa ter medidas). */
    integrate() {
        if (this._active)
            return;
        this._active = true;
        const dock = this._dock;
        const settings = dock.settings;
        const vertical = dock.axis.vertical;
        const side = this._side;
        const onResize = () => this._resize.queue();
        const orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        this.startBox.orientation = orientation;
        this.endBox.orientation = orientation;

        this._workspaces = new WorkspaceIndicator(settings, onResize);
        this._workspaces.setVertical(vertical);
        this.startBox.add_child(this._workspaces);

        if (this._primary) {
            this._tray = new PanelTray(dock, {onResize});
            this.startBox.add_child(this._tray.startBox);
            this.endBox.add_child(this._tray.endBox);
            this._tray.build();

            this._quick = new QuickSettingsSlot();
            this._quick.take(this.endBox, side, vertical, {
                hideSession: settings.get_boolean('start-menu'),
                onResize,
            });
            this._date = new DateMenuSlot(settings);
            const clock = this._date.take(this.endBox, side, vertical);

            this._notifications = new NotificationPlacement(dock.backgroundActor, () => this._side);
            this._notifications.enable(clock ?? this.endBox);
            this._topBar = new TopBar();
            this._topBar.hide();
        } else {
            this.endBox.add_child(secondaryClockButton(settings, vertical));
        }

        // Qualquer mudança de tamanho das caixas reorganiza a barra.
        for (const box of [this.startBox, this.endBox])
            box.connectObject('notify::width', onResize, 'notify::height', onResize, this);
        onResize();
    }

    /** O começo da barra tem algo a mostrar? */
    hasStartItems() {
        return this.startBox.get_children().some(child => child.visible &&
            (!(child instanceof St.BoxLayout) || child.get_n_children() > 0));
    }

    /** Algum menu do painel está aberto (a barra não pode se esconder)? */
    get busy() {
        return Boolean(this._tray?.busy || this._quick?.isOpen || this._date?.isOpen);
    }

    destroy() {
        this._resize.cancel();
        for (const box of [this.startBox, this.endBox])
            box.disconnectObject(this);
        // Desfaz na ordem inversa: o painel do GNOME volta como era.
        this._notifications?.disable();
        this._topBar?.show();
        this._date?.release();
        this._quick?.release();
        this._tray?.destroy();
        this._workspaces?.destroy();
        this._notifications = this._topBar = this._date = this._quick = this._tray = this._workspaces = null;
        this.startBox.destroy();
        this.endBox.destroy();
        this._active = false;
    }
}
