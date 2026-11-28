// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// glassBackdrops.js — os fundos prontos do vidro ESTÁTICO (icons/glass/).
//
// No modo estático o vidro desfoca uma imagem fixa em vez do que está
// atrás da dock (mais leve para a placa de vídeo). Esta lista é usada pela
// dock e pelas preferências. Um id desconhecido (ex.: salvo por uma versão
// antiga) cai no primeiro fundo.

import GLib from 'gi://GLib';

const N_ = text => text;

export const BACKDROPS = [
    {id: 'tide', name: N_('Tide')},
    {id: 'coral', name: N_('Coral')},
    {id: 'mist', name: N_('Haze')},
    {id: 'amber', name: N_('Amber')},
    {id: 'night', name: N_('Night sky')},
];

export function backdropId(id) {
    return BACKDROPS.some(b => b.id === id) ? id : BACKDROPS[0].id;
}

export function backdropPath(extensionPath, id) {
    return GLib.build_filenamev([extensionPath, 'icons', 'glass', `${backdropId(id)}.svg`]);
}
