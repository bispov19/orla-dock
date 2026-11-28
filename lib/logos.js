// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// logos.js — os logos que o botão de aplicativos pode mostrar.
//
// O padrão é o logo da própria Orla Dock. Os das distros são desenhos
// simplificados nossos (icons/logos/*.svg), num selo redondo com o símbolo
// em branco: assim aparecem bem tanto na dock escura quanto na clara.
// "Do sistema" usa o logo que a própria distro instalada declara no
// /etc/os-release (LOGO=…), do jeito que era antes.
//
// Este arquivo não importa nada do GNOME: serve à extensão e às preferências.

/** O "Do sistema" não tem arquivo: vem do tema de ícones. */
export const SYSTEM_LOGO = 'system';

/** Ordem em que aparecem na galeria das preferências. */
export const LOGOS = [
    {id: 'orla-dock', file: 'orla-dock-logo.svg'},
    {id: SYSTEM_LOGO, file: null},
    {id: 'fedora', file: 'logos/fedora.svg'},
    {id: 'gnome', file: 'logos/gnome.svg'},
    {id: 'ubuntu', file: 'logos/ubuntu.svg'},
    {id: 'debian', file: 'logos/debian.svg'},
    {id: 'archlinux', file: 'logos/archlinux.svg'},
    {id: 'manjaro', file: 'logos/manjaro.svg'},
    {id: 'linuxmint', file: 'logos/linuxmint.svg'},
    {id: 'opensuse', file: 'logos/opensuse.svg'},
    {id: 'elementary', file: 'logos/elementary.svg'},
];

/**
 * Caminho do SVG de um logo, ou null para "Do sistema".
 * Um id desconhecido (configuração antiga/editada à mão) cai no da Orla.
 */
export function logoPath(extensionPath, id) {
    if (id === SYSTEM_LOGO)
        return null;
    const logo = LOGOS.find(l => l.id === id) ?? LOGOS[0];
    return `${extensionPath}/icons/${logo.file}`;
}
