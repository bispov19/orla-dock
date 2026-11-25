#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# perf.sh — mede a fluidez (Visão Geral, áreas de trabalho, Menu Iniciar)
# num GNOME Shell de teste sem janela, com e sem a Orla Dock. Veja
# tests/perf/orla-perf@local/extension.js para o que é medido.
#
# Uso:
#   ./scripts/perf.sh                      # opções padrão da Orla
#   ./scripts/perf.sh minhas-opcoes.ini    # opções de um "dconf dump"
#
# Para medir com as SUAS opções:
#   dconf dump /org/gnome/shell/extensions/orla-dock/ > /tmp/orla.ini
#   ./scripts/perf.sh /tmp/orla.ini
#
# Os números são da CPU do Shell e do ritmo dos quadros nesta máquina; o
# que vale é a COMPARAÇÃO entre as cenas (sem Orla × com Orla).

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="orla-dock@viniciusbispo19"
SETTINGS_FILE="${1:-}"

WORK="$(mktemp -d -t orla-perf-XXXXXX)"
mkdir -p "$WORK/config" "$WORK/data/gnome-shell/extensions" "$WORK/out"
ln -s "$PROJECT_DIR" "$WORK/data/gnome-shell/extensions/$UUID"
ln -s "$PROJECT_DIR/tests/perf/orla-perf@local" "$WORK/data/gnome-shell/extensions/orla-perf@local"
[ -n "$SETTINGS_FILE" ] && cp "$SETTINGS_FILE" "$WORK/settings.ini"
glib-compile-schemas "$PROJECT_DIR/schemas"

# O Shell de teste roda por um atalho com outro nome de processo
# ("orla-test-shell"): ferramentas que encerram "gnome-shell --headless"
# soltos (ex.: as de outros projetos) não derrubam estes testes no meio.
ln -s "$(command -v gnome-shell)" "$WORK/orla-test-shell"

cat > "$WORK/session.sh" <<'INNER'
#!/usr/bin/env bash
dconf write /org/gnome/shell/enabled-extensions "['orla-dock@viniciusbispo19', 'orla-perf@local']"
dconf write /org/gnome/shell/disable-user-extensions false
dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"
dconf write /org/gnome/shell/favorite-apps "['org.gnome.Nautilus.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Calculator.desktop']"
[ -f "$ORLA_PERF_DIR/settings.ini" ] && dconf load /org/gnome/shell/extensions/orla-dock/ < "$ORLA_PERF_DIR/settings.ini"
exec timeout 600 "$ORLA_SHELL" --headless --virtual-monitor 1920x1080 --wayland --no-x11 --force-animations
INNER
chmod +x "$WORK/session.sh"

echo "==> Medindo (pasta: $WORK)"
env -u WAYLAND_DISPLAY -u DISPLAY \
    XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" \
    ORLA_PERF_OUT="$WORK/out" ORLA_PERF_DIR="$WORK" ORLA_PERF_TAG="${ORLA_PERF_TAG:-atual}" ORLA_PERF_ONLY="${ORLA_PERF_ONLY:-}" \
    ORLA_SHELL="$WORK/orla-test-shell" dbus-run-session -- "$WORK/session.sh" > "$WORK/shell.log" 2>&1

grep -o 'ORLAPERF .*' "$WORK/shell.log" | sed 's/^ORLAPERF //'
grep -q 'ORLAPERF DONE' "$WORK/shell.log" || { echo "FAIL a medição não chegou ao fim"; exit 1; }
echo "Capturas: $WORK/out/"
