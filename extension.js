// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// extension.js — ponto de entrada da Orla Dock.
//
// O GNOME Shell importa este arquivo como um módulo ES e procura o
// "export default": uma classe que estende Extension. Depois disso ele chama:
//   - enable():  quando a extensão é ativada (login, desbloqueio de tela,
//                ou quando você liga a extensão);
//   - disable(): quando é desativada (logout, BLOQUEIO DE TELA, ou quando
//                você desliga a extensão).
//
// Regra de ouro (exigida na revisão do extensions.gnome.org):
//   tudo que o enable() cria, o disable() destrói. Atores, sinais, timeouts…
//   Como o disable() roda toda vez que a tela é bloqueada, qualquer vazamento
//   se acumula ao longo do dia.
//
// Repare também: nada é feito "solto" no topo do módulo, só imports.
// O trabalho começa no enable().

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class OrlaDockExtension extends Extension {
    enable() {
        // getSettings() lê o "settings-schema" do metadata.json e devolve
        // um Gio.Settings já apontando para o nosso schema compilado.
        this._settings = this.getSettings();

        // connectObject() é um atalho que o GNOME Shell adiciona a todo
        // GObject: conecta vários sinais de uma vez e associa todos eles a
        // um "dono" (aqui, `this`). No disable() basta um disconnectObject(this)
        // para desconectar tudo — sem precisar guardar IDs um a um.
        //
        // O sinal "changed::position" dispara só quando a chave "position"
        // muda; "changed" sem sufixo dispararia para qualquer chave.
        this._settings.connectObject(
            'changed::position', () => this._logSettings(),
            'changed::multi-monitor', () => this._logSettings(),
            this);

        console.log('[Orla Dock] ativada');
        this._logSettings();
    }

    disable() {
        // Desconecta todos os sinais que conectamos com connectObject(…, this).
        this._settings?.disconnectObject(this);
        // Soltar a referência permite que o objeto seja liberado da memória.
        this._settings = null;

        console.log('[Orla Dock] desativada');
    }

    // Fase 0: só mostramos no log que as configurações chegam em tempo real.
    // A partir da Fase 1, isso vira "reconstruir a dock na nova posição".
    _logSettings() {
        const position = this._settings.get_string('position');
        const multiMonitor = this._settings.get_boolean('multi-monitor');
        console.log(`[Orla Dock] posição=${position}, todos os monitores=${multiMonitor}`);
    }
}
