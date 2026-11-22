// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/behaviorPage.js — aba "Comportamento": ocultar, animações,
// janelas e apps.

import Adw from 'gi://Adw';

import {gettext as _, pgettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {enumRow, group, sliderRow, switchRow} from './rows.js';
import {ShortcutRow} from './widgets.js';
import {wobblyGroup} from './wobblyGroup.js';

export function behaviorPage(binder) {
    const page = new Adw.PreferencesPage({
        // Translators: título de aba; curto, porque as abas dividem a largura.
        title: pgettext('preferences tab', 'Behavior'),
        icon_name: 'applications-engineering-symbolic',
    });

    const hide = group(page, _('Auto-hide'), _('When the Dock steps out of the way'));
    hide.add(switchRow(binder, 'autohide', _('Automatically hide and show the Dock')));
    hide.add(new ShortcutRow(binder.settings, 'orla-toggle-autohide', {
        title: _('Shortcut to turn hiding on or off'),
    }));

    const animation = group(page, _('Animations'));
    animation.add(enumRow(binder, 'minimize-effect', _('Minimize windows using'),
        [_('Genie effect'), _('Scale effect')]));
    // 100–1500 ms, de 25 em 25, com o valor visível.
    // O efeito Escala é a animação nativa do GNOME, que tem duração fixa;
    // por isso o controle só aparece com o Gênio.
    const duration = sliderRow(binder, 'minimize-duration', _('Minimize duration'),
        _('How long minimizing and restoring a window takes'),
        {lower: 100, upper: 1500, step: 25, format: v => `${Math.round(v)} ms`}, true);
    animation.add(duration);
    binder.showWhen('minimize-effect', s => s.get_enum('minimize-effect') === 0, duration);
    animation.add(switchRow(binder, 'animate-launch', _('Animate opening applications')));
    animation.add(switchRow(binder, 'bounce-on-attention', _('Bounce when an application needs attention')));

    wobblyGroup(page, binder);

    const windows = group(page, _('Windows'));
    windows.add(switchRow(binder, 'minimize-to-app', _('Minimize windows into application icon'),
        _('When off, minimized windows go next to the Downloads folder and the Trash')));
    windows.add(switchRow(binder, 'window-previews', _('Show window previews on hover')));
    windows.add(switchRow(binder, 'show-badges', _('Show notification badges and progress'),
        _('Each app shows how many notifications it has waiting, even when pinned and closed')));

    const apps = group(page, _('Apps on the Dock'));
    apps.add(switchRow(binder, 'show-recent', _('Show suggested and recent apps in Dock'),
        _('Closed apps stay in the Dock for a while, like on macOS')));
    apps.add(switchRow(binder, 'hide-overview-dash', _('Hide the GNOME dash in the Activities overview')));

    // --- Visual do Calendário e da Lixeira ---
    const looks = group(page, _('Calendar and Trash icons'),
        _('Choose whether they follow the current icon theme or use the Dock\'s own look'));
    looks.add(enumRow(binder, 'calendar-icon-style', _('Calendar'),
        [_('Follow the icon theme'), _("Today's date (Dock look)")]));
    looks.add(enumRow(binder, 'trash-icon-style', _('Trash'),
        [_('Follow the icon theme'), _("Dock's own trash")]));

    // --- Janelas ocultas ---
    const hidden = group(page, _('Hidden windows'),
        _('Some apps show on-screen notices (like a Caps Lock indicator) as regular windows, ' +
          'which makes an extra icon pop up on the Dock. Windows whose class matches one of ' +
          'these patterns are left out of the Dock. Separate patterns with commas; * matches any text.'));
    binder.resetButton(hidden, ['ignored-window-classes']);
    // Adw.EntryRow: campo de texto numa linha; o botão "aplicar" (✓) só
    // salva quando o usuário confirma, em vez de a cada tecla.
    const entry = new Adw.EntryRow({
        title: _('Window classes to hide'),
        show_apply_button: true,
        text: binder.settings.get_string('ignored-window-classes'),
    });
    entry.connect('apply', () => {
        const value = entry.get_text().split(',').map(p => p.trim()).filter(Boolean).join(', ');
        binder.settings.set_string('ignored-window-classes', value);
        entry.set_text(value);
    });
    binder._watch('ignored-window-classes', () => {
        const value = binder.settings.get_string('ignored-window-classes');
        if (entry.get_text() !== value)
            entry.set_text(value);
    });
    hidden.add(entry);

    return page;
}
