// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
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

const window = new Adw.PreferencesWindow();
const pages = [];
const add = window.add.bind(window);
window.add = page => {
    pages.push(page);
    add(page);
};
await prefs.fillPreferencesWindow(window);
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
    after(700, () => {
        const [w, h] = [window.get_width(), window.get_height()];
        const snapshot = new Gtk.Snapshot();
        new Gtk.WidgetPaintable({widget: window}).snapshot(snapshot, w, h);
        const texture = window.get_native().get_renderer().render_texture(snapshot.to_node(), null);
        const file = `${outDir}/${scheme}-${i + 1}.png`;
        texture.save_to_png(file);
        print(`PASS aba "${page.title}" (${scheme}) → ${file}`);
        capture(i + 1);
    });
}

after(1200, () => capture(0));
loop.run();
System.exit(failed ? 1 : 0);
