// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// lib/luma/ui/dock/DockThemeResolver.js — versão MÍNIMA do resolvedor de
// cores da Luma Dock. O balão do Menu Iniciar e da bandeja usa as cores do
// tema da Orla (a mesma cor dos rótulos e das Stacks), calculadas pela
// ponte (lib/lumaBridge.js).

export function resolvePopupBubbleColors(dockUI) {
    return dockUI.popupBubbleColors();
}
