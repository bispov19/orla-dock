// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// prefs/aboutPage.js — aba "Sobre": cartão de destaque, links e créditos.
//
// Este módulo só MONTA a página. Os dados (nome, versão, links, recursos…)
// chegam prontos num objeto montado no prefs.js. Assim, para mudar um
// texto ou um link você mexe só nos dados, e para mudar o visual, só aqui.
//
// O visual do cartão (.about-hero) está no prefs.css, não no stylesheet.css:
// a janela de preferências é GTK e roda num processo separado do Shell, então
// o CSS do Shell (St) não chega até ela.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Linha com ícone à esquerda. use_markup: false porque os textos são
 * texto puro: um "&" ou "<" num subtítulo não pode virar marcação.
 */
function infoRow({icon, title, subtitle, wrap = false}) {
    const row = new Adw.ActionRow({title, subtitle, use_markup: false});
    // subtitle_lines = 0: sem limite de linhas, o texto quebra em vez de
    // ser cortado com "…".
    if (wrap)
        row.subtitle_lines = 0;
    row.add_prefix(new Gtk.Image({icon_name: icon}));
    return row;
}

/** Linha clicável que abre um endereço no navegador padrão. */
function linkRow(window, {icon, title, url}) {
    const row = infoRow({icon, title, subtitle: url.replace(/^https?:\/\//, '')});
    row.activatable = true;
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => {
        // Gtk.UriLauncher pede ao sistema (portal) para abrir o link no app
        // padrão. O resultado chega no callback; um erro vai para o log.
        new Gtk.UriLauncher({uri: url}).launch(window, null, (launcher, result) => {
            try {
                launcher.launch_finish(result);
            } catch (e) {
                console.error(`Orla Dock: não foi possível abrir ${url}: ${e.message}`);
            }
        });
    });
    return row;
}

/** O cartão do topo: logo, nome, descrição e "Versão • Licença". */
function hero(info) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        css_classes: ['about-hero'],
    });
    const logo = Gio.File.new_for_path(info.logoPath);
    box.append(new Gtk.Image({
        gicon: new Gio.FileIcon({file: logo}),
        pixel_size: 140,
        margin_bottom: 4,
    }));
    box.append(new Gtk.Label({label: info.name, css_classes: ['title-1']}));
    box.append(new Gtk.Label({
        label: info.description,
        css_classes: ['dim-label'],
        wrap: true,
        justify: Gtk.Justification.CENTER,
        max_width_chars: 48,
    }));
    box.append(new Gtk.Label({
        label: `${_('Version %s').format(info.version)}  •  ${info.license}`,
        css_classes: ['dim-label', 'caption'],
    }));
    return box;
}

/**
 * Monta a aba "Sobre".
 *
 * @param {object} params
 * @param {Adw.PreferencesWindow} params.window - para abrir os links
 * @param {object} params.info - os dados mostrados (ver prefs.js)
 * @returns {Adw.PreferencesPage}
 */
export function buildAboutPage({window, info}) {
    const page = new Adw.PreferencesPage({
        title: _('About'),
        // Achado pelo nome porque o prefs.js registra a pasta icons/ no
        // tema de ícones; o "-symbolic" faz o GTK pintá-lo na cor do texto.
        icon_name: 'orla-dock-symbolic',
    });

    // Um grupo sem título só para segurar o cartão (a página só aceita grupos).
    const top = new Adw.PreferencesGroup();
    top.add(hero(info));
    page.add(top);

    const links = new Adw.PreferencesGroup({title: _('Links')});
    links.add(linkRow(window, {
        icon: 'web-browser-symbolic',
        title: _('GitHub repository'),
        url: info.repoUrl,
    }));
    page.add(links);

    const credits = new Adw.PreferencesGroup({title: _('Credits')});
    credits.add(infoRow({
        icon: 'avatar-default-symbolic',
        title: info.author.name,
        subtitle: info.author.role,
    }));
    credits.add(infoRow({
        icon: 'starred-symbolic',
        title: _('Features'),
        subtitle: info.features.join(' · '),
        wrap: true,
    }));
    credits.add(infoRow({
        icon: 'dialog-information-symbolic',
        title: _('Notice'),
        subtitle: _('Orla Dock is an independent, open source project.'),
        wrap: true,
    }));
    page.add(credits);

    return page;
}
