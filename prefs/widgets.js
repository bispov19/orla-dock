// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// prefs/widgets.js — peças reutilizáveis da janela de preferências e
// funções que "ligam" um controle a uma chave do GSettings.
//
// Por que um "Binder"? A janela de preferências pode ser fechada e aberta
// de novo dentro do mesmo processo. Todo `settings.connect()` feito à mão
// precisa ser desfeito quando a janela fecha; o Binder guarda os IDs e
// desconecta tudo de uma vez (mesma ideia do disable() da extensão).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export class Binder {
    constructor(settings) {
        this.settings = settings;
        this._ids = [];
        this._others = [];
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

    /**
     * Liga uma chave de TEXTO a um ComboRow: `values` são os valores salvos,
     * na mesma ordem dos textos mostrados na lista.
     */
    stringCombo(key, row, values) {
        const sync = () => {
            const index = values.indexOf(this.settings.get_string(key));
            row.selected = Math.max(0, index);
        };
        row.connect('notify::selected', () => {
            const value = values[row.selected];
            if (value !== undefined && value !== this.settings.get_string(key))
                this.settings.set_string(key, value);
        });
        this._watch(key, sync);
        sync();
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

    /** Liga uma cor ('#rrggbb' no GSettings) a um Gtk.ColorDialogButton. */
    color(key, button) {
        const read = () => {
            const rgba = new Gdk.RGBA();
            rgba.parse(this.settings.get_string(key));
            return rgba;
        };
        button.rgba = read();
        button.connect('notify::rgba', () => {
            const {red, green, blue} = button.rgba;
            const hex = '#' + [red, green, blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            if (hex !== this.settings.get_string(key))
                this.settings.set_string(key, hex);
        });
        this._watch(key, () => {
            button.rgba = read();
        });
    }

    /**
     * Liga uma chave de texto a botões de escolha (Gtk.CheckButton ou
     * Gtk.ToggleButton do mesmo grupo): `buttons` é um Map valor → botão.
     */
    choice(key, buttons) {
        const sync = () => {
            const current = this.settings.get_string(key);
            buttons.forEach((button, value) => {
                button.active = value === current;
            });
        };
        buttons.forEach((button, value) => {
            button.connect('toggled', () => {
                if (button.active && this.settings.get_string(key) !== value)
                    this.settings.set_string(key, value);
            });
        });
        this._watch(key, sync);
        sync();
    }

    /** Botão (no cabeçalho do grupo) que volta `keys` ao valor padrão. */
    resetButton(group, keys) {
        const button = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to defaults'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        button.connect('clicked', () => keys.forEach(key => this.settings.reset(key)));
        group.set_header_suffix(button);
        return button;
    }

    /**
     * Mostra `widgets` só quando `predicate(settings)` for verdadeiro, e
     * reavalia sempre que alguma das `keys` mudar.
     */
    showWhen(keys, predicate, ...widgets) {
        const sync = () => {
            const visible = predicate(this.settings);
            widgets.forEach(w => {
                w.visible = visible;
            });
        };
        [].concat(keys).forEach(key => this._watch(key, sync));
        sync();
    }

    _watch(key, callback) {
        this._ids.push(this.settings.connect(`changed::${key}`, callback));
    }

    /** Desconecta tudo (chamado quando a janela fecha). */
    /** Observa uma chave de OUTRO Gio.Settings (desconectado no destroy()). */
    watchOther(settings, key, callback) {
        const id = settings.connect(`changed::${key}`, callback);
        this._others.push([settings, id]);
    }

    destroy() {
        this._ids.forEach(id => this.settings.disconnect(id));
        this._ids = [];
        this._others.forEach(([settings, id]) => settings.disconnect(id));
        this._others = [];
    }
}

/** Linha com um botão de cor (abre o seletor de cores do GTK). */
export function colorRow(binder, key, title, subtitle = null) {
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    binder.color(key, button);
    const row = new Adw.ActionRow({title, subtitle});
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/** Linha que escolhe um arquivo de imagem e guarda o caminho numa chave. */
export function imageRow(binder, key, title, window) {
    const settings = binder.settings;
    const row = new Adw.ActionRow({title});
    const label = new Gtk.Label({css_classes: ['dim-label'], ellipsize: 3, max_width_chars: 24});
    const sync = () => {
        const path = settings.get_string(key);
        label.label = path ? GLib.path_get_basename(path) : _('None');
    };
    binder._watch(key, sync);
    sync();
    const choose = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
    choose.connect('clicked', () => {
        const filter = new Gtk.FileFilter({name: _('Images')});
        filter.add_mime_type('image/*');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: _('Choose an image'), filters});
        dialog.open(window, null, (dlg, res) => {
            try {
                const file = dlg.open_finish(res);
                if (file?.get_path())
                    settings.set_string(key, file.get_path());
            } catch {
                // cancelado
            }
        });
    });
    row.add_suffix(label);
    row.add_suffix(choose);
    return row;
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
export function markedScale({lower, upper, step, marks = [], digits = 0, format = null}) {
    const adjustment = new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5});
    const scale = new Gtk.Scale({
        adjustment,
        digits,
        // Com `format`, o valor atual aparece ao lado (ex.: "550 ms").
        draw_value: format !== null,
        value_pos: Gtk.PositionType.RIGHT,
        hexpand: true,
        orientation: Gtk.Orientation.HORIZONTAL,
        // Margens para os textos das marcas (centralizados nas pontas)
        // não encostarem na borda do cartão.
        margin_start: 14,
        margin_end: 14,
    });
    for (const [value, label] of marks)
        scale.add_mark(value, Gtk.PositionType.BOTTOM, label);
    if (format)
        scale.set_format_value_func((_scale, value) => format(value));
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
        lower: 1.0, upper: 3.0, step: 0.05, digits: 2,
        marks: [[1.0, _('Off')], [2.0, _('Small')], [3.0, _('Large')]],
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
