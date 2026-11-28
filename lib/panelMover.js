// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// panelMover.js — leva a barra superior do GNOME para baixo quando a dock
// fica em cima.
//
// Por que existe: com a dock na posição "Superior", a dock e a barra do
// GNOME disputariam o topo da tela. Com a opção "Mover a barra superior
// para baixo" ligada, a barra desce para a borda de baixo e a dock passa a
// usar a borda de cima de verdade.
//
// Como a barra é movida — e por que assim:
//   - A barra mora no Main.layoutManager.panelBox. O próprio GNOME põe essa
//     caixa no topo do monitor principal (set_position) sempre que os
//     monitores mudam. Se mudássemos o `y`, o GNOME desfaria; por isso
//     usamos `translation_y`, um deslocamento que o GNOME não toca.
//   - As "struts" (a faixa reservada que as janelas maximizadas respeitam)
//     são calculadas pela posição TRANSFORMADA da caixa, que já inclui o
//     deslocamento: com a barra embaixo, a reserva passa para baixo. Mas o
//     GNOME só recalcula quando o tamanho ou a posição base mudam, não com
//     o deslocamento; então pedimos o recálculo nós mesmos (ver _refreshRegions).
//   - Os menus da barra abrem para CIMA: a seta de cada um (BoxPointer)
//     passa a apontar para baixo, inclusive nos indicadores que outras
//     extensões acrescentarem depois.
//   - A barra ganha a classe CSS "orla-panel-bottom", para temas e outras
//     extensões ajustarem bordas e sombras.
//
// Também cuida dos avisos de notificação: o GNOME os mostra no alto do
// monitor, por cima da dock que está em cima; enquanto a dock estiver em
// cima, eles descem para logo abaixo dela.
//
// Tudo o que é mudado é anotado e desfeito em restore()/disable().

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {getStyle} from './styles.js';
import {IdleRunner, Position} from './utils.js';

const MOVE_MS = 250;
const BANNER_GAP = 8;

export class PanelMover {
    /**
     * @param {Gio.Settings} settings - as configurações da Orla
     * @param {object} hooks
     * @param {Function} hooks.onMoved - a barra terminou de mudar de lugar
     *   (a dock se reposiciona DEPOIS disso, sem buraco nem sobreposição)
     * @param {Function} hooks.dockBottom - onde termina, em y, a dock que
     *   está em cima no monitor principal (ou null)
     */
    constructor(settings, {onMoved = () => {}, dockBottom = () => null} = {}) {
        this._settings = settings;
        this._onMoved = onMoved;
        this._dockBottom = dockBottom;
        this._enabled = false;
        this._atBottom = false;       // a barra está (ou está indo) para baixo?
        this._expectedShift = 0;      // o deslocamento que NÓS pusemos
        this._conflict = false;       // outra extensão mexe na barra?
        this._arrows = new Map();     // BoxPointer → lado original da seta
        this._bannerShift = false;
        this._sync = new IdleRunner(() => this._apply(true));
        this._fixMenus = new IdleRunner(() => this._pointMenusUp());
    }

    get _box() {
        return Main.layoutManager.panelBox;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        const queue = () => this._sync.queue();
        this._settings.connectObject(
            'changed::position', queue,
            'changed::panel-to-bottom', queue,
            'changed::bar-style', queue,
            'changed::taskbar-merge-panel', queue,
            this);
        // Monitores e escala: o GNOME reposiciona a caixa e a altura pode
        // mudar; refazemos a conta do deslocamento.
        Main.layoutManager.connectObject('monitors-changed', queue, this);
        this._box.connectObject(
            'notify::height', queue,
            'notify::visible', queue,
            'notify::translation-y', () => this._watchForeignMoves(),
            this);
        // Tela de bloqueio: lá a barra tem de estar no topo, como o GNOME
        // espera; ao desbloquear, voltamos a olhar a posição da dock.
        Main.sessionMode.connectObject('updated', queue, this);
        // Indicadores que outras extensões acrescentarem depois.
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
            box?.connectObject('child-added', () => this._fixMenus.queue(), this);
        // Avisos de notificação (ver _placeBanner).
        const banner = Main.messageTray._bannerBin;
        banner?.connectObject('notify::y', () => this._placeBanner(),
            'notify::height', () => this._placeBanner(), this);

        // Na inicialização (ou ao ligar a extensão) a barra vai direto para
        // o lugar, sem animação: nada de "piscar".
        this._apply(false);
    }

    /** A barra deve ficar embaixo agora? */
    _wanted() {
        const s = this._settings;
        if (Main.sessionMode.isLocked || !this._box.visible)
            return false;
        if (s.get_enum('position') !== Position.TOP || !s.get_boolean('panel-to-bottom'))
            return false;
        // No modo Painel das barras de tarefas a barra do GNOME já está
        // escondida (os itens dela moram na barra de tarefas).
        const style = getStyle(s.get_string('bar-style'));
        return !(style.mergePanel && style.fullWidth && s.get_boolean('taskbar-merge-panel'));
    }

    /** A dock está em cima sem o modo Painel (os avisos precisam descer)? */
    _dockOnTop() {
        const s = this._settings;
        const style = getStyle(s.get_string('bar-style'));
        const panelMode = style.mergePanel && style.fullWidth && s.get_boolean('taskbar-merge-panel');
        return !Main.sessionMode.isLocked && s.get_enum('position') === Position.TOP && !panelMode;
    }

    _apply(animate) {
        if (!this._enabled)
            return;
        if (this._wanted())
            this.moveToBottom(animate);
        else
            this.restore(animate);
        this._placeBanner();
    }

    /** Quanto a caixa precisa descer para encostar na borda de baixo. */
    _bottomShift() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return 0;
        // y final = monitor.y + monitor.height − altura da barra; a caixa
        // fica em monitor.y, então o deslocamento é a diferença.
        return monitor.y + monitor.height - this._box.height - this._box.y;
    }

    moveToBottom(animate = true) {
        if (this._conflict)
            return;
        if (!this._atBottom && Math.abs(this._box.translation_y) > 0.5) {
            // Alguém já deslocou a barra antes de nós: não brigamos.
            this._reportConflict('a barra já estava deslocada por outra extensão');
            return;
        }
        this._atBottom = true;
        Main.panel.add_style_class_name('orla-panel-bottom');
        this._pointMenusUp();
        this._slideTo(this._bottomShift(), animate);
    }

    restore(animate = true) {
        if (!this._atBottom)
            return;
        this._atBottom = false;
        Main.panel.remove_style_class_name('orla-panel-bottom');
        this._restoreMenus();
        // A dock que está em cima abre espaço JÁ (antes de a barra chegar),
        // para as duas não se sobreporem durante a subida.
        this._onMoved();
        this._slideTo(0, animate);
    }

    _slideTo(shift, animate) {
        const box = this._box;
        this._expectedShift = shift;
        // Mudanças rápidas seguidas: a animação anterior é cancelada e a
        // nova parte de onde a barra está (sem pulo e sem ficar no meio).
        box.remove_transition('translation-y');
        if (!animate || !St.Settings.get().enable_animations || Main.layoutManager._startingUp) {
            box.translation_y = shift;
            this._finished();
            return;
        }
        box.ease({
            translation_y: shift,
            duration: MOVE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._finished(),
        });
    }

    _finished() {
        this._refreshRegions();
        this._onMoved();
        this._placeBanner();
    }

    /**
     * Pede ao GNOME para recalcular as áreas reservadas (struts) e as
     * regiões de entrada. Ele não faz isso sozinho quando só o deslocamento
     * (translation) muda. É uma função interna do LayoutManager, por isso a
     * chamada é protegida: se ela sumir numa versão futura, nada quebra.
     */
    _refreshRegions() {
        Main.layoutManager._queueUpdateRegions?.();
    }

    /** Outra extensão mexeu no deslocamento da barra enquanto ela é nossa. */
    _watchForeignMoves() {
        const box = this._box;
        if (!this._atBottom || box.get_transition('translation-y'))
            return;
        if (Math.abs(box.translation_y - this._expectedShift) > 0.5)
            this._reportConflict('outra extensão mudou a posição da barra');
    }

    _reportConflict(why) {
        if (this._conflict)
            return;
        this._conflict = true;
        console.log(`[Orla Dock] ${why}; a Orla deixa de mover a barra para não brigar com ela.`);
        // Desfaz só o que é nosso (menus, classe CSS), sem mexer na posição.
        this._atBottom = false;
        Main.panel.remove_style_class_name('orla-panel-bottom');
        this._restoreMenus();
    }

    // ---------- Menus abrindo para cima ----------

    _pointMenusUp() {
        if (!this._atBottom)
            return;
        for (const indicator of Object.values(Main.panel.statusArea)) {
            const pointer = indicator?.menu?._boxPointer;
            if (!pointer?.updateArrowSide || this._arrows.has(pointer))
                continue;
            this._arrows.set(pointer, pointer._userArrowSide ?? St.Side.TOP);
            pointer.connectObject('destroy', () => this._arrows.delete(pointer), this);
            pointer.updateArrowSide(St.Side.BOTTOM);
        }
    }

    _restoreMenus() {
        for (const [pointer, side] of this._arrows) {
            pointer.disconnectObject(this);
            pointer.updateArrowSide(side);
        }
        this._arrows.clear();
    }

    // ---------- Avisos de notificação ----------

    /**
     * O GNOME prende os avisos ao alto do monitor principal (não à área
     * livre). Com a dock em cima, deslocamos a caixa dos avisos para baixo
     * da dock; ela continua deslizando como sempre, só que a partir dali.
     */
    _placeBanner() {
        const banner = Main.messageTray._bannerBin;
        if (!banner)
            return;
        const bottom = this._enabled && this._dockOnTop() ? this._dockBottom() : null;
        if (bottom === null || !Number.isFinite(bottom)) {
            if (this._bannerShift) {
                banner.translation_y = 0;
                this._bannerShift = false;
            }
            return;
        }
        const monitor = Main.layoutManager.primaryMonitor;
        const shift = Math.max(0, Math.round(bottom - monitor.y + BANNER_GAP));
        if (banner.translation_y !== shift)
            banner.translation_y = shift;
        this._bannerShift = true;
    }

    disable() {
        if (!this._enabled)
            return;
        this._sync.cancel();
        this._fixMenus.cancel();
        // Volta tudo ao normal na hora (sem animação: a extensão está saindo).
        this._box.remove_transition('translation-y');
        this.restore(false);
        this._enabled = false;
        this._placeBanner();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._box.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
            box?.disconnectObject(this);
        Main.messageTray._bannerBin?.disconnectObject(this);
        this._conflict = false;
    }
}
