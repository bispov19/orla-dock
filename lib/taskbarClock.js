// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// taskbarClock.js — relógio com data no fim da barra de tarefas (estilo
// Windows 10).
//
// GnomeDesktop.WallClock é o "relógio de parede" que o próprio painel do
// GNOME usa: ele avisa (sinal notify::clock) quando o minuto muda, sem que
// a gente precise de um timer rodando a cada segundo.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const TaskbarClock = GObject.registerClass(
class OrlaTaskbarClock extends St.Button {
    _init() {
        super._init({style_class: 'orla-taskbar-clock', reactive: true, can_focus: true});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._time = new St.Label({style_class: 'orla-taskbar-time', x_align: Clutter.ActorAlign.CENTER});
        this._date = new St.Label({style_class: 'orla-taskbar-date', x_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._time);
        box.add_child(this._date);
        this.set_child(box);

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._sync(), this);
        this._interface.connectObject('changed::clock-format', () => this._sync(), this);

        // Clicar abre o calendário do próprio GNOME (o do painel superior).
        this.connect('clicked', () => Main.panel.statusArea.dateMenu?.menu.toggle());
        this._sync();
    }

    /** Na barra vertical (esquerda/direita) só a hora cabe. */
    setVertical(vertical) {
        this._date.visible = !vertical;
    }

    _sync() {
        const now = GLib.DateTime.new_now_local();
        const twelve = this._interface.get_string('clock-format') === '12h';
        this._time.text = now.format(twelve ? '%l:%M %p' : '%H:%M').trim();
        // %x = data no formato do idioma (ex.: 12/11/2026 em pt-BR).
        this._date.text = now.format('%x');
    }

    destroy() {
        this._wallClock.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._wallClock = null;
        super.destroy();
    }
});
