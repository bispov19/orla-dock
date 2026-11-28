// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// tests/prefs/render.js — abre a janela de preferências de verdade, passa
// por todas as abas e salva uma captura de cada. Usado pelo
// scripts/test-prefs.sh.
//
// Uso: gjs -m render.js <pasta-da-extensão> <pasta-de-saída> <light|dark>
//
// Para rodar fora do app "Extensões", reproduzimos o que ele faz ao
// iniciar: carrega os recursos dele (gresource), liga o String.format e
// diz ao ExtensionPreferences onde está a nossa extensão.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';

const [extensionDir, outDir, scheme = 'light'] = ARGV;
// Altura da janela (capturas mais altas mostram mais da aba).
const HEIGHT = Number(GLib.getenv('ORLA_PREFS_HEIGHT') || 0);

String.prototype.format = imports.format.format;
Gio.resources_register(Gio.Resource.load(
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));

Adw.init();
Adw.StyleManager.get_default().color_scheme =
    scheme === 'dark' ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT;

const {ExtensionPreferences} = await import(
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
let prefs = null;
// O gettext das extensões acha a extensão pelo caminho do arquivo que
// chamou; aqui só existe uma, então devolvemos sempre ela.
ExtensionPreferences.lookupByUUID = () => prefs;

const metadata = JSON.parse(new TextDecoder().decode(
    GLib.file_get_contents(`${extensionDir}/metadata.json`)[1]));
metadata.path = extensionDir;
metadata.dir = Gio.File.new_for_path(extensionDir);

const Prefs = (await import(`file://${extensionDir}/prefs.js`)).default;
prefs = new Prefs(metadata);

// Opções iniciais (para capturas): ORLA_PREFS_SETUP='{"chave": valor, ...}'.
const setup = JSON.parse(GLib.getenv('ORLA_PREFS_SETUP') || '{}');
const settings = prefs.getSettings();
for (const [key, value] of Object.entries(setup)) {
    if (typeof value === 'boolean')
        settings.set_boolean(key, value);
    else if (typeof value === 'number')
        settings.set_double(key, value);
    else
        settings.set_string(key, value);
}

const window = new Adw.PreferencesWindow();
const pages = [];
const add = window.add.bind(window);
window.add = page => {
    pages.push(page);
    add(page);
};
await prefs.fillPreferencesWindow(window);
if (HEIGHT)
    window.set_default_size(1000, HEIGHT);
window.present();

// Passo a passo com callbacks (e não async/await): dentro de um
// GLib.MainLoop rodando no meio do módulo, as continuações de "await" não
// executam, e o teste ficaria parado para sempre.
let failed = false;
const loop = new GLib.MainLoop(null, false);
const after = (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    try {
        fn();
    } catch (e) {
        print(`FAIL ${e}\n${e.stack}`);
        failed = true;
        loop.quit();
    }
    return GLib.SOURCE_REMOVE;
});

function capture(i) {
    if (i >= pages.length) {
        if (pages.length === 0) {
            print('FAIL nenhuma aba foi criada');
            failed = true;
        }
        window.close();
        loop.quit();
        return;
    }
    const page = pages[i];
    window.set_visible_page(page);
    const shoot = (tries = 0) => {
        const [w, h] = [window.get_width(), window.get_height()];
        const snapshot = new Gtk.Snapshot();
        new Gtk.WidgetPaintable({widget: window}).snapshot(snapshot, w, h);
        const node = snapshot.to_node();
        // Máquina carregada: o GTK ainda não desenhou a janela; espera e tenta de novo.
        if (!node && tries < 5) {
            after(400, () => shoot(tries + 1));
            return;
        }
        const texture = window.get_native().get_renderer().render_texture(node, null);
        const file = `${outDir}/${scheme}-${i + 1}.png`;
        texture.save_to_png(file);
        print(`PASS aba "${page.title}" (${scheme}) → ${file}`);
        capture(i + 1);
    };
    after(700, () => shoot());
}

after(1200, () => capture(0));
loop.run();
System.exit(failed ? 1 : 0);
