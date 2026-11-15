// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// lib/luma/core/SettingsManager.js — versão MÍNIMA do SettingsManager da
// Luma Dock. Os módulos copiados da Luma (Menu Iniciar, painel, bandeja)
// leem `Settings.algumaCoisa`; aqui cada propriedade é lida do GSettings
// da Orla (as chaves têm os mesmos nomes das da Luma).
//
// A Orla chama bindSettings() ao montar o painel e unbindSettings() ao
// desmontar.

let _settings = null;

export function bindSettings(settings) {
    _settings = settings;
}

export function unbindSettings() {
    _settings = null;
}

const POSITIONS = ['BOTTOM', 'TOP', 'LEFT', 'RIGHT'];
const bool = (key, fallback) => _settings ? _settings.get_boolean(key) : fallback;
const dbl = (key, fallback) => _settings ? _settings.get_double(key) : fallback;
const str = (key, fallback) => _settings ? _settings.get_string(key) : fallback;

export const Settings = {
    get blurEnabled() { return bool('blur-enabled', false); },
    get blurMode() { return str('blur-mode', 'dynamic'); },
    get blurIntensity() { return dbl('blur-intensity', 40); },
    get blurVibrancy() { return dbl('blur-vibrancy', 2); },
    get blurBrightness() { return dbl('blur-brightness', 0.25); },
    get blurBorderGlow() { return dbl('blur-border-glow', 0.2); },
    get blurHighlightAngle() { return dbl('blur-highlight-angle', 303); },
    get blurTintColor() { return str('blur-tint-color', '#241F31'); },
    get blurTintOpacity() { return dbl('blur-tint-opacity', 0.25); },
    get dockPosition() { return POSITIONS[_settings ? _settings.get_enum('position') : 0]; },
    // A Orla não tem o "painel dinâmico" (flutuante) da Luma: a barra de
    // tarefas sempre vai de ponta a ponta.
    get dynamicPanel() { return false; },
    get panelWorkspaceIndicator() { return bool('panel-workspace-indicator', true); },
    get startMenu() { return bool('start-menu', true); },
    get iconSize() { return _settings ? _settings.get_int('taskbar-icon-size') : 28; },
};
