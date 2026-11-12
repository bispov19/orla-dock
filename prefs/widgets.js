// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/widgets.js — peças reutilizáveis da janela de preferências e
// funções que "ligam" um controle a uma chave do GSettings.
//
// Por que um "Binder"? A janela de preferências pode ser fechada e aberta
// de novo dentro do mesmo processo. Todo `settings.connect()` feito à mão
// precisa ser desfeito quando a janela fecha; o Binder guarda os IDs e
// desconecta tudo de uma vez (mesma ideia do disable() da extensão).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export class Binder {
    constructor(settings) {
        this.settings = settings;
        this._ids = [];
    }

    /** Liga um booleano a uma propriedade (ex.: 'active' de um SwitchRow). */
    bool(key, widget, property = 'active') {
        this.settings.bind(key, widget, property, Gio.SettingsBindFlags.DEFAULT);
    }

    /** Liga um enum (do schema) ao índice selecionado de um ComboRow. */
    enum(key, row) {
        row.selected = this.settings.get_enum(key);
        row.connect('notify::selected', () => {
            if (this.settings.get_enum(key) !== row.selected)
                this.settings.set_enum(key, row.selected);
        });
        this._watch(key, () => {
            row.selected = this.settings.get_enum(key);
        });
    }

    /** Liga um número (inteiro ou decimal) a um Gtk.Adjustment. */
    number(key, adjustment, {integer = false} = {}) {
        const read = () => integer ? this.settings.get_int(key) : this.settings.get_double(key);
        adjustment.value = read();
        adjustment.connect('value-changed', () => {
            if (integer) {
                const value = Math.round(adjustment.value);
                if (value !== this.settings.get_int(key))
                    this.settings.set_int(key, value);
            } else if (Math.abs(adjustment.value - this.settings.get_double(key)) > 1e-6) {
                this.settings.set_double(key, adjustment.value);
            }
        });
        this._watch(key, () => {
            adjustment.value = read();
        });
    }

    _watch(key, callback) {
        this._ids.push(this.settings.connect(`changed::${key}`, callback));
    }

    /** Desconecta tudo (chamado quando a janela fecha). */
    destroy() {
        this._ids.forEach(id => this.settings.disconnect(id));
        this._ids = [];
    }
}

/** Um ComboRow simples a partir de uma lista de textos. */
export function comboRow(title, items, subtitle = null) {
    return new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(items),
    });
}

/** Um Gtk.Scale horizontal com marcas de texto embaixo (estilo macOS). */
export function markedScale({lower, upper, step, marks = [], digits = 0}) {
    const adjustment = new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5});
    const scale = new Gtk.Scale({
        adjustment,
        digits,
        draw_value: false,
        hexpand: true,
        orientation: Gtk.Orientation.HORIZONTAL,
        // Margens para os textos das marcas (centralizados nas pontas)
        // não encostarem na borda do cartão.
        margin_start: 14,
        margin_end: 14,
    });
    for (const [value, label] of marks)
        scale.add_mark(value, Gtk.PositionType.BOTTOM, label);
    return {scale, adjustment};
}

/** Linha com título e um slider à direita (para Aparência). */
export function scaleRow(title, subtitle, params) {
    const {scale, adjustment} = markedScale(params);
    scale.set_size_request(240, -1);
    scale.valign = Gtk.Align.CENTER;
    const row = new Adw.ActionRow({title, subtitle});
    row.add_suffix(scale);
    return {row, adjustment};
}

/**
 * A linha "Tamanho | Ampliação" lado a lado, como no painel "Mesa e Dock"
 * do macOS. É um Adw.PreferencesRow comum com uma Gtk.Box dentro.
 */
export function sizeAndMagnificationRow(binder) {
    const row = new Adw.PreferencesRow({activatable: false});
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 32,
        homogeneous: true,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    row.set_child(box);

    const column = (title, scale) => {
        const col = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        col.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['heading']}));
        col.append(scale);
        return col;
    };

    const size = markedScale({
        lower: 24, upper: 128, step: 1,
        marks: [[24, _('Small')], [128, _('Large')]],
    });
    binder.number('icon-size', size.adjustment, {integer: true});
    box.append(column(_('Size'), size.scale));

    const magnification = markedScale({
        lower: 1.0, upper: 2.6, step: 0.05, digits: 2,
        marks: [[1.0, _('Off')], [1.6, _('Small')], [2.6, _('Large')]],
    });
    binder.number('magnification', magnification.adjustment);
    box.append(column(_('Magnification'), magnification.scale));

    return row;
}

/**
 * Linha que mostra e permite trocar um atalho de teclado. Ao clicar em
 * "Alterar…", uma janelinha espera a próxima combinação de teclas.
 */
export const ShortcutRow = GObject.registerClass(
class OrlaShortcutRow extends Adw.ActionRow {
    _init(settings, key, params) {
        super._init(params);
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        const change = new Gtk.Button({label: _('Change…'), valign: Gtk.Align.CENTER});
        change.connect('clicked', () => this._capture());
        this.add_suffix(change);

        const reset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Disable shortcut'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => this._settings.set_strv(this._key, []));
        this.add_suffix(reset);

        this._id = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._id));
        this._sync();
    }

    _sync() {
        this._label.accelerator = this._settings.get_strv(this._key)[0] ?? '';
    }

    _capture() {
        const dialog = new Adw.AlertDialog({
            heading: _('New shortcut'),
            body: _('Press the new key combination, or Esc to cancel.'),
        });
        dialog.add_response('cancel', _('Cancel'));

        // Gtk.EventControllerKey: recebe as teclas pressionadas no diálogo.
        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === 0xff1b && !mods) {   // Esc
                dialog.close();
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mods))
                return true;   // ainda só modificadores (Ctrl, Alt…)
            this._settings.set_strv(this._key, [Gtk.accelerator_name(keyval, mods)]);
            dialog.close();
            return true;
        });
        dialog.add_controller(controller);
        dialog.present(this.get_root());
    }
});
