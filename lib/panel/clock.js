// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// panel/clock.js — relógio com data do modo Painel.
//
// Segue as opções de relógio do próprio GNOME (12/24 horas, segundos,
// mostrar a data) e a opção "formato da data" da Orla. O GnomeDesktop.
// WallClock é o mesmo relógio que o painel do GNOME usa: ele avisa quando o
// minuto (ou o segundo, se os segundos estiverem ligados) muda, então não
// precisamos de um timer nosso.
//
// Barra horizontal: hora em cima, data embaixo.
// Barra vertical (esquerda/direita): a barra é estreita, então a hora vira
// duas linhas (horas e minutos) e a data fica curta (dia/mês).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

const DEFAULT_DATE_FORMAT = '%d/%m/%Y';

export const PanelClock = GObject.registerClass(
class OrlaPanelClock extends St.BoxLayout {
    /** @param {Gio.Settings} settings - as configurações da Orla */
    _init(settings) {
        super._init({
            style_class: 'orla-panel-clock',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._settings = settings;
        this._vertical = false;
        this._time = new St.Label({style_class: 'orla-panel-clock-time', x_align: Clutter.ActorAlign.CENTER});
        this._date = new St.Label({style_class: 'orla-panel-clock-date', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._time);
        this.add_child(this._date);

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallClock = new GnomeDesktop.WallClock();
        const sync = () => this._sync();
        this._wallClock.connectObject('notify::clock', sync, this);
        this._interface.connectObject(
            'changed::clock-format', sync,
            'changed::clock-show-seconds', sync,
            'changed::clock-show-date', sync,
            this);
        this._settings.connectObject('changed::panel-date-format', sync, this);
        this.connect('destroy', () => {
            this._wallClock.disconnectObject(this);
            this._interface.disconnectObject(this);
            this._settings.disconnectObject(this);
            this._wallClock = null;
        });
        this._sync();
    }

    setVertical(vertical) {
        if (this._vertical === vertical)
            return;
        this._vertical = vertical;
        this._sync();
    }

    _sync() {
        const now = GLib.DateTime.new_now_local();
        const twelve = this._interface.get_string('clock-format') === '12h';
        const seconds = this._interface.get_boolean('clock-show-seconds');
        const showDate = this._interface.get_boolean('clock-show-date');

        if (this._vertical) {
            const lines = [now.format(twelve ? '%l' : '%H').trim(), now.format('%M')];
            if (seconds)
                lines.push(now.format('%S'));
            this._time.text = lines.join('\n');
            this._date.text = now.format('%d/%m');
        } else {
            const pattern = twelve
                ? (seconds ? '%l:%M:%S %p' : '%l:%M %p')
                : (seconds ? '%H:%M:%S' : '%H:%M');
            this._time.text = now.format(pattern).trim();
            const dateFormat = this._settings.get_string('panel-date-format') || DEFAULT_DATE_FORMAT;
            this._date.text = now.format(dateFormat) ?? now.format(DEFAULT_DATE_FORMAT);
        }
        this._date.visible = showDate;
        // Sem a data, a hora fica sozinha e um pouco maior.
        if (showDate)
            this.remove_style_class_name('orla-panel-clock-solo');
        else
            this.add_style_class_name('orla-panel-clock-solo');
    }
});
