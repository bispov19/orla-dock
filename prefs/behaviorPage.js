// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/behaviorPage.js — aba "Comportamento": ocultar, animações,
// janelas e apps.

import Adw from 'gi://Adw';

import {gettext as _, pgettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {enumRow, group, sliderRow, switchRow} from './rows.js';
import {ShortcutRow} from './widgets.js';

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
    animation.add(sliderRow(binder, 'minimize-duration', _('Minimize duration'), null,
        {lower: 150, upper: 1500, step: 50, marks: [[150, '150 ms'], [550, ''], [1500, '1500 ms']]}, true));
    animation.add(switchRow(binder, 'animate-launch', _('Animate opening applications')));
    animation.add(switchRow(binder, 'bounce-on-attention', _('Bounce when an application needs attention')));

    const windows = group(page, _('Windows'));
    windows.add(switchRow(binder, 'minimize-to-app', _('Minimize windows into application icon'),
        _('When off, minimized windows go next to the Downloads folder and the Trash')));
    windows.add(switchRow(binder, 'window-previews', _('Show window previews on hover')));
    windows.add(switchRow(binder, 'show-badges', _('Show notification badges and progress')));

    const apps = group(page, _('Apps on the Dock'));
    apps.add(switchRow(binder, 'show-recent', _('Show suggested and recent apps in Dock'),
        _('Closed apps stay in the Dock for a while, like on macOS')));
    apps.add(switchRow(binder, 'dynamic-calendar-icon', _("Show today's date on the Calendar icon")));
    apps.add(switchRow(binder, 'hide-overview-dash', _('Hide the GNOME dash in the Activities overview')));

    return page;
}
