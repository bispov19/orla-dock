#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# install.sh — prepara a Orla Dock para rodar a partir da pasta do projeto.
#
# O que ele faz:
#   1. Compila o schema GSettings (gera schemas/gschemas.compiled).
#   2. Compila as traduções (po/*.po → locale/<idioma>/LC_MESSAGES/orla-dock.mo).
#   3. Cria um link simbólico da pasta do projeto em
#      ~/.local/share/gnome-shell/extensions/orla-dock@viniciusbispo19
#      — assim o GNOME Shell enxerga a extensão, e qualquer edição que você
#      fizer no projeto já vale (basta recarregar o Shell).
#
# Pode rodar quantas vezes quiser: ele é idempotente.

set -euo pipefail

UUID="orla-dock@viniciusbispo19"
DOMAIN="orla-dock"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
LINK="$EXT_DIR/$UUID"

echo "==> Compilando schema GSettings"
glib-compile-schemas --strict "$PROJECT_DIR/schemas"

echo "==> Compilando traduções"
for po in "$PROJECT_DIR"/po/*.po; do
    [ -e "$po" ] || continue
    lang="$(basename "$po" .po)"
    out="$PROJECT_DIR/locale/$lang/LC_MESSAGES"
    mkdir -p "$out"
    msgfmt --check -o "$out/$DOMAIN.mo" "$po"
    echo "    $lang"
done

echo "==> Criando link em $LINK"
mkdir -p "$EXT_DIR"
if [ -L "$LINK" ]; then
    rm "$LINK"
elif [ -e "$LINK" ]; then
    echo "ERRO: $LINK existe e não é um link simbólico. Remova-o manualmente." >&2
    exit 1
fi
ln -s "$PROJECT_DIR" "$LINK"

echo "==> Pronto! A extensão está instalada (link simbólico)."
