// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// lib/luma/ui/magnifier/MagnifierState.js — versão MÍNIMA do estado da lupa
// da Luma Dock. Enquanto o Menu Iniciar está aberto, a ampliação da Orla
// fica parada (a ponte guarda a função em `actor._orlaPauseZoom`).

export function setMagnifierPauseState(dockActor, _reason, isPaused) {
    dockActor?._orlaPauseZoom?.(isPaused);
}
