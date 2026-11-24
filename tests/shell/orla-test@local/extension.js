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
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
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

const startMenu = () => manager()?._startMenu ?? null;
const pressEsc = async () => {
    const kb = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    kb.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.PRESSED);
    kb.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.RELEASED);
    await sleep(500);
};

async function waitFor(predicate, ms = 3000) {
    for (let t = 0; t < ms; t += 100) {
        if (predicate())
            return true;
        await sleep(100);
    }
    return predicate();
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
    const menu = startMenu();
    check(Boolean(menu?.isOpen), 'menu iniciar: o botão Iniciar abre o menu');
    if (!menu?.isOpen)
        return;
    const style = menu.style;
    check(style.id === 'modern', `menu iniciar: estilo padrão é o Clássico moderno (${style.id})`);
    check(style._pinned._grid.get_n_children() > 0, 'menu iniciar: mostra os fixados (favoritos do GNOME)');
    await screenshot('11-menu-iniciar');

    style.entry.set_text('2+3*4');
    await sleep(300);
    check(texts(style.results.actor).some(t => t.includes('14')), 'menu iniciar: a busca faz contas (2+3*4 = 14)');
    style.entry.set_text('calc');
    await sleep(600);
    const found = texts(style.results.actor);
    check(found.some(t => /calcul/i.test(t)), `menu iniciar: a busca acha apps (${found.slice(0, 4).join(' | ')})`);
    check(!style._home.visible, 'menu iniciar: durante a busca, os resultados tomam o lugar do início');
    await screenshot('12-menu-busca');
    style.entry.set_text('> echo oi');
    await sleep(300);
    check(Boolean(style.results._commandRun), 'menu iniciar: ">" vira comando');
    style.entry.set_text('');
    await sleep(300);

    style.showAll(true);
    await sleep(500);
    check(style._alpha.letters.length > 0, 'menu iniciar: "Todos os apps" lista os apps por letra');
    await screenshot('13-menu-todos');
    check(style.escape() && style._home.visible, 'menu iniciar: Esc volta de "Todos os apps" para o início');

    // Fixar = favoritos do GNOME (os mesmos da dock).
    const app = menu.data.allApps().find(a => !menu.data.isPinned(a));
    const before = global.settings.get_strv('favorite-apps');
    menu.data.pin(app);
    await sleep(300);
    check(global.settings.get_strv('favorite-apps').includes(app.get_id()),
        'menu iniciar: "Fixar" acrescenta aos favoritos do GNOME');
    menu.data.movePinned(app, 0);
    await sleep(300);
    check(menu.data.pinnedApps()[0]?.get_id() === app.get_id(), 'menu iniciar: reordenar muda a ordem dos favoritos');
    global.settings.set_strv('favorite-apps', before);
    await sleep(300);

    const [px, py] = menu._box.get_transformed_position();
    menu.showContextMenu(menu.appMenu(app), px + 100, py + 200);
    await sleep(300);
    const items = texts(menu._layer);
    check(items.length >= 3 && items.some(t => /Fixar|Pin/.test(t)),
        `menu iniciar: o menu de contexto abre (${items.join(' | ')})`);
    await screenshot('15-menu-contexto');
    menu.hideLayer();

    await pressEsc();
    check(!menu.isOpen, 'menu iniciar: Esc fecha o menu');

    // Cada estilo abre, cabe na tela e busca.
    const monitor = Main.layoutManager.primaryMonitor;
    for (const id of ['classic', 'modern', 'categories', 'alphabetical', 'launchpad']) {
        settings.set_string('start-menu-style', id);
        await sleep(200);
        manager().openStartMenu(dock);
        await sleep(600);
        const m = startMenu();
        check(m.isOpen && m.style.id === id, `estilo ${id}: abre`);
        const [bx, by] = m._box.get_transformed_position();
        const fits = bx >= monitor.x && by >= monitor.y &&
            bx + m._box.width <= monitor.x + monitor.width && by + m._box.height <= monitor.y + monitor.height;
        check(fits, `estilo ${id}: cabe no monitor (${Math.round(bx)},${Math.round(by)} ${m._box.width}x${m._box.height})`);
        await screenshot(`16-estilo-${id}`);
        m.style.entry.set_text('calc');
        await sleep(600);
        check(texts(m.style.results.actor).some(t => /calcul/i.test(t)), `estilo ${id}: a busca funciona`);
        m.style.entry.set_text('');
        if (id === 'categories') {
            const row = m.style._list.get_first_child();
            row.emit('clicked', 0);
            await sleep(400);
            check(m._layer.visible && texts(m._layer).length > 1, 'estilo categories: a categoria abre o submenu');
            await screenshot('17-estilo-categories-submenu');
            m.hideLayer();
        }
        if (id === 'alphabetical') {
            m.style._showLetters(true);
            await sleep(300);
            check(m.style._letters.visible, 'estilo alphabetical: a grade de letras abre');
            await screenshot('17-estilo-alphabetical-letras');
            m.style.escape();
        }
        m.close();
        await sleep(400);
    }

    // Posição e tamanho.
    settings.set_string('start-menu-style', 'modern');
    settings.set_string('start-menu-position', 'center');
    await sleep(200);
    manager().openStartMenu(dock);
    await sleep(500);
    let m = startMenu();
    const [cx, cy] = m._box.get_transformed_position();
    const middle = cx + m._box.width / 2;
    check(Math.abs(middle - (monitor.x + monitor.width / 2)) < 20, `posição centro: centralizado (${Math.round(middle)})`);
    void cy;
    m.close();
    await sleep(400);
    settings.set_string('start-menu-position', 'corner');
    manager().openStartMenu(dock);
    await sleep(500);
    m = startMenu();
    const [kx] = m._box.get_transformed_position();
    check(kx < monitor.x + 40, `posição canto: no canto esquerdo (${Math.round(kx)})`);
    const mediumWidth = m._box.width;
    m.close();
    await sleep(400);
    settings.set_string('start-menu-size', 'large');
    settings.set_boolean('start-menu-animate', false);
    manager().openStartMenu(dock);
    await sleep(200);
    m = startMenu();
    check(m._box.width > mediumWidth, `tamanho grande: mais largo (${mediumWidth} → ${m._box.width})`);
    check(m._frame.opacity === 255 && m._frame.scale_x === 1, 'sem animação: aparece na hora');
    m.close();
    await sleep(300);

    for (const key of ['bar-style', 'start-menu', 'start-menu-style', 'start-menu-position', 'start-menu-size',
        'start-menu-animate'])
        settings.reset(key);
    await sleep(1500);
}

/**
 * "Usar menu iniciar no lugar da App Grid": cada caminho do GNOME que
 * abriria a App Grid abre o menu; um Super sozinho continua abrindo a Visão
 * Geral; desligar devolve as funções originais do GNOME.
 */
async function testAppGridHook(settings) {
    settings.reset('start-menu-replace-grid');
    Main.overview.hide();
    await sleep(1000);
    const controls = Main.overview._overview.controls;
    const adjustment = controls._stateAdjustment;
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const originalShow = Main.overview.show;
    const originalEase = adjustment.ease;
    check(!own(Main.overview, 'show') && !own(adjustment, 'ease'), 'App Grid: desligado, nada do GNOME é trocado');

    // Desligado: showApps abre a App Grid de verdade.
    Main.overview.showApps();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress);
    await sleep(300);
    check(Main.overview.visible && controls.dash.showAppsButton.checked && !startMenu()?.isOpen,
        'App Grid: desligado, a App Grid do GNOME abre');
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible);
    await sleep(500);

    settings.set_boolean('start-menu-replace-grid', true);
    await sleep(300);
    check(own(Main.overview, 'show') && own(adjustment, 'ease'), 'App Grid: ligado, os dois pontos são interceptados');

    // 1) Main.overview.showApps() (o botão de apps da dock, por exemplo).
    Main.overview.showApps();
    await sleep(600);
    check(startMenu()?.isOpen && !Main.overview.visible, 'App Grid: showApps() abre o menu');
    startMenu().close();
    await sleep(400);

    // 2) Super+A com a Visão Geral fechada (o mesmo código do atalho).
    controls._toggleAppsPage();
    await sleep(600);
    check(startMenu()?.isOpen && !Main.overview.visible, 'App Grid: Super+A abre o menu');
    startMenu().close();
    await sleep(400);

    // 3) Um Super: a Visão Geral normal.
    global.display.emit('overlay-key');
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress);
    await sleep(300);
    check(Main.overview.visible && !startMenu()?.isOpen, 'App Grid: um Super ainda abre a Visão Geral');

    // 4) Com a Visão Geral aberta, o botão de grade do dash: fecha e abre o menu.
    controls.dash.showAppsButton.checked = true;
    await waitFor(() => startMenu()?.isOpen, 3000);
    await waitFor(() => !Main.overview.visible, 3000);
    await sleep(200);
    check(startMenu()?.isOpen && !Main.overview.visible && !controls.dash.showAppsButton.checked,
        'App Grid: botão de grade do dash fecha a Visão Geral e abre o menu');
    startMenu().close();
    await sleep(400);

    // 5) Super duas vezes (o 2º com a Visão Geral ainda abrindo).
    global.display.emit('overlay-key');
    await sleep(60);
    global.display.emit('overlay-key');
    const t0 = GLib.get_monotonic_time();
    await waitFor(() => startMenu()?.isOpen, 3000);
    const openedMs = (GLib.get_monotonic_time() - t0) / 1000;
    check(openedMs < 120, `App Grid: Super duas vezes — o menu começa a abrir junto com a saída da Visão Geral (${Math.round(openedMs)} ms)`);
    await waitFor(() => !Main.overview.visible, 3000);
    await sleep(200);
    const entry = startMenu()?.style?.entry;
    check(startMenu()?.isOpen && !Main.overview.visible, 'App Grid: Super duas vezes abre o menu');
    check(Boolean(entry) && global.stage.get_key_focus() === entry.clutter_text,
        'App Grid: depois que a Visão Geral sai, o teclado continua no menu');
    await screenshot('18-menu-duplo-super');
    startMenu().close();
    await sleep(400);

    // Desligar devolve tudo como era.
    settings.set_boolean('start-menu-replace-grid', false);
    await sleep(300);
    check(!own(Main.overview, 'show') && !own(adjustment, 'ease') &&
        Main.overview.show === originalShow && adjustment.ease === originalEase,
    'App Grid: desligar devolve as funções originais do GNOME');
    Main.overview.showApps();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress);
    await sleep(300);
    check(Main.overview.visible && controls.dash.showAppsButton.checked && !startMenu()?.isOpen,
        'App Grid: depois de desligar, a App Grid do GNOME volta');
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible);
    await sleep(500);

    // Fica ligado para o teste de desativar a extensão conferir a limpeza.
    settings.set_boolean('start-menu-replace-grid', true);
    await sleep(300);
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

// ---------- Contador de notificações (bolinha no ícone) ----------

async function testNotificationBadges() {
    const counter = manager().notificationCounter;
    const app = Shell.AppSystem.get_default().lookup_app('org.gnome.TextEditor.desktop');
    if (!app) {
        log('INFO', 'Editor de Texto não instalado; pulando o contador de notificações');
        return;
    }
    const id = app.get_id();
    const before = counter.count(id);
    const source = new MessageTray.Source({
        title: app.get_name(),
        policy: MessageTray.NotificationPolicy.newForApp(app),
    });
    Main.messageTray.add(source);
    const notes = [1, 2].map(n => new MessageTray.Notification({source, title: `Teste ${n}`, body: 'contador'}));
    notes.forEach(note => source.addNotification(note));
    await sleep(500);
    check(counter.count(id) === before + 2, `contador: duas notificações do app contam 2 (${counter.count(id)})`);
    notes[0].destroy();
    await sleep(500);
    check(counter.count(id) === before + 1, `contador: dispensar uma baixa para 1 (${counter.count(id)})`);
    source.destroy();
    await sleep(500);
    check(counter.count(id) === before, `contador: sem a fonte, volta a ${before} (${counter.count(id)})`);
}

// ---------- Barra do GNOME embaixo com a dock em cima ----------

async function testPanelMover(settings, win) {
    const box = Main.layoutManager.panelBox;
    const monitor = Main.layoutManager.primaryMonitor;
    const panelTop = () => box.get_transformed_position()[1];
    const atBottom = () => Math.abs(panelTop() - (monitor.y + monitor.height - box.height)) < 1;
    const atTop = () => Math.abs(panelTop() - monitor.y) < 1 && box.translation_y === 0;
    const arrowOf = name => Main.panel.statusArea[name]?.menu?._boxPointer?._userArrowSide;
    Main.overview.hide();
    settings.set_enum('position', 1);   // Superior
    await sleep(2500);
    const dock = () => manager()._docks[0];

    check(atBottom(), `barra embaixo: a barra desce para a borda de baixo (y=${panelTop()})`);
    check(Main.panel.has_style_class_name('orla-panel-bottom'), 'barra embaixo: a classe orla-panel-bottom é aplicada');
    check(Math.abs(dock().dockRect.y - monitor.y) < 1, `barra embaixo: a dock usa a borda de cima de verdade (y=${dock().dockRect.y})`);
    check(arrowOf('dateMenu') === St.Side.BOTTOM && arrowOf('quickSettings') === St.Side.BOTTOM,
        'barra embaixo: calendário e configurações rápidas abrem para cima');

    const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    check(area.y + area.height <= panelTop() + 1 && area.y >= dock().dockRect.y + 1,
        `barra embaixo: a área livre fica entre a dock e a barra (${area.y}..${area.y + area.height})`);

    // Uma janela própria (as dos cenários anteriores podem ter sido fechadas).
    win = await openWindow();
    if (win) {
        Main.activateWindow(win);
        win.maximize();
        await sleep(1300);
        const r = win.get_frame_rect();
        check(r.y + r.height <= panelTop() + 1, `barra embaixo: janela maximizada para acima da barra (fim em ${r.y + r.height})`);
        await screenshot('16-barra-embaixo-maximizada');
        win.unmaximize();
        win.delete(global.get_current_time());
        await sleep(800);
    }

    // Menu de verdade: abre acima da barra.
    const quick = Main.panel.statusArea.quickSettings;
    quick.menu.open();
    await sleep(600);
    const [, menuY] = quick.menu.actor.get_transformed_position();
    check(menuY + quick.menu.actor.height <= panelTop() + 1, 'barra embaixo: o menu das configurações rápidas abre acima da barra');
    await screenshot('17-barra-embaixo-menu');
    quick.menu.close();
    await sleep(400);

    // Indicador acrescentado depois (como o de outra extensão).
    const late = new PanelMenu.Button(0.5, 'Tarde');
    late.add_child(new St.Icon({icon_name: 'starred-symbolic', style_class: 'system-status-icon'}));
    Main.panel.addToStatusArea('orla-test-late', late);
    await sleep(500);
    check(late.menu._boxPointer._userArrowSide === St.Side.BOTTOM, 'barra embaixo: indicador novo também abre para cima');

    // Aviso de notificação: abaixo da dock.
    Main.notify('Orla', 'Aviso com a dock em cima');
    await sleep(1500);
    const banner = Main.messageTray._bannerBin;
    const [, by] = banner.get_transformed_position();
    check(banner.height > 0 && by >= dock().dockRect.y + dock().geometry.thickness - 1,
        `barra embaixo: o aviso aparece abaixo da dock (y=${Math.round(by)})`);
    await screenshot('18-barra-embaixo-aviso');
    Main.messageTray._hideNotification?.(false);
    await sleep(800);

    // Visão geral e canto ativo.
    Main.overview.show();
    await sleep(1200);
    check(Main.overview.visible && atBottom(), 'barra embaixo: a visão geral abre com a barra embaixo');
    await screenshot('19-barra-embaixo-visao-geral');
    Main.overview.hide();
    await sleep(1000);
    const corner = Main.layoutManager.hotCorners.find(Boolean);
    check(Boolean(corner) && corner._x === monitor.x && corner._y === monitor.y,
        'barra embaixo: o canto ativo continua no canto de cima à esquerda');

    // Bloquear e desbloquear.
    Main.sessionMode.pushMode('unlock-dialog');
    await sleep(1200);
    check(atTop() && !Main.panel.has_style_class_name('orla-panel-bottom'), 'barra embaixo: na tela bloqueada a barra volta ao topo');
    Main.sessionMode.popMode('unlock-dialog');
    await sleep(1500);
    check(atBottom(), 'barra embaixo: ao desbloquear, a barra volta para baixo');

    // Trocar a posição várias vezes, rápido.
    for (const pos of [0, 1, 0, 1, 2, 1, 0, 1])
        settings.set_enum('position', pos);
    await sleep(2500);
    check(atBottom() && arrowOf('dateMenu') === St.Side.BOTTOM, 'barra embaixo: trocas rápidas terminam no lugar certo');

    // Desligar a opção: a barra sobe e a dock desce para baixo dela.
    settings.set_boolean('panel-to-bottom', false);
    await sleep(1500);
    check(atTop() && Math.abs(dock().dockRect.y - (monitor.y + box.height)) < 1,
        'barra embaixo: com a opção desligada, a barra fica em cima e a dock logo abaixo');
    settings.reset('panel-to-bottom');
    await sleep(1500);

    // Desativar a extensão com a dock em cima: nada fica para trás.
    await Main.extensionManager.disableExtension(UUID);
    await sleep(800);
    check(atTop() && !Main.panel.has_style_class_name('orla-panel-bottom') && arrowOf('dateMenu') === St.Side.TOP &&
        late.menu._boxPointer._userArrowSide === St.Side.TOP && banner.translation_y === 0,
    'barra embaixo: desativar devolve a barra, os menus e os avisos como eram');
    await Main.extensionManager.enableExtension(UUID);
    await sleep(2000);
    check(atBottom(), 'barra embaixo: reativar com a dock em cima leva a barra para baixo de novo');

    // Volta para baixo: tudo no lugar original.
    settings.reset('position');
    await sleep(1800);
    check(atTop() && arrowOf('dateMenu') === St.Side.TOP, 'barra embaixo: dock embaixo de novo, barra no topo e menus como antes');
    late.destroy();
}

// ---------- Tela bloqueada ----------

/** No modo de bloqueio nada da Orla pode ficar na tela (regra do EGO). */
async function testLockScreen(settings) {
    settings.set_string('bar-style', 'taskbar');
    await sleep(1500);
    Main.sessionMode.pushMode('unlock-dialog');
    await sleep(1200);
    check(orlaActors() === 0, 'bloqueio: nenhuma dock na tela bloqueada');
    check(Main.layoutManager.panelBox.visible, 'bloqueio: a barra de cima do GNOME volta');
    Main.sessionMode.popMode('unlock-dialog');
    await sleep(1500);
    check(orlaActors() >= 1, 'bloqueio: ao desbloquear, a dock volta');
    settings.reset('bar-style');
    await sleep(1200);
}

// ---------- Arquivos recentes do Menu Iniciar ----------

async function testRecentFiles() {
    const data = manager()._docks[0];
    const file = Gio.File.new_for_path(`${OUT}/relatorio-recente.txt`);
    GLib.file_set_contents(file.get_path(), 'teste\n');
    const when = GLib.DateTime.new_now_utc().format_iso8601();
    const xbel = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"><bookmark href="${file.get_uri()}" added="${when}" modified="${when}" visited="${when}"/></xbel>`;
    GLib.file_set_contents(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']), xbel);
    const {StartData} = await import('../orla-dock@viniciusbispo19/lib/start/data.js');
    const start = new StartData(orla().stateObj.getSettings(), manager().appTracker);
    const recent = await start.recentFiles(5);
    start.destroy();
    check(recent.some(entry => entry.name === 'relatorio-recente.txt'),
        `menu iniciar: "Continuar de onde parou" acha os arquivos recentes (${recent.map(e => e.name).join(', ')})`);
    void data;
}

async function testDisableEnable() {
    const adjustment = Main.overview._overview.controls._stateAdjustment;
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    await Main.extensionManager.disableExtension(UUID);
    await sleep(1000);
    check(orlaActors() === 0, 'desativar não deixa atores para trás');
    check(!own(Main.overview, 'show') && !own(adjustment, 'ease'),
        'desativar com o menu no lugar da App Grid devolve as funções do GNOME');
    Main.overview.showApps();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress);
    await sleep(300);
    check(Main.overview.visible && Main.overview._overview.controls.dash.showAppsButton.checked,
        'desativada a extensão, a App Grid do GNOME abre');
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible);
    await sleep(500);
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
    await testAppGridHook(settings);
    await testNotificationBadges();
    await testRecentFiles();
    await testPanelMover(settings, win);
    await testLockScreen(settings);
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
