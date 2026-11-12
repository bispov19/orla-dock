// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// themes.js — transforma as opções de aparência em CSS do St.
//
// Os temas prontos usam as cores PÚBLICAS de paletas conhecidas (Nord,
// Catppuccin, Gruvbox, Dracula, Tokyo Night). "Sistema" segue o estilo
// claro/escuro do GNOME; "Personalizado" usa a cor (e o gradiente) que você
// escolher; "Papel de parede" usa a cor predominante da imagem de fundo.
//
// Este módulo é "puro" (não importa nada do Shell): só recebe números e
// devolve textos. Isso o torna fácil de entender e de testar.

export const Theme = Object.freeze({
    SYSTEM: 0, CUSTOM: 1, WALLPAPER: 2, CARBON: 3, NORD: 4,
    CATPPUCCIN: 5, GRUVBOX: 6, DRACULA: 7, TOKYO_NIGHT: 8, FROST: 9,
});

export const ColorMode = Object.freeze({AUTO: 0, ACCENT: 1, CUSTOM: 2});

// [cor inicial, cor final (gradiente horizontal) ou null]
const PALETTES = {
    [Theme.CARBON]: [[18, 18, 20], null],
    [Theme.NORD]: [[46, 52, 64], [59, 66, 82]],
    [Theme.CATPPUCCIN]: [[30, 30, 46], [49, 50, 68]],
    [Theme.GRUVBOX]: [[40, 40, 40], [60, 56, 54]],
    [Theme.DRACULA]: [[40, 42, 54], [68, 71, 90]],
    [Theme.TOKYO_NIGHT]: [[26, 27, 38], [36, 40, 59]],
    [Theme.FROST]: [[236, 239, 244], null],
};

// Cores de destaque do GNOME (Configurações → Aparência → Cor de destaque).
const ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800',
    orange: '#ed5b00', red: '#e62d42', pink: '#d56199', purple: '#9141ac',
    slate: '#6f8396',
};

export function accentHex(name) {
    return ACCENTS[name] ?? ACCENTS.blue;
}

/** '#rrggbb' → [r, g, b] (0..255). Aceita também '#rgb'. */
export function hexToRgb(hex) {
    let h = (hex ?? '').replace('#', '').trim();
    if (h.length === 3)
        h = h.split('').map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    if (Number.isNaN(n))
        return [255, 255, 255];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba([r, g, b], alpha) {
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha.toFixed(3)})`;
}

/** Luminância relativa (0 = preto, 1 = branco), como na WCAG. */
export function luminance([r, g, b]) {
    const lin = v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Calcula a aparência da dock.
 *
 * @param {object} o - opções já lidas do GSettings + contexto do sistema
 * @returns {{background: string, dark: boolean, base: number[]}}
 */
export function dockStyle(o) {
    let start, end = null, dark;

    switch (o.theme) {
    case Theme.CUSTOM:
        start = hexToRgb(o.backgroundColor);
        end = o.useGradient ? hexToRgb(o.gradientColor) : null;
        break;
    case Theme.WALLPAPER:
        start = o.wallpaperRgb ?? (o.systemDark ? [30, 30, 34] : [246, 246, 250]);
        break;
    case Theme.SYSTEM:
        start = o.systemDark ? [30, 30, 34] : [246, 246, 250];
        break;
    default:
        [start, end] = PALETTES[o.theme] ?? PALETTES[Theme.CARBON];
    }
    dark = luminance(start) < 0.4;

    const a = o.opacity;
    let background;
    if (end) {
        const direction = o.theme === Theme.CUSTOM && o.gradientDirection === 0
            ? 'vertical' : 'horizontal';
        background = 'background-color: transparent;' +
            `background-gradient-direction: ${direction};` +
            `background-gradient-start: ${rgba(start, a)};` +
            `background-gradient-end: ${rgba(end, a)};`;
    } else {
        background = `background-color: ${rgba(start, a)}; background-gradient-direction: none;`;
    }

    let border = 'border: none;';
    if (o.borderWidth > 0)
        border = `border: ${o.borderWidth}px solid ${rgba(hexToRgb(o.borderColor), o.borderOpacity)};`;

    // Brilho na borda: uma sombra INTERNA clara simula a luz batendo no vidro.
    let glow = '';
    if (o.glow > 0.01) {
        const blur = Math.round(2 + o.glow * 8);
        glow = `box-shadow: inset 0 0 ${blur}px ${rgba([255, 255, 255], o.glow * 0.5)};`;
    }

    return {
        background: `${background} border-radius: ${o.radius}px; ${border} ${glow}`,
        dark,
        base: start,
    };
}

/** Cor (CSS) de algo que pode seguir o tema, o destaque ou ser personalizado. */
export function pickColor(mode, customHex, accent, autoCss) {
    if (mode === ColorMode.ACCENT)
        return rgba(hexToRgb(accent), 1);
    if (mode === ColorMode.CUSTOM)
        return rgba(hexToRgb(customHex), 1);
    return autoCss;
}
