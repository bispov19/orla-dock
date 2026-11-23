// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// tests/shots/orla-shots@local/extension.js — monta cada cena da Orla Dock
// num GNOME Shell de teste e tira a captura já recortada. Usada pelo
// scripts/screenshots.sh, que depois copia as imagens para docs/ e store/.
//
// Cenas: dock com vidro e ampliação, leque e grade de uma pilha, barra de
// tarefas com o Menu Iniciar e a barra com a bandeja aberta.
// Os arquivos das pilhas e os "recentes" são de exemplo (criados aqui), e
// a foto do usuário no Menu Iniciar dá lugar ao avatar padrão.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'orla-dock@viniciusbispo19';
const OUT = GLib.getenv('ORLA_SHOTS_OUT') ?? GLib.get_tmp_dir();
const W = 1920, H = 1080;

const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const log = (...a) => console.log('ORLASHOT', ...a);
const orla = () => Main.extensionManager.lookup(UUID);
const dock = () => orla().stateObj._manager._docks[0];

async function shot(name, x, y, w, h) {
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    w = Math.min(W - x, Math.round(w));
    h = Math.min(H - y, Math.round(h));
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Promise((resolve, reject) => {
        new Shell.Screenshot().screenshot_area(x, y, w, h, stream, (o, res) => {
            try {
                o.screenshot_area_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
    stream.close(null);
    log('captura', name, `${w}x${h}`);
}

const pointer = () => global.stage.context.get_backend().get_default_seat()
    .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

async function hover(device, x, y) {
    for (let i = 0; i < 12; i++) {
        device.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await sleep(40);
    }
}

function rectOf(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return {x, y, w, h, cx: x + w / 2, cy: y + h / 2};
}

/** Arquivos de exemplo para as pilhas e para "Continuar de onde parou". */
function sampleFiles() {
    const dir = `${OUT}/Downloads`;
    GLib.mkdir_with_parents(dir, 0o755);
    const names = ['Relatório anual.pdf', 'Praia ao entardecer.jpg', 'Apresentação.odp',
        'Gastos do mês.ods', 'Trilha sonora.mp3', 'Anotações.txt', 'Projeto final.zip'];
    names.forEach((name, i) => {
        const path = `${dir}/${name}`;
        GLib.file_set_contents(path, `exemplo ${i}\n`);
        // Os mais "novos" primeiro na pilha.
        GLib.spawn_command_line_sync(`touch -d "-${i * 7} minutes" "${path}"`);
    });
    const when = GLib.DateTime.new_now_utc().format_iso8601();
    const marks = names.slice(0, 4).map(name =>
        `<bookmark href="${Gio.File.new_for_path(`${dir}/${name}`).get_uri()}" added="${when}" modified="${when}" visited="${when}"/>`);
    GLib.file_set_contents(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']),
        `<?xml version="1.0" encoding="UTF-8"?>\n<xbel version="1.0">${marks.join('')}</xbel>`);
    return Gio.File.new_for_path(dir).get_uri();
}

async function sceneDock(settings, mouse) {
    settings.set_string('bar-style', 'dock');
    settings.set_boolean('blur-enabled', true);
    await sleep(2000);
    const items = dock().getItems().filter(i => i.app);
    const target = items[Math.min(3, items.length - 1)];
    const r = rectOf(target);
    await hover(mouse, r.cx, r.cy);
    await sleep(900);
    const bar = rectOf(dock().backgroundActor);
    await shot('dock', bar.cx - 640, H - 330, 1280, 330);
}

async function sceneStack(settings, mouse, view, name) {
    settings.set_enum('stack-view', view);
    await sleep(800);
    await hover(mouse, W / 2, 200);
    const stack = dock().getItems().find(i => i.key?.startsWith('stack:'));
    stack.openPopup();
    await sleep(1400);
    const r = rectOf(stack);
    const width = view === 2 ? 760 : 900;
    await shot(name, r.cx - width / 2 - (view === 2 ? 120 : 0), H - 760, width, 760);
    stack.closePopup();
    await sleep(800);
}

async function sceneTaskbar(settings, mouse) {
    settings.set_boolean('blur-enabled', false);
    settings.set_string('bar-style', 'taskbar');
    settings.set_boolean('taskbar-merge-panel', true);
    await sleep(2500);

    // Um indicador de exemplo na bandeja.
    const indicator = new PanelMenu.Button(0.5, 'Exemplo');
    indicator.add_child(new St.Icon({icon_name: 'weather-few-clouds-symbolic', style_class: 'system-status-icon'}));
    Main.panel.addToStatusArea('orla-shots-weather', indicator);
    await sleep(1200);

    const d = dock();
    d.toggleStartMenu();
    await sleep(1200);
    const menu = d._startMenu;
    // A foto do usuário não vai para as capturas públicas.
    const avatar = (function find(a) {
        if (a.has_style_class_name?.('orla-start-avatar'))
            return a;
        for (const c of a.get_children()) {
            const f = find(c);
            if (f)
                return f;
        }
        return null;
    })(menu._box);
    if (avatar) {
        avatar.gicon = null;
        avatar.icon_name = 'avatar-default-symbolic';
    }
    await sleep(600);
    await shot('taskbar-start', 0, 0, W, H);
    menu.close();
    await sleep(800);

    const tray = d._panel._tray;
    tray.open();
    await sleep(900);
    await shot('taskbar', W - 720, H - 250, 720, 250);
    tray.close();
    indicator.destroy();
    await sleep(500);
}

async function run() {
    await sleep(2500);
    Main.overview.hide();
    const settings = orla().stateObj.getSettings();
    const stackUri = sampleFiles();
    settings.set_boolean('show-downloads', false);
    settings.set_strv('stack-folders', [stackUri]);
    settings.set_strv('start-menu-recent-app-ids', ['org.gnome.TextEditor.desktop', 'org.gnome.Calculator.desktop',
        'org.gnome.Weather.desktop', 'org.gnome.Maps.desktop', 'org.gnome.Characters.desktop']);
    await sleep(1500);
    const mouse = pointer();
    await hover(mouse, 20, 20);

    await sceneDock(settings, mouse);
    await sceneStack(settings, mouse, 2, 'stack-fan');
    await sceneStack(settings, mouse, 1, 'stack-grid');
    await sceneTaskbar(settings, mouse);
    log('DONE');
}

let started = false;
export default class OrlaShots extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        const go = () => run()
            .catch(e => log('ERRO', `${e}\n${e.stack}`))
            .finally(() => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                global.context.terminate();
                return GLib.SOURCE_REMOVE;
            }));
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connect('startup-complete', go);
        else
            go();
    }

    disable() {}
}
