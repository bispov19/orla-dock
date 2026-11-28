#!/usr/bin/env bash
# Orla Dock
# Copyright (c) 2026 Vinícius de Souza Bispo
# Licensed under the MIT License with Attribution Requirement - see LICENSE file
# SPDX-License-Identifier: LicenseRef-MIT-Attribution
#
# test-prefs.sh — abre a janela de preferências, passa por todas as abas
# nos temas claro e escuro e salva uma captura de cada.
#
# - GSETTINGS_BACKEND=memory: as opções ficam só na memória, então nada do
#   que o teste fizer muda as suas configurações de verdade.
# - Qualquer erro de JavaScript ou aviso vindo dos arquivos da Orla conta
#   como falha.
#
# Uso: ./scripts/test-prefs.sh
# A janela aparece rapidamente na tela enquanto as capturas são tiradas.

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="orla-dock@viniciusbispo19"

WORK="$(mktemp -d -t orla-prefs-XXXXXX)"
# O gettext das extensões só reconhece arquivos dentro de
# ".../gnome-shell/extensions/<uuid>/", então usamos um link com esse nome.
EXT="$WORK/gnome-shell/extensions/$UUID"
mkdir -p "$(dirname "$EXT")" "$WORK/out"
ln -s "$PROJECT_DIR" "$EXT"

glib-compile-schemas "$PROJECT_DIR/schemas"
# Traduções: compila o pt_BR para as capturas saírem em português.
mkdir -p "$PROJECT_DIR/locale/pt_BR/LC_MESSAGES"
msgfmt -o "$PROJECT_DIR/locale/pt_BR/LC_MESSAGES/orla-dock.mo" "$PROJECT_DIR/po/pt_BR.po"

FAILS=0
for scheme in light dark; do
    # O Shew (usado pelo prefs.js do GNOME) fica numa pasta própria do Shell.
    GI_TYPELIB_PATH=/usr/lib64/gnome-shell/girepository-1.0:/usr/lib64/gnome-shell \
    LD_LIBRARY_PATH=/usr/lib64/gnome-shell \
    GSETTINGS_BACKEND=memory LANGUAGE=pt_BR LANG=pt_BR.UTF-8 \
        timeout 120 gjs -m "$PROJECT_DIR/tests/prefs/render.js" "$EXT" "$WORK/out" "$scheme" \
        > "$WORK/$scheme.log" 2>&1 || FAILS=$((FAILS + 1))
    grep -E '^(PASS|FAIL)' "$WORK/$scheme.log"
    if grep -qE "JS ERROR|extensions/$UUID/" "$WORK/$scheme.log"; then
        echo "FAIL erro ou aviso da Orla ($scheme):"
        grep -B2 -A6 -E "JS ERROR|extensions/$UUID/" "$WORK/$scheme.log" | head -30
        FAILS=$((FAILS + 1))
    fi
done

echo
echo "Capturas: $WORK/out/"
if [ "$FAILS" -gt 0 ]; then
    echo "==> $FAILS falha(s)"
    exit 1
fi
echo "==> Tudo passou"
