// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/aboutPage.js — aba "Sobre": logo, versão, "Sobre mim", links e licença.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {linkRow, textRow} from './rows.js';

const REPO_URL = 'https://github.com/viniciusbispo19/orla-dock';
const PROFILE_URL = 'https://github.com/viniciusbispo19';

// As capturas mostradas no "Sobre" (cópias menores das de store/screenshots).
const SCREENSHOTS = [
    ['01-fan-animation.png', 'Fan animation'],
    ['02-style-selection.png', 'Style selection'],
    ['03-dock-position.png', 'Dock position'],
];

/**
 * Um Adw.Carousel (deslizar de lado) com as capturas e as bolinhas
 * embaixo. Cada captura tem a legenda dela. Se as imagens não estiverem
 * instaladas, simplesmente não mostra nada.
 */
function screenshotsCarousel(extensionPath) {
    const files = SCREENSHOTS
        .map(([name, caption]) => [GLib.build_filenamev([extensionPath, 'icons', 'screenshots', name]), caption])
        .filter(([path]) => GLib.file_test(path, GLib.FileTest.EXISTS));
    if (!files.length)
        return null;
    const captions = {
        'Fan animation': _('Fan animation'),
        'Style selection': _('Style selection'),
        'Dock position': _('Dock position'),
    };
    const carousel = new Adw.Carousel({allow_scroll_wheel: false, spacing: 12, margin_top: 18});
    for (const [path, caption] of files) {
        const page = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, hexpand: true});
        const picture = Gtk.Picture.new_for_filename(path);
        picture.content_fit = Gtk.ContentFit.CONTAIN;
        picture.height_request = 300;
        picture.add_css_class('card');
        page.append(picture);
        page.append(new Gtk.Label({label: captions[caption], css_classes: ['dim-label']}));
        carousel.append(page);
    }
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    box.append(carousel);
    box.append(new Adw.CarouselIndicatorDots({carousel}));
    return box;
}

export function aboutPage(metadata, extensionPath, window) {
    const page = new Adw.PreferencesPage({
        title: _('About'),
        icon_name: 'help-about-symbolic',
    });

    // --- Cabeçalho: logo, nome e versão ---
    const header = new Adw.PreferencesGroup();
    page.add(header);
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        margin_top: 6,
    });
    const logo = Gio.File.new_for_path(GLib.build_filenamev([extensionPath, 'icons', 'orla-logo.svg']));
    box.append(new Gtk.Image({gicon: new Gio.FileIcon({file: logo}), pixel_size: 112}));
    box.append(new Gtk.Label({label: 'Orla Dock', css_classes: ['title-1']}));
    box.append(new Gtk.Label({
        label: _('Version %s').format(metadata['version-name'] ?? metadata.version ?? '?'),
        css_classes: ['dim-label'],
    }));
    box.append(new Gtk.Label({
        label: _('A dock for GNOME inspired by the macOS Dock, with GNOME, Windows 10 and Windows 7 styles.'),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        max_width_chars: 50,
    }));
    header.add(box);

    // --- Capturas (as mesmas da página da extensão), passando de lado ---
    const shots = screenshotsCarousel(extensionPath);
    if (shots)
        header.add(shots);

    // --- Sobre mim ---
    const me = new Adw.PreferencesGroup({title: _('About me')});
    page.add(me);
    // Aspas duplas por causa do apóstrofo em "I'm" (o xgettext não lida
    // bem com \' escapado).
    me.add(textRow(_("Hi! I'm Vinicius Bispo (Vini), a Systems Analysis and Development student " +
        'making the move into technology. I created Orla Dock from scratch to learn how GNOME ' +
        'works from the inside — and to have the dock I always wanted on my own desktop.\n\n' +
        'The code is commented in Portuguese, step by step, so that other people who are ' +
        'starting out can learn from it too. Suggestions and contributions are very welcome!')));
    me.add(linkRow(window, _('My GitHub profile'), 'github.com/viniciusbispo19',
        PROFILE_URL, 'avatar-default-symbolic'));

    // --- Projeto ---
    const project = new Adw.PreferencesGroup({title: _('Project')});
    page.add(project);
    project.add(linkRow(window, _('Source code'), _('See the code, star it or contribute'),
        REPO_URL, 'text-x-generic-symbolic'));
    project.add(linkRow(window, _('Report a problem'), _('Found a bug or have an idea? Open an issue'),
        `${REPO_URL}/issues`, 'dialog-warning-symbolic'));

    // --- Licença ---
    const license = new Adw.PreferencesGroup({title: _('License')});
    page.add(license);
    license.add(textRow(_('Orla Dock is free software, released under the GNU General Public ' +
        'License, version 3 or later (GPL-3.0-or-later). It comes with absolutely no warranty.')));

    return page;
}
