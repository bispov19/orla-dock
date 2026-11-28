// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License with Attribution Requirement - see LICENSE file
// SPDX-License-Identifier: LicenseRef-MIT-Attribution
//
// start/styles/index.js — os estilos do Menu Iniciar, pelo id salvo na
// opção start-menu-style. Um estilo novo é um arquivo nesta pasta mais
// uma linha aqui (e uma prévia em prefs/startMenuPage.js).

import {AlphabeticalStyle} from './alphabetical.js';
import {CategoriesStyle} from './categories.js';
import {ClassicStyle} from './classic.js';
import {LaunchpadStyle} from './launchpad.js';
import {ModernStyle} from './modern.js';

const STYLES = {
    classic: ClassicStyle,
    modern: ModernStyle,
    categories: CategoriesStyle,
    alphabetical: AlphabeticalStyle,
    launchpad: LaunchpadStyle,
};

export const STYLE_IDS = Object.keys(STYLES);

/** Monta o estilo `id` (um id desconhecido cai no Clássico moderno). */
export function createStyle(id, menu, factor) {
    const Style = STYLES[id] ?? ModernStyle;
    return new Style(menu, factor);
}
