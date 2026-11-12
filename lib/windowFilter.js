// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// windowFilter.js — "Janelas ocultas": janelas que a dock finge não ver.
//
// Alguns programas mostram avisos na tela (ex.: o indicador de Caps Lock do
// OpenLogi) como janelas comuns, e isso faz um ícone extra aparecer na dock.
// O usuário lista padrões de CLASSE de janela (o app_id no Wayland),
// separados por vírgula; "*" significa "qualquer texto". Ex.: "openlogi-*".
//
// Este módulo não importa nada do GNOME (pode ser testado com `node`).

let _raw = null;
let _regexps = [];

function escapeRegExp(text) {
    return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** "a, b c" → ['a', 'b', 'c'] (minúsculas, sem vazios). */
export function parsePatterns(raw) {
    return (raw ?? '')
        .split(/[\s,;]+/)
        .map(pattern => pattern.trim().toLowerCase())
        .filter(pattern => pattern.length > 0);
}

/** Converte um curinga ("*" = qualquer texto) numa expressão regular. */
export function patternToRegExp(pattern) {
    return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i');
}

/** Atualiza a lista (chamado pelo DockManager quando a opção muda). */
export function setHiddenPatterns(raw) {
    if (raw === _raw)
        return;
    _raw = raw;
    _regexps = parsePatterns(raw).map(patternToRegExp);
}

function matches(text) {
    return Boolean(text) && _regexps.some(re => re.test(text));
}

/**
 * A dock deve ignorar esta janela?
 *   - a classe (ou o ID de aplicativo GTK) casa com um dos padrões; ou
 *   - a janela ainda não está pronta: sem classe, sem título e ainda não
 *     desenhada. No Wayland, alguns programas criam a janela antes de dizer
 *     o app_id, e por um instante ela não poderia ser reconhecida.
 */
export function isHiddenWindow(win) {
    if (!win)
        return false;
    const unready = !win.get_wm_class?.() && !win.get_title?.() &&
        !win.minimized && Boolean(win.is_hidden?.());
    if (unready)
        return true;
    if (_regexps.length === 0)
        return false;
    return matches(win.get_wm_class?.()) || matches(win.get_gtk_application_id?.());
}
