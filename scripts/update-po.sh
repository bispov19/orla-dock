#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# update-po.sh — atualiza os arquivos de tradução.
#
# Fluxo do gettext:
#   1. xgettext varre o código procurando _('texto') e gera o "molde"
#      po/orla-dock.pot (todos os textos, sem tradução).
#   2. msgmerge atualiza cada po/<idioma>.po com os textos novos/alterados,
#      preservando o que já foi traduzido.
#   3. Você traduz o .po (no VS Code mesmo, ou no app Gtranslator).
#   4. install.sh compila o .po em .mo, que é o formato lido em tempo real.

set -euo pipefail

DOMAIN="orla-dock"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Todos os .js do projeto (exceto node_modules, se um dia existir).
mapfile -t SOURCES < <(find . -name '*.js' -not -path './node_modules/*' -printf '%P\n' | sort)

echo "==> Extraindo textos de ${#SOURCES[@]} arquivos"
xgettext \
    --from-code=UTF-8 \
    --language=JavaScript \
    --keyword=_ --keyword=N_ --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
    --package-name="Orla Dock" \
    --msgid-bugs-address="https://github.com/viniciusbispo19/orla-dock/issues" \
    --add-comments=Translators \
    --output="po/$DOMAIN.pot" \
    "${SOURCES[@]}"

for po in po/*.po; do
    [ -e "$po" ] || continue
    echo "==> Atualizando $po"
    msgmerge --update --backup=none --previous "$po" "po/$DOMAIN.pot"
done
