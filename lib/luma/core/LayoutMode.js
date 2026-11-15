// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// lib/luma/core/LayoutMode.js — versão MÍNIMA do LayoutMode da Luma Dock.
// Na Orla o Menu Iniciar existe nas barras de tarefas (Windows 10 e 7).

import {Settings} from './SettingsManager.js';

export function isStartMenuEnabled() {
    return Settings.startMenu;
}
