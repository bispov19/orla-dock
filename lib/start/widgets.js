// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// start/widgets.js — peças visuais do Menu Iniciar (células de app, linhas
// de resultado, títulos de seção). Cada peça é um St.Button: dá foco pelo
// teclado, responde ao Enter e ao clique, e o botão direito abre o menu
// de contexto que a tela passar em `menu`.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

export const ICON_GRID = 40;
export const ICON_ROW = 24;

function label(text, styleClass) {
    const l = new St.Label({text, style_class: styleClass, x_align: Clutter.ActorAlign.CENTER});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

/**
 * Liga clique esquerdo (`activate`) e direito (`menu`, uma função que
 * devolve os itens do menu de contexto) num botão.
 */
function wire(button, activate, menu, owner) {
    button.connect('clicked', () => activate());
    if (menu) {
        button.connect('button-press-event', (_b, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            owner.showContextMenu(menu(), x, y);
            return Clutter.EVENT_STOP;
        });
        // Tecla Menu ou Shift+F10 também abrem o menu de contexto.
        button.connect('key-press-event', (_b, event) => {
            const key = event.get_key_symbol();
            const shift = event.get_state() & Clutter.ModifierType.SHIFT_MASK;
            if (key !== Clutter.KEY_Menu && !(shift && key === Clutter.KEY_F10))
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = button.get_transformed_position();
            owner.showContextMenu(menu(), x + button.width / 2, y + button.height / 2);
            return Clutter.EVENT_STOP;
        });
    }
}

/** Célula de grade: ícone em cima, nome embaixo, ponto se estiver aberto. */
export const AppCell = GObject.registerClass(
class OrlaStartCell extends St.Button {
    _init({app = null, gicon = null, iconActor = null, name, running = false, activate, menu = null, owner,
        iconSize = ICON_GRID, styleClass = ''}) {
        super._init({style_class: `orla-start-cell ${styleClass}`.trim(), can_focus: true});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orla-start-cell-box'});
        const icon = iconActor ?? iconFor(app, gicon, iconSize);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        box.add_child(label(name ?? app?.get_name() ?? '', 'orla-start-cell-name'));
        this._dot = new St.Widget({style_class: 'orla-start-running', x_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._dot);
        this.set_child(box);
        this.accessible_name = name ?? app?.get_name() ?? '';
        this.setRunning(running);
        wire(this, activate, menu, owner);
    }

    /** O pontinho de "app aberto" (só a opacidade muda: nada de relayout). */
    setRunning(running) {
        this._dot.opacity = running ? 255 : 0;
    }
});

/**
 * O ícone COLORIDO de um app (o do .desktop, não o simbólico), já com o
 * substituto do GNOME para app sem ícone. Para outros itens, `gicon` com
 * um substituto genérico.
 */
export function iconFor(app, gicon, size) {
    if (app)
        return app.create_icon_texture(size);
    return new St.Icon({gicon, icon_size: size, fallback_icon_name: 'application-x-executable'});
}

/** Linha de lista: ícone, título e (opcional) subtítulo. */
export const Row = GObject.registerClass(
class OrlaStartRow extends St.Button {
    _init({app = null, gicon = null, iconActor = null, title, subtitle = '', activate, menu = null, owner,
        styleClass = '', iconSize = ICON_ROW, trailing = null}) {
        title ??= app?.get_name() ?? '';
        super._init({style_class: `orla-start-row ${styleClass}`.trim(), can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style_class: 'orla-start-row-box', x_expand: true, x_align: Clutter.ActorAlign.FILL});
        const icon = iconActor ?? iconFor(app, gicon, iconSize);
        icon.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const titleLabel = label(title, 'orla-start-row-title');
        titleLabel.x_align = Clutter.ActorAlign.START;
        text.add_child(titleLabel);
        if (subtitle) {
            const sub = label(subtitle, 'orla-start-row-subtitle');
            sub.x_align = Clutter.ActorAlign.START;
            text.add_child(sub);
        }
        box.add_child(text);
        // Ex.: a seta "›" de uma categoria que abre um submenu.
        if (trailing) {
            trailing.y_align = Clutter.ActorAlign.CENTER;
            box.add_child(trailing);
        }
        this.set_child(box);
        this.accessible_name = title;
        wire(this, activate, menu, owner);
    }
});

/** Título de seção, com um botão opcional à direita (ex.: "Todos os apps"). */
export function sectionHeader(title, action = null) {
    const box = new St.BoxLayout({style_class: 'orla-start-section-header'});
    box.add_child(new St.Label({text: title, style_class: 'orla-start-section-title', x_expand: true,
        y_align: Clutter.ActorAlign.CENTER}));
    if (action) {
        const button = new St.Button({style_class: 'orla-start-pill', can_focus: true, label: action.label});
        button.connect('clicked', action.activate);
        box.add_child(button);
    }
    return box;
}

/** Botão redondo só com ícone (voltar, energia, trocar lista/grade…). */
export function iconButton(iconName, accessibleName, activate) {
    const button = new St.Button({
        style_class: 'orla-start-round',
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
    });
    button.connect('clicked', activate);
    return button;
}

/** "Agora mesmo", "Ontem", "12 de nov." para a data de um arquivo. */
export function friendlyTime(unix, _) {
    if (!unix)
        return '';
    const now = Math.floor(Date.now() / 1000);
    const date = new Date(unix * 1000);
    const today = new Date();
    if (now - unix < 60)
        return _('Just now');
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(date, today))
        return date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(date, yesterday))
        return _('Yesterday');
    return date.toLocaleDateString(undefined, {day: 'numeric', month: 'short'});
}
