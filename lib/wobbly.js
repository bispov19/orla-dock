// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// wobbly.js — "janelas balançando" (wobbly windows).
//
// Como funciona:
//   1. Quando você começa a arrastar (ou redimensionar) uma janela, o Mutter
//      emite 'grab-op-begin'. Criamos um WobblyWindow para ela e prendemos
//      na malha (wobblyMath.js) o ponto mais perto do cursor.
//   2. A cada quadro (Clutter.Timeline, no ritmo da tela) lemos onde a
//      janela está, a malha "fica para trás" e as molas a puxam de volta.
//   3. Um Clutter.DeformEffect desenha a janela numa textura e a cola numa
//      grade de ladrilhos; vfunc_deform_vertex() move cada vértice conforme a
//      malha. Entre os vértices a placa de vídeo interpola (bordas lisas).
//   4. Quando a malha para, tiramos o efeito e paramos a Timeline: a janela
//      volta a ser desenhada normalmente, exatamente no lugar dela, e não
//      sobra nada rodando.
//
// Maximizar/restaurar: o Shell tem uma animação própria (um clone que cresce).
// Com a opção ligada, nós a desfazemos (como o Gênio faz com o minimizar)
// e fazemos a janela "saltar" do retângulo antigo para o novo com as molas.
//
// Nada daqui mexe na dock: o DockManager nem sabe que isto existe.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {SpringMesh} from './wobblyMath.js';

export const COMPIZ_UUID = 'compiz-windows-effect@hermes83.github.com';
const EFFECT_NAME = 'orla-wobbly';
const LAG_RATIO = 0.45;        // quanto um ponto pode ficar para trás (× menor lado)
const MAX_SETTLE_US = 8 * GLib.USEC_PER_SEC;   // trava de segurança depois de soltar

const WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

// Bits do Meta.GrabOp (GNOME 51): 1 = operação de janela, 256 = teclado,
// 512 = redimensionar pelo teclado (sem direção ainda), 4096+ = direção.
const GRAB_WINDOW = 1;
const GRAB_KEYBOARD = 256;
const GRAB_KEYBOARD_RESIZE = 512;
const GRAB_DIRECTION_MASK = 0xF000;

const WATCHED_KEYS = [
    'wobbly-enabled', 'wobbly-spring', 'wobbly-friction', 'wobbly-mass',
    'wobbly-mesh', 'wobbly-resize', 'wobbly-maximize',
];

const WobblyDeform = GObject.registerClass(
class OrlaWobblyDeform extends Clutter.DeformEffect {
    _init(mesh, tiles) {
        super._init();
        this._mesh = mesh;
        this._out = [0, 0];
        this.actorWidth = 1;
        this.actorHeight = 1;
        this.margin = 0;
        this.set_n_tiles(tiles, tiles);
    }

    vfunc_deform_vertex(width, height, v) {
        this._mesh.sample(v.tx, v.ty, this._out);
        // A textura pode ter tamanho diferente do ator: convertemos px.
        v.x = v.tx * width + this._out[0] * width / this.actorWidth;
        v.y = v.ty * height + this._out[1] * height / this.actorHeight;
    }

    // A janela deformada sai dos próprios limites. Aumentamos a área de
    // redesenho só o necessário (o maior deslocamento + folga), assim o
    // Clutter redesenha essa região — e não a tela inteira — a cada quadro.
    vfunc_modify_paint_volume(volume) {
        const m = this.margin;
        if (m > 0) {
            const origin = volume.get_origin();
            origin.x -= m;
            origin.y -= m;
            volume.set_origin(origin);
            volume.set_width(volume.get_width() + 2 * m);
            volume.set_height(volume.get_height() + 2 * m);
        }
        return true;
    }
});

/** O balanço de UMA janela. Existe só enquanto ela está sendo segurada ou balança. */
class WobblyWindow {
    constructor(manager, actor) {
        this._manager = manager;
        this._actor = actor;
        this._window = actor.meta_window;
        this._mesh = new SpringMesh(manager.meshSize);
        this._mesh.setParams(manager.params);
        this._effect = null;
        this._timeline = null;
        this._grabbed = false;
        this._releasedAt = 0;
        this._last = this._rect();

        // 'position-changed'/'size-changed': a janela se mexeu → acorda.
        this._window.connectObject(
            'position-changed', () => this._onGeometryChanged(),
            'size-changed', () => this._onGeometryChanged(),
            this);
    }

    /** Retângulo da janela na tela (o mesmo do ator, incluindo as sombras). */
    _rect() {
        const r = this._window.get_buffer_rect();
        return {x: r.x, y: r.y, w: Math.max(1, r.width), h: Math.max(1, r.height)};
    }

    get busy() {
        return this._grabbed || this._timeline !== null;
    }

    setParams(params) {
        this._mesh.setParams(params);
    }

    /** Começou a arrastar: prende o ponto da malha que está sob o cursor. */
    grab(keyboard) {
        this._grabbed = true;
        this._last = this._rect();
        if (keyboard) {
            this._mesh.pin(0.5, 0.5);
        } else {
            const [px, py] = global.get_pointer();
            const r = this._last;
            this._mesh.pin((px - r.x) / r.w, (py - r.y) / r.h);
        }
    }

    /** Soltou: a âncora some e as molas levam a janela de volta. */
    release() {
        this._grabbed = false;
        this._mesh.release();
        this._releasedAt = GLib.get_monotonic_time();
        if (!this._timeline)
            this._manager.forget(this);
    }

    /** Maximizar/restaurar: a janela parte do retângulo antigo e "salta". */
    morphFrom(oldRect) {
        const now = this._rect();
        this._mesh.shift(oldRect, now);
        this._last = now;
        this._releasedAt = GLib.get_monotonic_time();
        this._start();
    }

    _onGeometryChanged() {
        if (this._grabbed || this._timeline)
            this._start();
        else
            this._last = this._rect();
    }

    _start() {
        if (this._timeline)
            return;
        this._effect = new WobblyDeform(this._mesh, this._manager.tiles);
        this._actor.add_effect_with_name(EFFECT_NAME, this._effect);
        this._lastTime = GLib.get_monotonic_time();
        // Timeline "infinita" presa ao ator: avança no ritmo do monitor em que
        // a janela está (60, 120, 144 Hz…) e só existe enquanto balança.
        this._timeline = new Clutter.Timeline({
            actor: this._actor,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = (now - this._lastTime) / GLib.USEC_PER_SEC;
        this._lastTime = now;

        const rect = this._rect();
        const last = this._last;
        if (rect.x !== last.x || rect.y !== last.y || rect.w !== last.w || rect.h !== last.h) {
            this._mesh.shift(last, rect, Math.min(rect.w, rect.h) * LAG_RATIO);
            this._last = rect;
        }

        const moving = this._mesh.step(dt);
        const expired = !this._grabbed && now - this._releasedAt > MAX_SETTLE_US;
        if (!moving || expired) {
            // Parado: tira o efeito. Se ainda estiver segurando, ele volta
            // no próximo movimento ('position-changed').
            this._stop();
            if (!this._grabbed)
                this._manager.forget(this);
            return;
        }

        const [aw, ah] = this._actor.get_size();
        this._effect.actorWidth = Math.max(1, aw);
        this._effect.actorHeight = Math.max(1, ah);
        this._effect.margin = Math.ceil(this._mesh.maxDisplacement()) + 4;
        this._effect.invalidate();
    }

    /** Para tudo e devolve a janela exatamente ao normal. */
    _stop() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
        if (this._effect) {
            this._actor.remove_effect(this._effect);
            this._effect = null;
        }
        this._mesh.reset();
    }

    destroy() {
        this._stop();
        this._window.disconnectObject(this);
    }
}

export class WobblyWindows {
    constructor(settings) {
        this._settings = settings;
        this._windows = new Map();     // ator da janela → WobblyWindow
        this._pendingMorph = new Map();   // ator → retângulo antes de maximizar
        this._active = false;

        this._settings.connectObject('changed', (_s, key) => {
            if (WATCHED_KEYS.includes(key))
                this._onSettingsChanged(key);
        }, this);
        // A extensão original pode ser ligada/desligada a qualquer momento.
        Main.extensionManager.connectObject('extension-state-changed', (_m, extension) => {
            if (extension.uuid === COMPIZ_UUID)
                this._sync();
        }, this);
        this._readParams();
        this._sync();
    }

    get meshSize() {
        return this._meshSize;
    }

    get tiles() {
        // Ladrilhos do desenho: mais que os pontos da física, para a curva
        // ficar lisa entre eles.
        return Math.min(32, Math.max(12, this._meshSize * 3));
    }

    get params() {
        return this._params;
    }

    _readParams() {
        const s = this._settings;
        this._meshSize = s.get_int('wobbly-mesh');
        this._params = {
            spring: s.get_double('wobbly-spring'),
            friction: s.get_double('wobbly-friction'),
            mass: s.get_double('wobbly-mass'),
        };
    }

    _onSettingsChanged(key) {
        this._readParams();
        if (key === 'wobbly-mesh') {
            // Outra resolução: as janelas que balançam param (no lugar certo)
            // e a próxima já usa a malha nova.
            this._clearWindows();
        } else {
            for (const wobbly of this._windows.values())
                wobbly.setParams(this._params);
        }
        this._sync();
    }

    /** A extensão "Compiz windows effect" está ativa? (evita efeito duplo) */
    static compizActive() {
        const extension = Main.extensionManager.lookup(COMPIZ_UUID);
        return extension?.state === ExtensionState.ACTIVE;
    }

    /** Liga ou desliga os sinais conforme a opção e a outra extensão. */
    _sync() {
        const wanted = this._settings.get_boolean('wobbly-enabled') && !WobblyWindows.compizActive();
        if (wanted === this._active)
            return;
        this._active = wanted;
        if (wanted) {
            global.display.connectObject(
                'grab-op-begin', (_d, window, op) => this._onGrabBegin(window, op),
                'grab-op-end', (_d, window) => this._onGrabEnd(window),
                this);
            global.window_manager.connectObject(
                'size-change', (_wm, actor, which, _oldFrame, oldBuffer) =>
                    this._onSizeChange(actor, which, oldBuffer),
                'size-changed', (_wm, actor) => this._onSizeChanged(actor),
                // A janela vai minimizar, voltar ou fechar: o balanço para.
                'minimize', (_wm, actor) => this._forgetActor(actor),
                'unminimize', (_wm, actor) => this._forgetActor(actor),
                'destroy', (_wm, actor) => this._forgetActor(actor),
                'kill-window-effects', (_wm, actor) => this._forgetActor(actor),
                this);
        } else {
            global.display.disconnectObject(this);
            global.window_manager.disconnectObject(this);
            this._clearWindows();
        }
    }

    _eligible(window) {
        if (!window || window.is_override_redirect() ||
            !WINDOW_TYPES.includes(window.get_window_type()))
            return null;
        // Respeita "Animações" desligado nas configurações do GNOME.
        if (!St.Settings.get().enable_animations)
            return null;
        return window.get_compositor_private() ?? null;
    }

    _wobblyFor(actor) {
        let wobbly = this._windows.get(actor);
        if (!wobbly) {
            wobbly = new WobblyWindow(this, actor);
            this._windows.set(actor, wobbly);
            // O ator pode sumir sem passar pelos sinais do window_manager.
            actor.connectObject('destroy', () => this._forgetActor(actor), this);
        }
        return wobbly;
    }

    _onGrabBegin(window, op) {
        if (!(op & GRAB_WINDOW))
            return;
        const keyboard = (op & GRAB_KEYBOARD) !== 0;
        const resizing = (op & GRAB_DIRECTION_MASK) !== 0 || (op & GRAB_KEYBOARD_RESIZE) !== 0;
        if (resizing && !this._settings.get_boolean('wobbly-resize'))
            return;
        // Mover pelo teclado (Alt+F7) vale junto com maximizar/restaurar.
        if (keyboard && !resizing && !this._settings.get_boolean('wobbly-maximize'))
            return;
        const actor = this._eligible(window);
        if (actor)
            this._wobblyFor(actor).grab(keyboard);
    }

    _onGrabEnd(window) {
        const actor = window?.get_compositor_private();
        const wobbly = actor ? this._windows.get(actor) : null;
        wobbly?.release();
    }

    _onSizeChange(actor, which, oldBuffer) {
        if (!this._settings.get_boolean('wobbly-maximize'))
            return;
        if (which !== Meta.SizeChange.MAXIMIZE && which !== Meta.SizeChange.UNMAXIMIZE)
            return;
        if (!this._eligible(actor.meta_window) || this._windows.get(actor)?.busy)
            return;
        // O handler do Shell já rodou e preparou a animação dele (um clone e
        // a janela "congelada"). Desfazemos e avisamos o Mutter que acabou.
        // Se esse detalhe interno mudar, deixamos a animação do Shell.
        const wm = Main.wm;
        if (typeof wm._clearAnimationInfo !== 'function' || !wm._resizePending?.delete)
            return;
        if (!wm._clearAnimationInfo(actor))
            return;
        wm._resizePending.delete(actor);
        global.window_manager.completed_size_change(actor);
        this._pendingMorph.set(actor, {
            x: oldBuffer.x, y: oldBuffer.y,
            w: Math.max(1, oldBuffer.width), h: Math.max(1, oldBuffer.height),
        });
    }

    _onSizeChanged(actor) {
        const oldRect = this._pendingMorph.get(actor);
        if (!oldRect)
            return;
        this._pendingMorph.delete(actor);
        this._wobblyFor(actor).morphFrom(oldRect);
    }

    /** Chamado pelo WobblyWindow quando parou e ninguém está segurando. */
    forget(wobbly) {
        for (const [actor, w] of this._windows) {
            if (w === wobbly) {
                this._forgetActor(actor);
                return;
            }
        }
    }

    _forgetActor(actor) {
        this._pendingMorph.delete(actor);
        const wobbly = this._windows.get(actor);
        if (!wobbly)
            return;
        this._windows.delete(actor);
        actor.disconnectObject(this);
        wobbly.destroy();
    }

    _clearWindows() {
        for (const actor of [...this._windows.keys()])
            this._forgetActor(actor);
        this._pendingMorph.clear();
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        this._clearWindows();
        this._active = false;
    }
}
