// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// panel/notifications.js — avisos (banners) de notificação perto da barra.
//
// O GNOME mostra os avisos no alto da tela, no centro. Com a barra de
// tarefas embaixo e o relógio no canto, faz mais sentido o aviso surgir no
// canto da barra, acima do relógio (como no Windows).
//
// O aviso mora numa caixa do GNOME (o "bannerBin" da bandeja de mensagens)
// que desce do topo da tela com uma animação na propriedade `y`. Nós não
// mexemos nessa animação: só DESLOCAMOS a caixa (translation) para que, em
// cada quadro, ela fique no canto da barra. O deslocamento é recalculado
// quando o aviso muda de tamanho ou anda.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelSlot} from './panelSlot.js';

const GAP = 8;      // espaço entre o aviso e a barra
const MARGIN = 8;   // espaço até a borda da tela

export class NotificationPlacement {
    /**
     * @param {Clutter.Actor} bar - o fundo visível da barra
     * @param {Function} side - () → St.Side de que lado fica a barra
     */
    constructor(bar, side) {
        this._bar = bar;
        this._side = side;
        this._slot = null;
        this._anchor = null;
    }

    /** @param {Clutter.Actor} anchor - o canto onde o aviso aparece (o relógio) */
    enable(anchor) {
        const bin = Main.messageTray._bannerBin;
        if (this._slot || !bin)
            return;
        this._anchor = anchor;
        this._bin = bin;
        const slot = this._slot = new PanelSlot();
        slot.set(bin, {translation_x: 0, translation_y: 0});
        const sync = () => this._sync();
        slot.connect(bin, 'notify::y', sync, 'notify::width', sync, 'notify::height', sync);
        slot.connect(this._bar, 'notify::allocation', sync);
    }

    _placed(actor) {
        return this._slot?.alive(actor) && actor.mapped;
    }

    _sync() {
        const bin = this._bin;
        if (!this._placed(this._bar) || !this._placed(this._anchor) || !bin.get_parent())
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const gap = GAP * scale, margin = MARGIN * scale;
        const [barX, barY] = this._bar.get_transformed_position();
        const [barW, barH] = this._bar.get_transformed_size();
        const [anchorX, anchorY] = this._anchor.get_transformed_position();
        const [anchorW, anchorH] = this._anchor.get_transformed_size();
        const monitor = Main.layoutManager.primaryMonitor;
        const width = bin.width, height = bin.height;
        // bin.y vai de −altura (escondido) a 0 (à vista) na animação do
        // GNOME; `shown` repete esse movimento no nosso lugar.
        const shown = height > 0 ? 1 + bin.y / height : 1;

        let left, top;
        switch (this._side()) {
        case St.Side.TOP:
            left = anchorX + anchorW - width;
            top = barY + barH + gap - height * (1 - shown);
            break;
        case St.Side.LEFT:
            left = barX + barW + gap - width * (1 - shown);
            top = anchorY + anchorH - height;
            break;
        case St.Side.RIGHT:
            left = barX - gap - width * shown;
            top = anchorY + anchorH - height;
            break;
        default:    // embaixo: sobe a partir da barra
            left = anchorX + anchorW - width;
            top = barY - gap - height * shown;
        }
        left = Math.max(monitor.x + margin, Math.min(left, monitor.x + monitor.width - width - margin));

        // Onde a caixa estaria sem o deslocamento (posição dela na tela).
        const [binX, binY] = bin.get_parent().get_transformed_position();
        const tx = Math.round(left - binX - bin.x);
        const ty = Math.round(top - binY - bin.y);
        // Antes do primeiro layout, alguma medida ainda vem como NaN:
        // espera o próximo aviso de mudança.
        if (!Number.isFinite(tx) || !Number.isFinite(ty))
            return;
        bin.translation_x = tx;
        bin.translation_y = ty;
    }

    disable() {
        this._slot?.restore();
        this._slot = null;
        this._anchor = null;
        this._bin = null;
    }
}
