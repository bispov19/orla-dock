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
// As páginas ficam em prefs/pages.js; os controles reutilizáveis, em
// prefs/widgets.js.

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {appearancePage, dockPage, stacksPage} from './prefs/pages.js';
import {Binder} from './prefs/widgets.js';

export default class OrlaDockPreferences extends ExtensionPreferences {
    // fillPreferencesWindow() recebe uma Adw.PreferencesWindow vazia e nós
    // adicionamos as páginas. Textos traduzíveis usam _() (gettext): ficam
    // em inglês no código e a tradução pt-BR fica em po/pt_BR.po.
    async fillPreferencesWindow(window) {
        const binder = new Binder(this.getSettings());
        window.set_default_size(720, 820);
        window.search_enabled = true;

        window.add(dockPage(binder));
        window.add(appearancePage(binder));
        window.add(stacksPage(binder, window));

        // Ao fechar, desconectamos os sinais que ligamos à mão.
        window.connect('close-request', () => {
            binder.destroy();
            return false;
        });
    }
}
