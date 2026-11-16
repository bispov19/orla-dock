// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
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

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {aboutPage} from './prefs/aboutPage.js';
import {appearancePage} from './prefs/appearancePage.js';
import {behaviorPage} from './prefs/behaviorPage.js';
import {blurPage} from './prefs/blurPage.js';
import {layoutPage} from './prefs/layoutPage.js';
import {modulesPage} from './prefs/modulesPage.js';
import {stylesPage} from './prefs/stylesPage.js';
import {Binder} from './prefs/widgets.js';

export default class OrlaDockPreferences extends ExtensionPreferences {
    // fillPreferencesWindow() recebe uma Adw.PreferencesWindow vazia e nós
    // adicionamos as páginas. Textos traduzíveis usam _() (gettext): ficam
    // em inglês no código e a tradução pt-BR fica em po/pt_BR.po.
    async fillPreferencesWindow(window) {
        const binder = new Binder(this.getSettings());
        window.set_default_size(1000, 820);
        window.search_enabled = true;

        // Uma aba por arquivo em prefs/, na mesma ordem da Luma Dock.
        window.add(stylesPage(binder));
        window.add(layoutPage(binder));
        window.add(appearancePage(binder));
        window.add(blurPage(binder, this.path, window));
        window.add(behaviorPage(binder));
        window.add(modulesPage(binder, window, this.path));
        // this.metadata = conteúdo do metadata.json; this.path = pasta da extensão.
        window.add(aboutPage(this.metadata, this.path, window));

        // Ao fechar, desconectamos os sinais que ligamos à mão.
        window.connect('close-request', () => {
            binder.destroy();
            return false;
        });
    }
}
