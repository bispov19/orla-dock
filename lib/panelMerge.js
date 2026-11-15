// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// panelMerge.js — funde a barra superior do GNOME na barra de tarefas.
//
// A barra superior (Main.panel) tem três caixas: esquerda (Atividades e
// itens de extensões), centro (relógio/calendário) e direita (indicadores,
// bandeja, configurações rápidas). Aqui nós:
//   1. MOVEMOS o conteúdo dessas caixas para duas caixas nossas: `startBox`
//      (itens da esquerda, logo depois do botão de aplicativos) e `endBox`
//      (indicadores e, por último, o relógio — como no Windows);
//   2. tiramos a barra de cima da reserva de espaço e a escondemos;
//   3. vigiamos as caixas originais: indicadores que outras extensões
//      adicionarem depois (ex.: ícones da bandeja) vêm para a nossa barra.
// No destroy() tudo volta exatamente para onde estava.
//
// Os itens continuam sendo os do GNOME (mesmos menus e comportamento); só
// mudam de lugar. As nossas caixas se chamam 'panel' para herdar o tema
// dos botões do painel (CSS "#panel .panel-button").

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class PanelMerge {
    constructor() {
        const panel = Main.panel;
        this._left = panel._leftBox;
        this._center = panel._centerBox;
        this._right = panel._rightBox;
        this._dateContainer = panel.statusArea.dateMenu?.container ?? null;
        // A ORDEM de cada caixa da barra de cima, como se os itens ainda
        // estivessem lá: serve para devolvê-los exatamente na mesma ordem e
        // para a nossa barra seguir a mesma sequência.
        this._order = new Map();
        this._restoring = false;

        const boxParams = {
            name: 'panel',
            style_class: 'orla-tray',
            y_align: Clutter.ActorAlign.CENTER,
        };
        this.startBox = new St.BoxLayout(boxParams);
        this.endBox = new St.BoxLayout(boxParams);

        for (const box of [this._left, this._center, this._right]) {
            this._order.set(box, []);
            for (const child of box.get_children())
                this._take(child, box, Infinity);
            box.connectObject('child-added', (_b, child) =>
                this._take(child, box, box.get_children().indexOf(child)), this);
        }
        this._syncOrder();
        this._hidePanel();
    }

    /**
     * Leva um item da barra de cima para a nossa. `index` é a posição em que
     * ele entrou na caixa original (com ela vazia, o GNOME sempre põe no
     * começo — então um indicador novo vira o primeiro da caixa).
     */
    _take(child, box, index) {
        // Ao bloquear a tela, o GNOME recoloca os itens na barra de cima (com
        // a ordem da tela de bloqueio) ANTES de a dock ser desfeita: deixamos
        // com ele, senão a ordem dos ícones ficaria trocada.
        if (this._restoring || Main.sessionMode.isLocked)
            return;
        const order = this._order.get(box);
        if (!order.includes(child))
            order.splice(Math.min(Math.max(0, index), order.length), 0, child);
        child.connectObject('destroy', () => {
            for (const list of this._order.values()) {
                const i = list.indexOf(child);
                if (i >= 0)
                    list.splice(i, 1);
            }
        }, this);
        box.remove_child(child);
        (box === this._left ? this.startBox : this.endBox).add_child(child);
        if (index !== Infinity)
            this._syncOrder();
    }

    /**
     * Ordem na nossa barra: começo = itens da esquerda; fim = centro, depois
     * direita e, por último, o relógio (como no Windows).
     */
    _syncOrder() {
        const center = this._order.get(this._center).filter(c => c !== this._dateContainer);
        const date = this._dateContainer ? [this._dateContainer] : [];
        const wanted = [
            [this.startBox, this._order.get(this._left)],
            [this.endBox, [...center, ...this._order.get(this._right), ...date]],
        ];
        for (const [box, list] of wanted) {
            let index = 0;
            for (const child of list) {
                if (child.get_parent() === box)
                    box.set_child_at_index(child, index++);
            }
        }
    }

    /**
     * Esconde a barra de cima. Só esconder não basta: o Shell continuaria
     * reservando o espaço dela (strut). Por isso a tiramos do "chrome"
     * (removeChrome) e a recolocamos no palco, escondida e sem reserva.
     */
    _hidePanel() {
        const layout = Main.layoutManager;
        const panelBox = layout.panelBox;
        layout.removeChrome(panelBox);
        layout.uiGroup.add_child(panelBox);
        panelBox.hide();
        // Outras extensões podem tentar mostrá-la de novo.
        panelBox.connectObject('notify::visible', () => {
            if (panelBox.visible)
                panelBox.hide();
        }, this);
    }

    _showPanel() {
        const layout = Main.layoutManager;
        const panelBox = layout.panelBox;
        panelBox.disconnectObject(this);
        if (panelBox.get_parent() === layout.uiGroup)
            layout.uiGroup.remove_child(panelBox);
        layout.addChrome(panelBox, {affectsStruts: true, trackFullscreen: true});
        panelBox.show();
    }

    /** Algum menu da barra (calendário, configurações rápidas…) está aberto? */
    get menuOpen() {
        return Boolean(Main.panel.menuManager.activeMenu);
    }

    destroy() {
        this._restoring = true;
        for (const box of [this._left, this._center, this._right])
            box.disconnectObject(this);

        // Devolve cada item para a caixa de origem, na ordem guardada.
        const ours = [this.startBox, this.endBox];
        for (const [box, list] of this._order) {
            list.forEach((child, index) => {
                child.disconnectObject(this);
                const parent = child.get_parent();
                // O próprio GNOME pode já ter recolocado o item (ex.: ao
                // bloquear a tela); nesse caso não mexemos.
                if (!ours.includes(parent))
                    return;
                parent.remove_child(child);
                box.insert_child_at_index(child, Math.min(index, box.get_n_children()));
            });
        }
        this._order.clear();
        this._showPanel();
        this.startBox.destroy();
        this.endBox.destroy();
    }
}
