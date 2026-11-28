// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// tests/perf/orla-perf@local/extension.js — mede a fluidez dentro de um
// GNOME Shell de teste (scripts/perf.sh):
//
//   - Visão Geral abrindo e fechando, e troca de área de trabalho, com a
//     Orla DESLIGADA, ligada com as opções carregadas e ligada sem vidro;
//   - o Menu Iniciar abrindo e fechando em cada estilo;
//   - quantas vezes o gancho da App Grid roda durante a Visão Geral (deve
//     ser só no gatilho, nunca por quadro);
//   - o caminho "Super duas vezes" até o menu aparecer.
//
// Para cada cena: quantos quadros, o trabalho da CPU por quadro (do
// 'before-update' ao 'after-paint' do palco) e o maior intervalo entre
// dois quadros (um intervalo > 1,5 quadro = quadro perdido).
// Cada resultado sai numa linha "ORLAPERF {json}".

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import System from 'system';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'orla-dock@viniciusbispo19';
const OUT = GLib.getenv('ORLA_PERF_OUT') ?? GLib.get_tmp_dir();
const FRAME_MS = 1000 / 60;

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const now = () => GLib.get_monotonic_time() / 1000;
const log = (...args) => console.log('ORLAPERF', ...args);
const orla = () => Main.extensionManager.lookup(UUID);
const manager = () => orla()?.stateObj?._manager ?? null;

async function waitFor(predicate, ms = 4000) {
    for (let t = 0; t < ms; t += 20) {
        if (predicate())
            return true;
        await sleep(20);
    }
    return predicate();
}

/** Grava os quadros do palco enquanto `action` roda. */
async function record(name, action, busy = null) {
    const stage = global.stage;
    const frames = [];
    const t0 = now();
    let start = 0;
    const a = stage.connect('before-update', () => {
        start = now();
    });
    const b = stage.connect('after-paint', () => {
        if (start)
            frames.push([start, now(), busy ? busy() : true]);
        start = 0;
    });
    await action();
    stage.disconnect(a);
    stage.disconnect(b);
    const work = frames.map(([s, e]) => e - s).sort((x, y) => x - y);
    const gaps = [];
    for (let i = 1; i < frames.length; i++)
        gaps.push(frames[i][1] - frames[i - 1][1]);
    // Intervalos longos ENTRE animações (as pausas do roteiro) não contam.
    // Com `busy` (ex.: a lupa animando), só conta o intervalo que começa
    // num quadro em que a animação ainda estava rodando.
    const inAnimation = gaps.filter((g, i) => g < 200 && frames[i][2]);
    const late = gaps.map((g, i) => [g, i]).filter(([g, i]) => g > FRAME_MS * 1.5 && g < 200 && frames[i][2])
        .map(([g, i]) => `${Math.round(frames[i][1] - t0)}ms:+${g.toFixed(0)}`);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
    const result = {
        name,
        frames: frames.length,
        workMeanMs: +(work.reduce((s, v) => s + v, 0) / Math.max(1, work.length)).toFixed(2),
        workP95Ms: +pct(work, 0.95).toFixed(2),
        workP99Ms: +pct(work, 0.99).toFixed(2),
        workMaxMs: +(work.at(-1) ?? 0).toFixed(2),
        maxGapMs: +(Math.max(0, ...inAnimation)).toFixed(1),
        dropped: inAnimation.filter(g => g > FRAME_MS * 1.5).length,
        late: late.join(' '),
    };
    log(JSON.stringify(result));
    return result;
}

async function overviewCycles(n = 5) {
    for (let i = 0; i < n; i++) {
        Main.overview.show();
        await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress);
        await sleep(250);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible);
        await sleep(250);
    }
}

async function workspaceSwitches(n = 4) {
    const wm = global.workspace_manager;
    for (let i = 0; i < n; i++) {
        const target = wm.get_active_workspace_index() === 0 ? 1 : 0;
        wm.get_workspace_by_index(target)?.activate(global.get_current_time());
        await sleep(700);
    }
    wm.get_workspace_by_index(0)?.activate(global.get_current_time());
    await sleep(700);
}

async function openWindow() {
    const apps = Shell.AppSystem.get_default();
    const app = ['org.gnome.TextEditor.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Nautilus.desktop']
        .map(id => apps.lookup_app(id)).find(Boolean);
    app?.activate();
    await waitFor(() => global.get_window_actors().some(a =>
        a.meta_window.get_window_type() === Meta.WindowType.NORMAL), 8000);
    await sleep(1500);
}

async function shot(name, x, y, w, h) {
    try {
        const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Promise((resolve, reject) => {
            new Shell.Screenshot().screenshot_area(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)),
                Math.round(w), Math.round(h), stream, (o, res) => {
                    try {
                        o.screenshot_area_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        stream.close(null);
    } catch (e) {
        log(JSON.stringify({name: 'shot', error: String(e)}));
    }
}

/** Onde o menu abriu em relação ao botão de apps (diagnóstico de posição). */
function placement(menu, dock) {
    const [bx, by] = menu._box.get_transformed_position();
    const button = dock.startButton;
    const [sx, sy] = button?.get_transformed_position() ?? [0, 0];
    const [sw, sh] = button?.get_transformed_size() ?? [0, 0];
    return {
        menu: [Math.round(bx), Math.round(by), menu._box.width, menu._box.height],
        button: [Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh)],
    };
}

async function menuScenes(tag) {
    const settings = orla().stateObj.getSettings();
    const dock = manager()._docks[0];
    for (const id of ['classic', 'modern', 'categories', 'alphabetical', 'launchpad']) {
        settings.set_string('start-menu-style', id);
        await sleep(600);
        // Quanto custa montar o estilo do zero (feito fora da animação).
        const m = manager().startMenu;
        const t = now();
        m._dropStyle();
        m._ensureStyle();
        m._applyDirty();
        log(JSON.stringify({name: `${tag}: montar o estilo ${id}`, ms: +(now() - t).toFixed(1)}));
        await sleep(300);
        let where = null;
        await record(`${tag}: menu ${id} abrir/fechar x3`, async () => {
            for (let i = 0; i < 3; i++) {
                manager().openStartMenu(dock);
                await sleep(450);
                if (i === 0) {
                    where = placement(manager()._startMenu, dock);
                    const [x, y, w, h] = where.menu;
                    await shot(`${tag}-menu-${id}`, x - 20, y - 20, w + 40, h + 40);
                }
                manager()._startMenu.close();
                await sleep(350);
            }
        });
        log(JSON.stringify({name: `${tag}: posição ${id}`, ...where}));
    }
}

/**
 * O ponteiro passa devagar pelos ícones dos fixados; captura no meio do
 * caminho (um rastro apareceria embaixo dos ícones já visitados).
 */
async function hoverScene(tag, glass) {
    const settings = orla().stateObj.getSettings();
    settings.set_boolean('start-menu-glass', glass);
    settings.set_string('start-menu-style', 'modern');
    await sleep(400);
    const dock = manager()._docks[0];
    manager().openStartMenu(dock);
    await sleep(500);
    const menu = manager()._startMenu;
    const cells = menu.style._pinned._grid.get_children().filter(c => c._orlaApp);
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    // Hover não é animação: os quadros seguem o mouse (1 a cada ~30 ms),
    // então "dropped" aqui não quer dizer nada; vale o trabalho por quadro.
    const name = `${tag}: hover nos ícones${glass ? ' (vidro)' : ''} [só custo por quadro]`;
    await record(name, async () => {
        for (const cell of cells) {
            const [x, y] = cell.get_transformed_position();
            for (let i = 0; i <= 6; i++) {
                pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + cell.width * i / 6, y + cell.height / 2);
                await sleep(30);
            }
        }
    });
    const [fx, fy] = menu._frame.get_transformed_position();
    await shot(`${tag}-hover${glass ? '-vidro' : ''}`, fx - 10, fy - 10, menu._frame.width + 20, 260);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 5, 5);
    menu.close();
    await sleep(400);
    settings.set_boolean('start-menu-glass', false);
}

/**
 * O caminho Super, Super → menu. Além dos quadros, conta os quadros
 * "vazios": a Visão Geral já fora e o menu ainda quase invisível.
 */
async function doubleSuper(tag) {
    const menuOpen = () => manager()?._startMenu?.isOpen;
    let t2 = 0, menuShown = 0, overviewGone = 0, blank = 0, both = 0;
    const paint = global.stage.connect('after-paint', () => {
        if (!t2)
            return;
        const frame = manager()?._startMenu?._frame;
        const menuVisible = frame?.get_parent()?.visible && frame.opacity > 30;
        if (Main.overview.visible && menuVisible)
            both++;
        if (!Main.overview.visible && !overviewGone)
            overviewGone = now();
        if (!Main.overview.visible && !menuVisible && !menuShown)
            blank++;
    });
    await record(`${tag}: Super duas vezes → menu`, async () => {
        global.display.emit('overlay-key');
        await sleep(60);
        t2 = now();
        global.display.emit('overlay-key');
        await waitFor(menuOpen, 3000);
        menuShown = now();
        await waitFor(() => !Main.overview.visible, 3000);
        await sleep(300);
    });
    global.stage.disconnect(paint);
    log(JSON.stringify({
        name: `${tag}: Super duas vezes — transição`,
        menuComecouEmMs: +(menuShown - t2).toFixed(0),
        visaoGeralSaiuEmMs: overviewGone ? +(overviewGone - t2).toFixed(0) : null,
        quadrosComAsDuasNaTela: both,
        quadrosVazios: blank,
    }));
    manager()._startMenu?.close();
    await sleep(500);
}

/** Quantas vezes as funções interceptadas rodam numa Visão Geral. */
async function hookCalls(tag) {
    const overview = Main.overview;
    const adjustment = overview._overview.controls._stateAdjustment;
    const counts = {show: 0, ease: 0};
    const show = overview.show;
    const ease = adjustment.ease;
    overview.show = function (...args) {
        counts.show++;
        return show.apply(this, args);
    };
    adjustment.ease = function (...args) {
        counts.ease++;
        return ease.apply(this, args);
    };
    const r = await record(`${tag}: Visão Geral com o gancho ligado`, () => overviewCycles(3));
    overview.show = show;
    adjustment.ease = ease;
    log(JSON.stringify({name: `${tag}: chamadas do gancho em 3 aberturas`, ...counts, quadros: r.frames}));
}

/**
 * O card do widget de música: mouse sobre o widget, clique direito, e o
 * que acontece em cada quadro (card e widget). Mostra saltos de posição,
 * de tamanho e "pulos" de opacidade.
 */
async function musicCardScene(tag) {
    const settings = orla().stateObj.getSettings();
    const K = 'wavebar-music-pill-';
    settings.set_boolean(`${K}enabled`, true);
    settings.set_boolean(`${K}lyrics`, true);
    const fake = `${GLib.get_user_data_dir()}/gnome-shell/extensions/${UUID}/tests/music/fake-player.js`;
    const proc = Gio.Subprocess.new(['gjs', '-m', fake, '--name', 'orla_perf', '--title', 'Música de Teste',
        '--artist', 'Artista', '--length', '200'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    await sleep(2500);
    const pill = manager()._docks[0].findItem('music');
    if (!pill) {
        log(JSON.stringify({name: `${tag}: card`, erro: 'widget não apareceu'}));
        proc.force_exit();
        return;
    }
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const goTo = async () => {
        // Sobre o título (fora dos botões, onde o clique direito abre o card).
        const target = pill._details.mapped ? pill._details : pill;
        const [px, py] = target.get_transformed_position();
        const [tx, ty] = [Math.round(px + target.width / 3), Math.round(py + target.height / 2)];
        for (let i = 0; i < 30; i++) {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), tx, ty);
            await sleep(30);
            const [x, y] = global.get_pointer();
            if (Math.abs(x - tx) <= 1 && Math.abs(y - ty) <= 1)
                break;
        }
    };
    await goTo();
    await sleep(900);
    for (const round of [1, 2]) {
        const frames = [];
        const t0 = now();
        const id = global.stage.connect('after-paint', () => {
            const card = manager()._musicCard?._card;
            frames.push([Math.round(now() - t0), card ? card.opacity : -1, card ? Math.round(card.y) : -1,
                card ? Math.round(card.height) : -1, card ? Math.round(card.translation_y) : 0,
                Math.round(pill.cellLength(pill.geometry)), Math.round(pill.translation_x)]);
        });
        const [cx, cy] = global.get_pointer();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, cx, cy);
        const mc = manager()._musicCard;
        log(JSON.stringify({name: `${tag}: antes do clique ${round}`, sob: `${picked?.constructor?.name} ${picked?.style_class ?? ''}`,
            aberto: mc?.isOpen, fechando: mc?._closingCard, overlay: mc?._overlay.visible, hover: pill.hover}));
        const t1 = now();
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
        await sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
        await sleep(1800);
        global.stage.disconnect(id);
        const visible = frames.filter(f => f[1] > 0);
        log(JSON.stringify({
            name: `${tag}: card clique direito (${round}ª)`,
            primeiroVisivelMs: visible[0]?.[0] ?? null,
            ys: [...new Set(visible.map(f => f[2]))],
            alturas: [...new Set(visible.map(f => f[3]))],
            larguraWidget: [...new Set(frames.map(f => f[5]))],
            deslocWidget: [...new Set(frames.map(f => f[6]))],
            quadros: frames.slice(0, 14),
            espera: Math.round(now() - t1),
        }));
        manager()._musicCard?.close();
        await sleep(800);
        await goTo();
        await sleep(900);
    }
    proc.force_exit();
    await sleep(1000);
    settings.reset(`${K}enabled`);
    settings.reset(`${K}lyrics`);
}

// ---------- Magnificação ----------

/**
 * Instrumenta a dock (só nesta medição, sem custo na extensão): conta
 * relayouts, reposicionamentos dos itens, mudanças de tamanho do fundo,
 * ícones recriados e alocações dos atores da dock.
 */
function instrument(dock) {
    const counts = {relayout: 0, layoutItems: 0, placeBackground: 0, refreshIcon: 0, alocacoesFundo: 0,
        alocacoesItens: 0, glassRedraw: 0, redesenhosVidro: 0, alocacoesVidro: 0};
    const wrap = (obj, name, key) => {
        const orig = obj[name];
        obj[name] = function (...args) {
            counts[key]++;
            return orig.apply(this, args);
        };
        return () => {
            delete obj[name];
        };
    };
    const undo = [
        wrap(dock, 'relayout', 'relayout'),
        wrap(dock, '_layoutItems', 'layoutItems'),
        wrap(dock, 'placeBackground', 'placeBackground'),
        wrap(dock, 'queueGlassRedraw', 'glassRedraw'),
        // Pedidos que de fato chegam ao ator do vidro.
        wrap(dock._background, 'queue_redraw', 'redesenhosVidro'),
    ];
    for (const item of dock.getItems())
        undo.push(wrap(item, 'refreshIcon', 'refreshIcon'));

    // Cronômetro: a chamada mais lenta de cada função do caminho do mouse.
    const slow = {};
    const t0 = now();
    const time = (obj, name, key) => {
        const orig = obj[name];
        obj[name] = function (...args) {
            const s0 = now();
            try {
                return orig.apply(this, args);
            } finally {
                const ms = now() - s0;
                if (ms > (slow[key]?.[0] ?? 0))
                    slow[key] = [+ms.toFixed(2), Math.round(s0 - t0)];
            }
        };
        undo.push(() => delete obj[name]);
    };
    time(dock, '_onMotion', 'onMotion');
    time(dock, '_setHovered', 'setHovered');
    time(dock, 'isPointerOver', 'isPointerOver');
    time(dock.autohide, 'sync', 'autohideSync');
    time(dock._magnifier, '_tick', 'tick');
    // Travadas FORA do desenho (coleta de lixo, timers...): um relógio de
    // 2 ms que anota quando chega muito atrasado.
    const stalls = [];
    let last = now();
    const stallId = GLib.timeout_add(GLib.PRIORITY_HIGH, 2, () => {
        const t = now();
        if (t - last > 20)
            stalls.push(`${Math.round(last - t0)}ms:+${Math.round(t - last)}`);
        last = t;
        return GLib.SOURCE_CONTINUE;
    });
    undo.push(() => GLib.source_remove(stallId));
    const bgId = dock.backgroundActor.connect('notify::allocation', () => counts.alocacoesFundo++);
    // O ator que carrega o desfoque: cada alocação nova recria as texturas.
    const glassId = dock._background.connect('notify::allocation', () => counts.alocacoesVidro++);
    const itemIds = dock.getItems().map(item => [item, item.connect('notify::allocation', () => counts.alocacoesItens++)]);
    return {
        counts,
        slow,
        stalls,
        stop() {
            undo.forEach(u => u());
            dock.backgroundActor.disconnect(bgId);
            dock._background.disconnect(glassId);
            itemIds.forEach(([item, id]) => item.disconnect(id));
        },
    };
}

/** O mouse varre a dock de ponta a ponta (devagar e depressa), como um mouse de 125 Hz. */
async function sweep(dock, pointer, away = 0) {
    const bar = dock.backgroundActor;
    const [bx, by] = bar.get_transformed_position();
    const [bw, bh] = bar.get_transformed_size();
    // away > 0: o mesmo roteiro, mas longe da dock (grupo de controle).
    const y = by + bh / 2 - away;
    const left = bx + 10, right = bx + bw - 10;
    const move = async (x0, x1, ms) => {
        const steps = Math.max(2, Math.round(ms / 8));
        for (let i = 0; i <= steps; i++) {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), x0 + (x1 - x0) * i / steps, y);
            await sleep(8);
        }
    };
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), left, by - 120);
    await sleep(200);
    await move(left, left, 40);
    await move(left, right, 2400);      // devagar
    await move(right, left, 600);       // depressa
    await move(left, right, 600);
    await move(right, (left + right) / 2, 300);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), (left + right) / 2, by - 200); // sai da dock
    await sleep(700);
}

async function magnifyScenes(tag) {
    const settings = orla().stateObj.getSettings();
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const apps = Shell.AppSystem.get_default();
    const few = global.settings.get_strv('favorite-apps');
    const many = apps.get_installed().filter(i => i.should_show()).map(i => i.get_id())
        .filter(id => apps.lookup_app(id)).slice(0, 18);
    let fake = null;
    const results = [];
    for (const size of [48, 64, 96]) {
        for (const glass of [false, true]) {
            for (const icons of ['poucos', 'muitos']) {
                for (const music of [false, true]) {
                    // Combinações: tudo nos 3 tamanhos; música só no tamanho do meio.
                    if (music && size !== 64)
                        continue;
                    settings.set_int('icon-size', size);
                    settings.set_boolean('blur-enabled', glass);
                    global.settings.set_strv('favorite-apps', icons === 'muitos' ? many : few);
                    settings.set_boolean('wavebar-music-pill-enabled', music);
                    if (music && !fake) {
                        const path = `${GLib.get_user_data_dir()}/gnome-shell/extensions/${UUID}/tests/music/fake-player.js`;
                        fake = Gio.Subprocess.new(['gjs', '-m', path, '--name', 'orla_perf_mag', '--title', 'Música',
                            '--artist', 'Artista', '--length', '200'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                    }
                    await sleep(2200);
                    const dock = manager()._docks[0];
                    const probe = instrument(dock);
                    const name = `${tag}: ícone ${size}, ${glass ? 'vidro' : 'sem vidro'}, ${icons}${music ? ', música' : ''}`;
                    // Só conta como "perdido" o intervalo com a lupa animando
                    // (a pausa depois que ela assenta não é engasgo).
                    const r = await record(name, () => sweep(dock, pointer),
                        () => Boolean(dock._magnifier._timeline?.is_playing()));
                    probe.stop();
                    const secs = 4.5;
                    log(JSON.stringify({name: `${name} — lentas`, ...probe.slow, travadas: probe.stalls.join(' ')}));
                    log(JSON.stringify({name: `${name} — contagens`, ...probe.counts,
                        relayoutPorSeg: +(probe.counts.relayout / secs).toFixed(1),
                        fundoPorSeg: +(probe.counts.placeBackground / secs).toFixed(1)}));
                    results.push(r);
                }
            }
        }
    }
    // Controle: o mesmo movimento de mouse LONGE da dock. As travadas que
    // aparecerem aqui são do ambiente (Shell de teste, coleta de lixo do
    // próprio GNOME), não da ampliação.
    {
        const dock = manager()._docks[0];
        const probe = instrument(dock);
        await record(`${tag}: controle — mesmo roteiro longe da dock`, () => sweep(dock, pointer, 400));
        probe.stop();
        log(JSON.stringify({name: `${tag}: controle — lentas`, ...probe.slow, travadas: probe.stalls.join(' ')}));
    }
    // Repouso: nada deve rodar.
    await sleep(1500);
    await record(`${tag}: repouso (3 s sem mexer)`, () => sleep(3000));
    fake?.force_exit();
    global.settings.set_strv('favorite-apps', few);
    for (const k of ['icon-size', 'blur-enabled', 'wavebar-music-pill-enabled'])
        settings.reset(k);
}

/**
 * Uso contínuo: a mesma configuração (a pior: ícone 96, vidro, muitos
 * ícones) varrida várias vezes seguidas, sem recriar nada entre uma e
 * outra — como alguém usando a dock de verdade.
 */
async function magnifySteady(tag) {
    const settings = orla().stateObj.getSettings();
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const apps = Shell.AppSystem.get_default();
    const few = global.settings.get_strv('favorite-apps');
    const many = apps.get_installed().filter(i => i.should_show()).map(i => i.get_id())
        .filter(id => apps.lookup_app(id)).slice(0, 18);
    // Variantes (ORLA_PERF_STEADY, separadas por vírgula): bare = sem a
    // instrumentação; noglass = sem vidro; away = longe da dock (controle).
    const variant = (GLib.getenv('ORLA_PERF_STEADY') || '').split(',');
    settings.set_int('icon-size', 96);
    settings.set_boolean('blur-enabled', !variant.includes('noglass'));
    global.settings.set_strv('favorite-apps', many);
    await sleep(3000);
    const dock = manager()._docks[0];
    const rss = () => Math.round(Number(new TextDecoder().decode(
        GLib.file_get_contents('/proc/self/statm')[1]).split(' ')[1]) * 4 / 1024);
    const gc = () => {
        const t = now();
        System.gc();
        return +(now() - t).toFixed(1);
    };
    // shot = fotografa a textura do vidro AO VIVO (a captura de tela comum
    // pinta em outro framebuffer e não provaria as coordenadas da tela).
    if (variant.includes('shot')) {
        for (const d of manager()._docks) {
            const [x, y] = d.backgroundActor.get_transformed_position();
            const [w, h] = d.backgroundActor.get_transformed_size();
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + w / 2, y + h / 2);
            await sleep(100);
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + w / 2 + 2, y + h / 2);
            await sleep(1200);
            const surf = d._blurEffect._surfaces;
            for (const key of ['source', 'glass']) {
                const tex = surf[key].framebuffer.get_texture();
                const [pw, ph] = d._blurEffect._lastSize;
                const out = Gio.File.new_for_path(`${GLib.getenv('ORLA_PERF_OUT')}/vivo-${d.monitorIndex}-${key}.png`)
                    .replace(null, false, Gio.FileCreateFlags.NONE, null);
                await new Promise(resolve => Shell.Screenshot.composite_to_stream(tex, 0, 0, pw, ph, 1, null, 0, 0, 1, out,
                    (_o, res) => {
                        try {
                            Shell.Screenshot.composite_to_stream_finish(res);
                        } catch (e) {
                            log(`ERRO ${e.message}`);
                        }
                        resolve();
                    }));
                out.close(null);
            }
            const [bx, by] = d._background.get_transformed_position();
            const view = global.stage.peek_stage_views()[0];
            log(JSON.stringify({name: `${tag}: vivo`, monitor: d.monitorIndex, fundo: [bx, by, ...d._background.get_size()],
                mask: d._blurEffect._mask, px: d._blurEffect._lastSize, views: global.stage.peek_stage_views().length, escala: view.get_scale()}));
            const shot = Gio.File.new_for_path(`${GLib.getenv('ORLA_PERF_OUT')}/vivo-${d.monitorIndex}-tela.png`)
                .replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Promise(resolve => new Shell.Screenshot().screenshot(false, shot, () => resolve()));
            shot.close(null);
        }
        return;
    }
    gc();
    for (let i = 1; i <= Number(GLib.getenv('ORLA_PERF_ROUNDS') || 5); i++) {
        const probe = variant.includes('bare') ? null : instrument(dock);
        const samples = [];
        const sampler = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            samples.push(rss());
            log(JSON.stringify({name: `${tag}: rss ${i}`, mb: samples.at(-1)}));
            return GLib.SOURCE_CONTINUE;
        });
        await record(`${tag}: contínuo ${i}`, () => sweep(dock, pointer, variant.includes('away') ? 400 : 0),
            () => Boolean(dock._magnifier._timeline?.is_playing()));
        GLib.source_remove(sampler);
        probe?.stop();
        const before = rss();
        const first = gc();
        await sleep(300);
        log(JSON.stringify({name: `${tag}: memória ${i}`, rssAntes: before, gcMs: first, rssDepois: rss(), gcDeNovoMs: gc()}));
    }
    global.settings.set_strv('favorite-apps', few);
    for (const k of ['icon-size', 'blur-enabled'])
        settings.reset(k);
}

async function run() {
    if (GLib.getenv('ORLA_PERF_ONLY') === 'steady') {
        await sleep(3000);
        Main.overview.hide();
        await sleep(500);
        await magnifySteady(GLib.getenv('ORLA_PERF_TAG') || 'agora');
        log('DONE');
        return;
    }
    if (GLib.getenv('ORLA_PERF_ONLY') === 'magnify') {
        await sleep(3000);
        Main.overview.hide();
        await sleep(500);
        await magnifyScenes(GLib.getenv('ORLA_PERF_TAG') || 'atual');
        log('DONE');
        return;
    }
    if (GLib.getenv('ORLA_PERF_ONLY') === 'card') {
        await sleep(3000);
        Main.overview.hide();
        await sleep(500);
        await musicCardScene(GLib.getenv('ORLA_PERF_TAG') || 'atual');
        log('DONE');
        return;
    }
    await sleep(3000);
    Main.overview.hide();
    await openWindow();
    const settings = orla().stateObj.getSettings();
    const tag = GLib.getenv('ORLA_PERF_TAG') || 'atual';

    // 1) Sem a Orla.
    await Main.extensionManager.disableExtension(UUID);
    await sleep(1500);
    await record(`${tag}: SEM Orla — Visão Geral x5`, () => overviewCycles());
    await record(`${tag}: SEM Orla — áreas de trabalho x4`, () => workspaceSwitches());

    // 2) Orla com as opções carregadas.
    await Main.extensionManager.enableExtension(UUID);
    await sleep(2500);
    await record(`${tag}: COM Orla — Visão Geral x5`, () => overviewCycles());
    await record(`${tag}: COM Orla — áreas de trabalho x4`, () => workspaceSwitches());

    // 3) Orla sem vidro.
    const glass = settings.get_boolean('blur-enabled');
    settings.set_boolean('blur-enabled', false);
    await sleep(1000);
    await record(`${tag}: COM Orla sem vidro — Visão Geral x5`, () => overviewCycles());
    settings.set_boolean('blur-enabled', glass);
    await sleep(1000);

    // 4) Menu Iniciar no lugar da App Grid.
    settings.set_boolean('start-menu-replace-grid', true);
    await sleep(500);
    await hookCalls(tag);
    await menuScenes(tag);
    await hoverScene(tag, false);
    await hoverScene(tag, true);
    await doubleSuper(tag);
    log('DONE');
}

let started = false;
export default class OrlaPerf extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        const go = () => run()
            .catch(e => log(JSON.stringify({error: `${e}\n${e.stack}`})))
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

