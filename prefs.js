// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// prefs.js — janela de preferências da Orla Dock.
//
// Diferente do extension.js, este arquivo NÃO roda dentro do GNOME Shell:
// ele roda num processo separado (o app "Extensões"), que só existe
// enquanto a janela está aberta. Por isso aqui usamos GTK 4 + libadwaita
// (Adw) — e NÃO podemos importar nada do Shell (Clutter, St, Main…).
//
// A comunicação com a extensão é toda pelo GSettings: a janela grava um
// valor, a extensão recebe o sinal "changed" e se atualiza na hora.
//
// Cada aba fica num arquivo em prefs/; as linhas prontas em prefs/rows.js e
// os controles reutilizáveis em prefs/widgets.js.

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildAboutPage} from './prefs/aboutPage.js';
import {appearancePage} from './prefs/appearancePage.js';
import {behaviorPage} from './prefs/behaviorPage.js';
import {blurPage} from './prefs/blurPage.js';
import {layoutPage} from './prefs/layoutPage.js';
import {modulesPage} from './prefs/modulesPage.js';
import {musicPage} from './prefs/musicPage.js';
import {startMenuPage} from './prefs/startMenuPage.js';
import {stylesPage} from './prefs/stylesPage.js';
import {Binder} from './prefs/widgets.js';

/**
 * Os dados da aba "Sobre", separados de como ela é desenhada
 * (prefs/aboutPage.js). Para trocar um texto, um link ou um recurso, é só
 * mexer aqui. Versão e repositório vêm do metadata.json, então nunca ficam
 * desatualizados.
 */
function aboutInfo(metadata, extensionPath) {
    return {
        name: 'Orla Dock',
        description: _('An elegant, fluid dock for GNOME Shell, inspired by the macOS Dock.'),
        version: metadata['version-name'] ?? String(metadata.version ?? '?'),
        // A mesma licença dos cabeçalhos dos arquivos (e do LICENSE).
        license: 'MIT',
        repoUrl: metadata.url ?? 'https://github.com/bispov19/orla-dock',
        logoPath: GLib.build_filenamev([extensionPath, 'icons', 'orla-dock-mark.svg']),
        author: {name: 'Vinícius de Souza Bispo', role: _('Web Developer · Author and maintainer')},
        // Só recursos que existem de verdade (ver README).
        features: [
            _('Wave magnification'),
            _('Three styles: macOS, Windows 10 and GNOME'),
            _('Start Menu in five styles'),
            _('Glass blur'),
            _('Fan, grid and list stacks'),
            _('Genie minimize effect'),
            _('Wobbly windows'),
            _('Live window previews'),
            _('Notification badges'),
            _('Touches the edge with a maximized window'),
            _('One dock per monitor'),
        ],
    };
}

/**
 * Carrega o prefs.css (o visual do cartão do "Sobre") na tela inteira do
 * processo das preferências. Devolve uma função que o remove ao fechar,
 * para não empilhar cópias quando a janela é aberta de novo.
 */
function loadCss(extensionPath) {
    const display = Gdk.Display.get_default();
    const provider = new Gtk.CssProvider();
    provider.load_from_path(GLib.build_filenamev([extensionPath, 'prefs.css']));
    Gtk.StyleContext.add_provider_for_display(display, provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    return () => Gtk.StyleContext.remove_provider_for_display(display, provider);
}

export default class OrlaDockPreferences extends ExtensionPreferences {
    // fillPreferencesWindow() recebe uma Adw.PreferencesWindow vazia e nós
    // adicionamos as páginas. Textos traduzíveis usam _() (gettext): ficam
    // em inglês no código e a tradução pt-BR fica em po/pt_BR.po.
    async fillPreferencesWindow(window) {
        const binder = new Binder(this.getSettings());
        window.set_default_size(1000, 820);
        window.search_enabled = true;

        // Registra a pasta icons/ no tema de ícones do GTK. Assim os ícones
        // de lá podem ser usados pelo nome (icon_name), como os do sistema,
        // e o orla-dock-symbolic.svg é recolorido no tema claro e no escuro.
        // (Só uma vez: o processo continua vivo se a janela for reaberta.)
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const iconsDir = GLib.build_filenamev([this.path, 'icons']);
        if (!iconTheme.get_search_path().includes(iconsDir))
            iconTheme.add_search_path(iconsDir);
        const unloadCss = loadCss(this.path);

        // Uma aba por arquivo em prefs/.
        window.add(stylesPage(binder));
        window.add(layoutPage(binder));
        window.add(appearancePage(binder));
        window.add(blurPage(binder, this.path, window));
        window.add(behaviorPage(binder));
        window.add(startMenuPage(binder));
        window.add(musicPage(binder, window));
        window.add(modulesPage(binder, window, this.path));
        // this.metadata = metadata.json; this.path = pasta da extensão.
        window.add(buildAboutPage({window, info: aboutInfo(this.metadata, this.path)}));

        // Ao fechar, desconectamos os sinais que ligamos à mão.
        window.connect('close-request', () => {
            binder.destroy();
            unloadCss();
            return false;
        });
    }
}
