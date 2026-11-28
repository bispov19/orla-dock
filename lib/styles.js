// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// styles.js — REGISTRO ÚNICO dos estilos de barra.
//
// Cada estilo é um objeto isolado que descreve como a barra se comporta e
// calcula a própria geometria. A dock (dock.js) e os itens (dockItem.js)
// só perguntam ao estilo ativo; eles não sabem "qual" estilo é.
//
// Para criar um estilo novo:
//   1. escreva um objeto como DOCK_STYLE ou TASKBAR_STYLE abaixo;
//   2. acrescente-o na lista STYLES (no fim do arquivo).
// Pronto: ele aparece na aba "Estilos" das preferências e no menu da dock.
// O valor salvo no GSettings ('bar-style') é o `id` do estilo.
//
// Este arquivo não importa nada do GNOME, então serve tanto para a extensão
// quanto para a janela de preferências.

// Marca textos para tradução sem traduzir aqui (cada processo traduz com o
// seu próprio gettext na hora de mostrar).
const N_ = text => text;

/**
 * Campos de um estilo:
 *   id, name, description, icon  → identificação e aparência no seletor
 *   iconSizeKey                   → chave do GSettings com o tamanho do ícone
 *   align: 'center' | 'start'     → onde os ícones ficam
 *   fullWidth                     → ocupa a borda inteira (sem margem)
 *   roundCorners                  → respeita o arredondamento escolhido
 *   separators                    → mostra separadores entre seções
 *   magnification, bounce         → ampliação e quique
 *   clock                         → relógio com data no fim
 *   cellHighlight                 → célula destacada no hover/foco
 *   edgeIndicator                 → indicador como traço colado na borda
 *   attention: 'bounce' | 'highlight'
 *   appsButtonAtEnd               → botão de aplicativos no FIM (como no GNOME)
 *   mergePanel                    → a barra superior do GNOME entra na barra
 *                                   (relógio, bandeja, indicadores, Atividades)
 *   geometry(iconSize, settings, axis) → medidas da barra; `highlight` diz
 *                                   como desenhar o destaque da célula:
 *                                   {around: 'cell' | 'icon', pad, radius}
 */

const DOCK_STYLE = {
    id: 'dock',
    name: N_('Dock (macOS)'),
    description: N_('Floating, centred, with icon magnification'),
    icon: 'user-desktop-symbolic',
    iconSizeKey: 'icon-size',
    align: 'center',
    fullWidth: false,
    roundCorners: true,
    separators: true,
    magnification: true,
    bounce: true,
    clock: false,
    cellHighlight: false,
    edgeIndicator: false,
    attention: 'bounce',
    appsButtonAtEnd: false,
    mergePanel: false,

    geometry(iconSize, s, axis) {
        const spacing = s.get_int('icon-spacing');
        const extra = s.get_int('dock-padding');
        // Espaço do lado de dentro e do lado da borda. O da borda reserva
        // lugar para o indicador com folga (≥ 4px de cada lado), para ele
        // nunca encostar no contorno da dock.
        const farPad = Math.max(5, Math.round(iconSize * 0.14)) + extra;
        const indicatorThick = s.get_boolean('show-indicators') ? s.get_int('indicator-size') : 0;
        const edgePad = Math.max(farPad, indicatorThick + 8 + extra);
        return {
            gap: spacing / 2,
            farPad, edgePad,
            iconCross: axis.edgeAtEnd ? farPad : edgePad,
            thickness: iconSize + farPad + edgePad,
            cellLength: iconSize + spacing,
            endPadding: farPad,
            maxScale: Math.max(1, s.get_double('magnification')),
            margin: s.get_int('dock-margin'),
            reflection: s.get_boolean('icon-reflection'),
        };
    },
};

const TASKBAR_STYLE = {
    id: 'taskbar',
    name: N_('Taskbar (Windows 10)'),
    description: N_('Edge to edge, icons on the left, clock and date at the end'),
    icon: 'view-continuous-symbolic',
    iconSizeKey: 'taskbar-icon-size',
    align: 'start',
    fullWidth: true,
    roundCorners: false,
    separators: false,
    magnification: false,
    bounce: false,
    clock: true,
    cellHighlight: true,
    edgeIndicator: true,
    attention: 'highlight',
    appsButtonAtEnd: false,
    mergePanel: true,

    geometry(iconSize, _s, _axis) {
        // Células largas, ícones menores, sem ampliação, colada na borda.
        const cell = Math.round(iconSize * 1.75);
        const pad = Math.round(iconSize * 0.34);
        return {
            gap: (cell - iconSize) / 2,
            farPad: pad, edgePad: pad, iconCross: pad,
            thickness: iconSize + pad * 2,
            cellLength: cell,
            endPadding: 0,
            maxScale: 1,
            margin: 0,
            reflection: false,
            highlight: {around: 'cell', pad: 1, radius: 3},
        };
    },
};

/**
 * A dock padrão do GNOME (a "Dash" da Visão Geral levada para a área de
 * trabalho): flutuante e centralizada, sem ampliação, o botão de
 * aplicativos no fim e um quadrado arredondado em volta do ícone no hover.
 */
const GNOME_STYLE = {
    id: 'gnome',
    name: N_('Dock (GNOME)'),
    description: N_('Floating like the GNOME dash, no magnification, applications button at the end'),
    icon: 'view-app-grid-symbolic',
    iconSizeKey: 'icon-size',
    align: 'center',
    fullWidth: false,
    roundCorners: true,
    separators: true,
    magnification: false,
    bounce: false,
    clock: false,
    cellHighlight: true,
    edgeIndicator: false,
    attention: 'highlight',
    appsButtonAtEnd: true,
    mergePanel: false,

    geometry(iconSize, s, axis) {
        const extra = s.get_int('dock-padding');
        // O destaque fica em volta do ícone, então cada célula tem uma
        // folga própria (como os botões da Dash do GNOME).
        const inner = Math.max(4, Math.round(iconSize * 0.14));
        const spacing = s.get_int('icon-spacing');
        const farPad = Math.max(6, Math.round(iconSize * 0.16)) + extra;
        const indicatorThick = s.get_boolean('show-indicators') ? s.get_int('indicator-size') : 0;
        const edgePad = Math.max(farPad, indicatorThick + 8 + extra);
        const cell = iconSize + inner * 2 + spacing;
        return {
            gap: (cell - iconSize) / 2,
            farPad, edgePad,
            iconCross: axis.edgeAtEnd ? farPad : edgePad,
            thickness: iconSize + farPad + edgePad,
            cellLength: cell,
            endPadding: Math.max(4, farPad - inner),
            maxScale: 1,
            margin: s.get_int('dock-margin'),
            reflection: false,
            highlight: {around: 'icon', pad: inner, radius: Math.round(iconSize * 0.24), focus: false},
        };
    },
};

/** A lista: a ordem aqui é a ordem no seletor. */
export const STYLES = [DOCK_STYLE, TASKBAR_STYLE, GNOME_STYLE];

export function getStyle(id) {
    return STYLES.find(style => style.id === id) ?? STYLES[0];
}
