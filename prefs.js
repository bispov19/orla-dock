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
// valor, a extensão recebe o sinal "changed" e se atualiza.
//
// Nesta Fase 0 a janela é mínima. Na Fase 6 ela vira a réplica do painel
// "Mesa e Dock" do macOS.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OrlaDockPreferences extends ExtensionPreferences {
    // fillPreferencesWindow() recebe uma Adw.PreferencesWindow vazia e
    // nós adicionamos páginas (PreferencesPage) com grupos (PreferencesGroup)
    // e linhas (ActionRow, SwitchRow, ComboRow…).
    //
    // _() é o gettext: marca o texto para tradução. Os textos-fonte ficam
    // em inglês (padrão do GNOME) e a tradução pt-BR fica em po/pt_BR.po.
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Dock'),
            icon_name: 'user-desktop-symbolic',
        });
        window.add(page);

        const dockGroup = new Adw.PreferencesGroup({title: _('Dock')});
        page.add(dockGroup);

        // --- Posição na tela (ComboRow = linha com lista suspensa) ---
        // A ordem da lista é igual à do enum no schema (bottom=0, top=1,
        // left=2, right=3), então o índice selecionado É o valor do enum.
        const positionRow = new Adw.ComboRow({
            title: _('Position on screen'),
            model: Gtk.StringList.new([_('Bottom'), _('Top'), _('Left'), _('Right')]),
            selected: settings.get_enum('position'),
        });
        // Quando o usuário escolhe outra opção, gravamos no GSettings.
        positionRow.connect('notify::selected', () => {
            settings.set_enum('position', positionRow.selected);
        });
        // E se a chave mudar por outro caminho (ex.: terminal), a linha acompanha.
        settings.connect('changed::position', () => {
            positionRow.selected = settings.get_enum('position');
        });
        dockGroup.add(positionRow);

        // --- Monitores (SwitchRow = linha com interruptor) ---
        const monitorsGroup = new Adw.PreferencesGroup({title: _('Monitors')});
        page.add(monitorsGroup);

        const multiMonitorRow = new Adw.SwitchRow({
            title: _('Show the dock on all monitors'),
            subtitle: _('When off, the dock appears only on the primary monitor'),
        });
        // bind() liga a chave à propriedade "active" nos dois sentidos,
        // sem precisar escrever os handlers manualmente como acima.
        // (Para o enum precisamos do jeito manual porque bind() trabalha
        // com o texto do enum, e o ComboRow trabalha com índice.)
        settings.bind('multi-monitor', multiMonitorRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        monitorsGroup.add(multiMonitorRow);
    }
}
