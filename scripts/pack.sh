#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# pack.sh — gera o pacote .zip da extensão (o formato que se envia ao
# extensions.gnome.org ou que se instala com "gnome-extensions install").
#
# O "gnome-extensions pack" junta metadata.json, extension.js, prefs.js e
# stylesheet.css automaticamente; o prefs.css, as pastas extras e as
# traduções precisam ser indicadas. O schema vai sem compilar: desde o
# GNOME 44 o próprio Shell compila ao instalar.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
mkdir -p dist

gnome-extensions pack --force \
    --extra-source=lib \
    --extra-source=prefs \
    --extra-source=icons \
    --extra-source=LICENSE \
    --extra-source=prefs.css \
    --schema=schemas/org.gnome.shell.extensions.orla-dock.gschema.xml \
    --podir=po \
    --gettext-domain=orla-dock \
    --out-dir=dist \
    .

echo "==> Pacote gerado em: $(ls dist/*.shell-extension.zip)"
