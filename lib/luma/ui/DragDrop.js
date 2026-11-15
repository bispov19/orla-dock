// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// lib/luma/ui/DragDrop.js — só a função moveWithSlide() do DragDrop.js da
// Luma Dock (copiada como está): reordena um filho de uma caixa e faz os
// vizinhos deslizarem até o lugar novo.
//
// Dhruva GNOME Extension — Copyright (C) 2026 NarkAgni — GPL-3.0-or-later.

import Clutter from 'gi://Clutter';

const REORDER_SLIDE_MS = 200;

export function moveWithSlide(box, moved, index, isVertical) {
    const prop = isVertical ? 'translation_y' : 'translation_x';
    const transitionName = isVertical ? 'translation-y' : 'translation-x';
    const children = box.get_children();
    const before = children.map(c => (isVertical ? c.y : c.x));

    box.set_child_at_index(moved, index);
    box.get_allocation_box();

    children.forEach((c, i) => {
        if (c === moved) return;
        const delta = before[i] - (isVertical ? c.y : c.x);
        if (Math.abs(delta) < 1) return;

        c.remove_transition(transitionName);
        c[prop] += delta;
        c.ease({ [prop]: 0, duration: REORDER_SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
    });
}
