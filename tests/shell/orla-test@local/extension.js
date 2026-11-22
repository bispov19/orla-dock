// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// tests/shell/orla-test@local/extension.js — testes da Orla Dock que rodam
// DENTRO de um GNOME Shell de teste (sem janela), iniciado pelo
// scripts/test-shell.sh.
//
// Por que uma extensão? O Shell não deixa outro programa mexer nele por
// fora (o Eval do D-Bus fica desligado). Uma extensão roda lá dentro, com
// acesso ao Main, às janelas e à própria Orla.
//
// Cada verificação imprime "ORLATEST PASS …" ou "ORLATEST FAIL …"; o
// script lê essas linhas para dar o resultado. Capturas vão para
// $ORLA_TEST_OUT.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'orla-dock@viniciusbispo19';
const OUT = GLib.getenv('ORLA_TEST_OUT') ?? GLib.get_tmp_dir();
// "quick" pula a parte de percorrer todas as opções (a mais demorada).
const QUICK = GLib.getenv('ORLA_TEST_QUICK') === '1';

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});
const log = (...args) => console.log('ORLATEST', ...args);
const check = (ok, what) => log(ok ? 'PASS' : 'FAIL', what);

const orla = () => Main.extensionManager.lookup(UUID);
const manager = () => orla()?.stateObj?._manager ?? null;

/** Quantos atores da Orla estão na tela (para achar sobras ao desativar). */
function orlaActors() {
    let n = 0;
    const walk = actor => {
        if (actor.name === 'orlaDock')
            n++;
        for (const child of actor.get_children())
            walk(child);
    };
    walk(global.stage);
    return n;
}

async function screenshot(name) {
    try {
        const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shooter = new Shell.Screenshot();
        await new Promise((resolve, reject) => {
            shooter.screenshot(false, stream, (obj, res) => {
                try {
                    obj.screenshot_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        stream.close(null);
    } catch (e) {
        log('INFO', `captura ${name} falhou: ${e.message}`);
    }
}

async function waitForWindow(ms = 8000) {
    for (let t = 0; t < ms; t += 200) {
        const win = global.get_window_actors()
            .map(a => a.meta_window)
            .find(w => w.get_window_type() === Meta.WindowType.NORMAL);
        if (win)
            return win;
        await sleep(200);
    }
    return null;
}

/** Abre um app simples para ter uma janela de verdade. */
async function openWindow() {
    const apps = Shell.AppSystem.get_default();
    const app = ['org.gnome.TextEditor.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Nautilus.desktop']
        .map(id => apps.lookup_app(id))
        .find(Boolean);
    if (!app)
        return null;
    app.activate();
    const win = await waitForWindow();
    await sleep(1000);
    return win;
}

// ---------- Os testes ----------

async function testStartup() {
    const ext = orla();
    check(ext?.state === 1, `extensão ativa (estado ${ext?.state}${ext?.error ? `, erro: ${ext.error}` : ''})`);
    check(manager()?._docks?.length >= 1, 'uma dock por monitor');
    check(orlaActors() === manager()?._docks?.length, 'um ator de dock por dock');
    await screenshot('01-inicio');
}

/** Com janela maximizada a dock encosta na borda; sem, volta a flutuar. */
async function testHug(win, settings) {
    settings.set_boolean('hug-edge-when-maximized', true);
    for (const pos of ['bottom', 'left', 'right', 'top']) {
        settings.set_string('position', pos);
        Main.overview.hide();
        await sleep(1500);
        const dock = manager()._docks[0];
        win.maximize();
        await sleep(1300);
        const hugged = dock._hugTarget;
        const frame = win.get_frame_rect();
        const dockRect = dock.dockRect;
        await screenshot(`02-maximizada-${pos}`);
        win.unmaximize();
        await sleep(1300);

        check(hugged > 0, `${pos}: encosta na borda com janela maximizada`);
        check(dock._hugTarget === 0, `${pos}: volta a flutuar ao restaurar`);
        // A janela maximizada não pode ficar por baixo da dock.
        const overlaps = {
            bottom: frame.y + frame.height > dockRect.y + dockRect.height - dock._geometry.thickness,
            top: frame.y < dockRect.y + dock._geometry.thickness,
            left: frame.x < dockRect.x + dock._geometry.thickness,
            right: frame.x + frame.width > dockRect.x + dockRect.width - dock._geometry.thickness,
        }[pos];
        check(!overlaps, `${pos}: janela maximizada não fica por baixo da dock`);
    }
    settings.reset('position');
    await sleep(1500);
}

async function testMinimize(win) {
    win.minimize();
    await sleep(1500);
    check(win.minimized, 'minimizar (efeito Gênio) termina');
    await screenshot('03-minimizada');
    win.unminimize();
    await sleep(1200);
    check(!win.minimized, 'restaurar depois de minimizar');
}

/**
 * Muda TODAS as opções do schema: liga/desliga, todos os valores das
 * listas e os extremos dos números. Erros aparecem no log do Shell, que o
 * script confere depois.
 */
async function testAllSettings(settings) {
    const schema = settings.settings_schema;
    let changes = 0;
    for (const key of schema.list_keys().sort()) {
        const info = schema.get_key(key);
        const original = settings.get_value(key);
        const type = info.get_value_type().dup_string();
        const [kind, range] = info.get_range().deep_unpack();
        const values = [];
        if (kind === 'enum') {
            values.push(...range.deep_unpack().map(v => new GLib.Variant('s', v)));
        } else if (kind === 'range') {
            const [lo, hi] = range.deep_unpack();
            values.push(new GLib.Variant(type, lo), new GLib.Variant(type, hi));
        } else if (type === 'b') {
            values.push(new GLib.Variant('b', !original.get_boolean()));
        }
        for (const value of values) {
            settings.set_value(key, value);
            changes++;
            await sleep(120);
        }
        settings.set_value(key, original);
        await sleep(60);
        if (!manager()) {
            check(false, `a dock sumiu depois de mudar "${key}"`);
            return;
        }
    }
    check(true, `${changes} mudanças de opções sem derrubar a dock`);
    await sleep(1500);
    await screenshot('04-depois-das-opcoes');
}

// ---------- Arrastar arquivos do leque ----------

/** Mouse virtual: o mesmo caminho de eventos de um mouse de verdade. */
class VirtualPointer {
    constructor() {
        const seat = global.stage.context.get_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }

    _now() {
        return GLib.get_monotonic_time();
    }

    async moveTo(x, y) {
        this._pointer.notify_absolute_motion(this._now(), x, y);
        await sleep(16);
    }

    /** Move e espera o cursor chegar de fato (o 1º evento às vezes se perde). */
    async moveAndSettle(x, y) {
        for (let i = 0; i < 20; i++) {
            await this.moveTo(x, y);
            const [px, py] = global.get_pointer();
            if (Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1)
                return;
            await sleep(50);
        }
    }

    async click(x, y) {
        await this.moveAndSettle(x, y);
        await sleep(150);
        this._pointer.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    async drag([x0, y0], [x1, y1]) {
        await this.moveAndSettle(x0, y0);
        await sleep(150);
        this._pointer.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await sleep(80);
        for (let i = 1; i <= 30; i++)
            await this.moveTo(x0 + (x1 - x0) * i / 30, y0 + (y1 - y0) * i / 30);
        await sleep(150);
        this._pointer.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    async ctrl(keycode) {
        const CTRL = 29;
        this._keyboard.notify_key(this._now(), CTRL, Clutter.KeyState.PRESSED);
        await sleep(40);
        this._keyboard.notify_key(this._now(), keycode, Clutter.KeyState.PRESSED);
        await sleep(40);
        this._keyboard.notify_key(this._now(), keycode, Clutter.KeyState.RELEASED);
        await sleep(40);
        this._keyboard.notify_key(this._now(), CTRL, Clutter.KeyState.RELEASED);
    }
}

function centerOf(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return [x + w / 2, y + h / 2];
}

function listDir(path) {
    return [...Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null)]
        .map(info => info.get_name());
}

async function waitWindowTitled(text, ms = 10000) {
    for (let t = 0; t < ms; t += 300) {
        const win = global.get_window_actors().map(a => a.meta_window)
            .find(w => (w.get_title() ?? '').includes(text));
        if (win)
            return win;
        await sleep(300);
    }
    return null;
}

/**
 * Uma pasta temporária vira pilha em leque; arrastamos os arquivos dela
 * para uma janela do Nautilus, para um lugar vazio e para o ícone de um app.
 */
async function testStackDrag(settings) {
    const stackDir = `${OUT}/pilha`;
    const destDir = `${OUT}/destino`;
    GLib.mkdir_with_parents(stackDir, 0o755);
    GLib.mkdir_with_parents(destDir, 0o755);
    for (const n of [1, 2, 3])
        GLib.file_set_contents(`${stackDir}/nota-${n}.txt`, `arquivo ${n}\n`);
    const stackUri = Gio.File.new_for_path(stackDir).get_uri();
    settings.set_strv('stack-folders', [stackUri]);
    settings.set_enum('stack-view', 2);     // leque
    Main.overview.hide();
    await sleep(1500);

    const dock = () => manager()._docks[0];
    const stack = () => dock().getItems().find(i => i.key === `stack:${stackUri}`);
    const mouse = new VirtualPointer();

    const openFan = async () => {
        stack().openPopup();
        await sleep(900);
        return (stack()._popup?._fanItems ?? []).map(f => f.button).filter(b => b.file);
    };

    // 1. Janela do Nautilus: o arquivo vai para a área de transferência.
    GLib.spawn_command_line_async(`nautilus --new-window ${destDir}`);
    const nautilus = await waitWindowTitled('destino');
    if (!nautilus) {
        log('INFO', 'Nautilus não abriu; pulando o arraste para janela');
    } else {
        await sleep(1500);
        let files = await openFan();
        check(files.length === 3, 'o leque mostra os arquivos da pasta');
        const r = nautilus.get_frame_rect();
        await mouse.drag(centerOf(files[0]), [r.x + r.width / 2, r.y + r.height / 2]);
        await sleep(300);
        const types = St.Clipboard.get_default().get_mimetypes(St.ClipboardType.CLIPBOARD);
        check(types.includes('x-special/gnome-copied-files'),
            'soltar na janela do Nautilus copia o arquivo (formato do Nautilus)');
        check(global.display.focus_window === nautilus, 'a janela onde o arquivo caiu vem para a frente');
        check(stack()._dropEffects.size > 0, 'aparece o aviso "cole com Ctrl+V"');
        await screenshot('05-arquivo-solto-na-janela');
        await mouse.ctrl(47);   // Ctrl+V
        await sleep(2500);
        check(listDir(destDir).length === 1, 'Ctrl+V no Nautilus cola o arquivo');
        nautilus.minimize();
        await sleep(800);

        // 2. Lugar vazio: volta para a pilha, sem mexer na área de transferência.
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, 'antes');
        files = await openFan();
        await mouse.drag(centerOf(files[1]), [300, 300]);
        await sleep(30);
        const flying = stack()._dropEffects.size > 0;
        await sleep(800);
        const plain = St.Clipboard.get_default().get_mimetypes(St.ClipboardType.CLIPBOARD);
        check(flying && stack()._dropEffects.size === 0 && !plain.includes('x-special/gnome-copied-files'),
            'soltar num lugar vazio: o arquivo volta voando para a pilha');
        check(stack()._popup === null, 'o leque fecha depois do arraste');
    }

    // 3. Clique simples continua abrindo o arquivo.
    let files = await openFan();
    const clicked = files[0].file.get_basename();
    await mouse.click(...centerOf(files[0]));
    const opened = await waitWindowTitled(clicked);
    check(Boolean(opened), 'clique simples abre o arquivo');
    opened?.delete(global.get_current_time());
    await sleep(1000);

    // 4. Ícone de um app na dock: abre o arquivo com ele.
    const editor = dock().getItems().find(i => i.app?.get_id?.() === 'org.gnome.TextEditor.desktop');
    if (editor) {
        files = await openFan();
        const name = files[2].file.get_basename();
        await mouse.drag(centerOf(files[2]), centerOf(editor));
        const viaIcon = await waitWindowTitled(name);
        check(Boolean(viaIcon), 'soltar no ícone de um app abre o arquivo com ele');
        viaIcon?.delete(global.get_current_time());
        await sleep(800);
    } else {
        log('INFO', 'Editor de Texto não está na dock; pulando o arraste para o ícone');
    }

    settings.reset('stack-folders');
    settings.reset('stack-view');
    await sleep(800);
}

// ---------- Modo Painel (barra de tarefas) ----------

function findActor(root, pred) {
    if (pred(root))
        return root;
    for (const child of root.get_children()) {
        const found = findActor(child, pred);
        if (found)
            return found;
    }
    return null;
}

/** Indicadores de mentira, como os de outras extensões. */
function fakeIndicators() {
    const icon = new PanelMenu.Button(0.5, 'Teste ícone');
    icon.add_child(new St.Icon({icon_name: 'weather-clear-symbolic', style_class: 'system-status-icon'}));
    icon.menu.addMenuItem(new PopupMenu.PopupMenuItem('Item do ícone'));
    Main.panel.addToStatusArea('orla-test-icon', icon);
    const text = new PanelMenu.Button(0.5, 'Teste texto');
    text.add_child(new St.Label({text: '23°C', y_align: Clutter.ActorAlign.CENTER}));
    text.menu.addMenuItem(new PopupMenu.PopupMenuItem('Item do texto'));
    Main.panel.addToStatusArea('orla-test-text', text);
    return [icon, text];
}

async function testPanelMode(settings) {
    const [fakeIcon, fakeText] = fakeIndicators();
    const dateMenu = Main.panel.statusArea.dateMenu;
    const originalParent = dateMenu.container.get_parent();
    settings.set_string('bar-style', 'taskbar');
    settings.set_boolean('taskbar-merge-panel', true);
    Main.overview.hide();
    await sleep(2500);
    const dock = manager()._docks[0];

    check(dock.root.contains(dateMenu.container), 'painel: o relógio do GNOME vai para a barra');
    check(!Main.layoutManager.panelBox.visible, 'painel: a barra de cima do GNOME some');
    const quick = Main.panel.statusArea.quickSettings;
    check(dock.root.contains(quick.container), 'painel: as configurações rápidas vão para a barra');
    check(!dateMenu._clockDisplay.visible, 'painel: o texto original do relógio fica escondido');
    const clock = findActor(dock.root, a => a.constructor?.name?.includes('PanelClock') ||
        a.has_style_class_name?.('orla-panel-clock'));
    const time = clock && findActor(clock, a => a.has_style_class_name?.('orla-panel-clock-time'));
    const date = clock && findActor(clock, a => a.has_style_class_name?.('orla-panel-clock-date'));
    const now = GLib.DateTime.new_now_local();
    check(Boolean(time) && time.text.includes(now.format('%M')), `painel: relógio mostra a hora (${time?.text})`);
    check(Boolean(date) && date.visible && date.text.length > 0, `painel: relógio mostra a data (${date?.text})`);

    const ws = findActor(dock.root, a => a.has_style_class_name?.('orla-ws'));
    const dots = ws?.get_children() ?? [];
    const active = global.workspace_manager.get_active_workspace_index();
    check(dots.length === global.workspace_manager.get_n_workspaces() &&
        dots[active]?.has_style_class_name('orla-ws-active'),
    `painel: um ponto por workspace e o atual destacado (${dots.length})`);
    await screenshot('06-modo-painel');

    // Rodinha no indicador: vai para o próximo workspace.
    const wsButton = ws.get_parent();
    const before = global.workspace_manager.get_active_workspace_index();
    const mouse = new VirtualPointer();
    await mouse.moveAndSettle(...centerOf(wsButton));
    mouse._pointer.notify_discrete_scroll(GLib.get_monotonic_time(), Clutter.ScrollDirection.DOWN,
        Clutter.ScrollSource.WHEEL);
    await sleep(800);
    const after = global.workspace_manager.get_active_workspace_index();
    check(after === before + 1 && dots[after]?.has_style_class_name('orla-ws-active'),
        'painel: a rodinha no indicador troca de workspace');
    global.workspace_manager.get_workspace_by_index(before).activate(global.get_current_time());
    await sleep(800);

    // Clique no relógio abre o calendário, preso à barra.
    await mouse.click(...centerOf(dateMenu.container));
    await sleep(600);
    check(dateMenu.menu.isOpen, 'painel: clicar no relógio abre o calendário');
    await screenshot('07-calendario');
    dateMenu.menu.close();
    await sleep(500);

    await mouse.click(...centerOf(quick.container));
    await sleep(600);
    check(quick.menu.isOpen, 'painel: clicar nas configurações rápidas abre o menu');
    quick.menu.close();
    await sleep(500);

    // Notificação: o aviso aparece acima da barra, no canto do relógio.
    Main.notify('Orla', 'Teste de notificação');
    await sleep(1500);
    const bin = Main.messageTray._bannerBin;
    const [, binY] = bin.get_transformed_position();
    const [barX, barY] = dock.backgroundActor.get_transformed_position();
    const [binX] = bin.get_transformed_position();
    const [clockX] = dateMenu.container.get_transformed_position();
    const bottom = binY + bin.height;
    check(bin.height > 0 && bottom <= barY + 1 && bottom > barY - 60 && binX + bin.width >= clockX,
        `painel: o aviso de notificação aparece acima da barra, no canto (fim do aviso em y=${Math.round(bottom)}, barra em y=${Math.round(barY)})`);
    await screenshot('07b-notificacao');
    Main.messageTray._hideNotification?.(false);
    await sleep(800);
    void barX;

    // Bandeja: o ícone fica atrás da seta; o indicador com texto, na barra.
    const panel = dock._panel;
    const tray = panel._tray;
    check(dock.root.contains(fakeText.container) && !dock.root.contains(fakeIcon.container),
        'bandeja: indicador com texto na barra, ícone escondido na bandeja');
    check(tray._arrow.get_parent() !== null && tray._arrow.mapped, 'bandeja: a seta aparece');
    await mouse.click(...centerOf(tray._arrow));
    await sleep(600);
    check(tray.isOpen && tray._popup.contains(fakeIcon.container), 'bandeja: a seta abre a bandeja com o ícone');
    await screenshot('07c-bandeja');
    await mouse.click(...centerOf(fakeIcon.container));
    await sleep(600);
    check(fakeIcon.menu.isOpen, 'bandeja: clicar no ícone abre o menu dele');
    fakeIcon.menu.close();
    await sleep(400);
    check(tray.isOpen, 'bandeja: fechar o menu do ícone mantém a bandeja aberta');
    // Gerenciar: fixar o ícone na barra.
    tray.moveToPanel(tray.classify().tray.find(i => i.name === 'orla-test-icon'), true);
    await sleep(800);
    check(panel.endBox.contains(fakeIcon.container), 'bandeja: "Mostrar na barra" fixa o ícone na barra');
    tray.resetChoices();
    await sleep(800);
    check(!dock.root.contains(fakeIcon.container), 'bandeja: "Restaurar" devolve o ícone à bandeja');
    await mouse.click(200, 200);
    await sleep(500);
    check(!tray.isOpen, 'bandeja: clicar fora fecha a bandeja');

    // Volta para a dock: o relógio volta para o painel do GNOME, como era.
    settings.reset('bar-style');
    settings.reset('taskbar-merge-panel');
    await sleep(2500);
    check(dateMenu.container.get_parent() === originalParent && dateMenu._clockDisplay.visible,
        'painel: ao sair do modo Painel, o relógio volta para o painel do GNOME');
    check(Main.layoutManager.panelBox.visible && Main.panel.contains(quick.container),
        'painel: a barra de cima e as configurações rápidas voltam como eram');
    check(Main.panel.contains(fakeIcon.container) && Main.panel.contains(fakeText.container),
        'bandeja: os indicadores voltam para o painel do GNOME');
    fakeIcon.destroy();
    fakeText.destroy();
}

// ---------- Menu Iniciar ----------

function texts(actor, out = []) {
    if (actor instanceof St.Label && actor.visible)
        out.push(actor.text);
    else if (actor instanceof St.Button && actor.label)
        out.push(actor.label);
    for (const child of actor.get_children())
        texts(child, out);
    return out;
}

async function testStartMenu(settings) {
    settings.set_string('bar-style', 'taskbar');
    settings.set_boolean('start-menu', true);
    Main.overview.hide();
    await sleep(2000);
    const dock = manager()._docks[0];
    const mouse = new VirtualPointer();
    await mouse.click(...centerOf(dock.startButton));
    await sleep(700);
    const menu = dock._startMenu;
    check(Boolean(menu?.isOpen), 'menu iniciar: o botão Iniciar abre o menu');
    if (!menu?.isOpen)
        return;
    check(menu._home._grid.get_n_children() > 0, 'menu iniciar: mostra os fixados');
    await screenshot('11-menu-iniciar');

    menu._entry.set_text('2+3*4');
    await sleep(300);
    check(texts(menu._search.actor).some(t => t.includes('14')), 'menu iniciar: a busca faz contas (2+3*4 = 14)');
    menu._entry.set_text('calc');
    await sleep(600);
    const found = texts(menu._search.actor);
    check(found.some(t => /calcul/i.test(t)), `menu iniciar: a busca acha apps (${found.slice(0, 4).join(' | ')})`);
    await screenshot('12-menu-busca');
    menu._entry.set_text('> echo oi');
    await sleep(300);
    check(Boolean(menu._search._commandRun), 'menu iniciar: ">" vira comando');
    menu._entry.set_text('');
    await sleep(300);

    menu.showAllApps();
    await sleep(500);
    check(menu._allApps._headers.size > 0, 'menu iniciar: "Todos os apps" lista os apps por letra');
    await screenshot('13-menu-todos');
    menu.showHome();
    await sleep(300);

    // Fixar, criar pasta e abrir a pasta.
    const apps = menu.data.allApps().filter(app => !menu.data.isPinned(app)).slice(0, 2);
    apps.forEach(app => menu.data.pin(app));
    await sleep(300);
    check(apps.every(app => menu.data.isPinned(app)), 'menu iniciar: "Fixar no Início" funciona');
    const [a, b] = apps.map(app => app.get_id());
    menu.data.makeFolder(a, b, menu.newFolderName());
    await sleep(400);
    const folder = menu.data.folders[0];
    check(Boolean(folder) && folder.apps.length === 2, 'menu iniciar: soltar um app em outro cria uma pasta');
    menu.showFolder(folder.id);
    await sleep(400);
    check(menu._layer.visible, 'menu iniciar: a pasta abre');
    await screenshot('14-menu-pasta');
    const [px, py] = menu._box.get_transformed_position();
    menu.showContextMenu(menu.appMenu(apps[0]), px + 100, py + 200);
    await sleep(300);
    check(texts(menu._layer).length >= 3, `menu iniciar: o menu de contexto abre (${texts(menu._layer).join(' | ')})`);
    await screenshot('15-menu-contexto');
    menu._hideLayer();

    // Esc fecha.
    const kb = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    kb.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.PRESSED);
    kb.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.RELEASED);
    await sleep(500);
    check(!menu.isOpen, 'menu iniciar: Esc fecha o menu');

    for (const key of ['start-menu-pinned', 'start-menu-folders', 'bar-style', 'start-menu'])
        settings.reset(key);
    await sleep(1500);
}

// ---------- Vidro ----------

async function testGlass(settings) {
    Main.overview.hide();
    settings.set_boolean('blur-enabled', true);
    await sleep(1500);
    const effect = manager()._docks[0]._blurEffect;
    check(effect.enabled && !effect._neutral, 'vidro: o efeito liga com o material da Orla');
    await screenshot('08-vidro');
    // Cada parte do material pode ser ligada sozinha sem erro de shader.
    for (const key of ['blur-refraction', 'blur-dispersion', 'blur-sheen', 'blur-grain', 'blur-adaptive'])
        settings.set_double(key, 1.0);
    settings.set_double('blur-brightness', 1.0);
    await sleep(800);
    await screenshot('09-vidro-maximo');
    for (const key of ['blur-refraction', 'blur-dispersion', 'blur-sheen', 'blur-grain', 'blur-adaptive',
        'blur-brightness'])
        settings.reset(key);
    // Fundo estático cheio de detalhes: aqui dá para ver a refração.
    settings.set_string('blur-mode', 'static');
    settings.set_string('blur-static-preset', 'cyberpunk');
    settings.set_double('blur-intensity', 6);
    if (GLib.getenv('ORLA_TEST_IMAGE')) {
        settings.set_string('blur-static-source', 'custom');
        settings.set_string('blur-custom-photo', GLib.getenv('ORLA_TEST_IMAGE'));
        settings.set_double('blur-adaptive', 0);
        settings.set_double('blur-tint-opacity', 0);
        settings.set_double('blur-intensity', 1);
        settings.set_double('blur-refraction', 1);
        settings.set_double('blur-dispersion', 1);
    }
    await sleep(1200);
    await screenshot('09b-vidro-estatico');
    settings.set_double('blur-refraction', 0);
    settings.set_double('blur-dispersion', 0);
    await sleep(800);
    await screenshot('09c-vidro-estatico-sem-refracao');
    for (const key of ['blur-mode', 'blur-static-preset', 'blur-intensity', 'blur-refraction', 'blur-dispersion',
        'blur-static-source', 'blur-custom-photo', 'blur-adaptive', 'blur-tint-opacity'])
        settings.reset(key);
    settings.set_string('bar-style', 'taskbar');
    await sleep(1500);
    await screenshot('10-vidro-barra');
    settings.reset('bar-style');
    settings.reset('blur-enabled');
    await sleep(1000);
}

async function testDisableEnable() {
    await Main.extensionManager.disableExtension(UUID);
    await sleep(1000);
    check(orlaActors() === 0, 'desativar não deixa atores para trás');
    await Main.extensionManager.enableExtension(UUID);
    await sleep(2000);
    check(orla()?.state === 1 && orlaActors() >= 1, 'reativar funciona');
}

async function run() {
    await sleep(3000);
    await testStartup();
    const settings = orla().stateObj.getSettings();
    const win = await openWindow();
    check(Boolean(win), 'abrir uma janela de teste');
    if (win) {
        await testHug(win, settings);
        await testMinimize(win);
        // Fora do caminho: os arrastes abaixo precisam de espaço livre.
        win.minimize();
        await sleep(800);
    }
    await testStackDrag(settings);
    await testPanelMode(settings);
    await testStartMenu(settings);
    await testGlass(settings);
    if (!QUICK)
        await testAllSettings(settings);
    await testDisableEnable();
    log('DONE');
}

// Fora da classe: ao reativar a Orla, o Shell também reativa esta extensão,
// e os testes não podem começar de novo.
let started = false;

export default class OrlaTestExtension extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        const start = () => run()
            .catch(e => log('FAIL', `erro nos testes: ${e}\n${e.stack}`))
            .finally(() => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                global.context.terminate();
                return GLib.SOURCE_REMOVE;
            }));
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connect('startup-complete', start);
        else
            start();
    }

    disable() {}
}
