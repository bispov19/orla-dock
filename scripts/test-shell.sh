#!/usr/bin/env bash
# Orla Dock
# Copyright (c) 2026 Vinícius de Souza Bispo
# Licensed under the MIT License with Attribution Requirement - see LICENSE file
# SPDX-License-Identifier: LicenseRef-MIT-Attribution
#
# test-shell.sh — testa a Orla Dock dentro de um GNOME Shell de teste, sem
# janela (--headless), e diz se passou.
#
# O que acontece:
#   1. Cria uma pasta temporária com configurações e dados PRÓPRIOS
#      (XDG_CONFIG_HOME/XDG_DATA_HOME). Assim os testes mudam as opções à
#      vontade sem tocar nas suas configurações de verdade.
#   2. Liga lá a Orla Dock (este repositório) e a extensão de testes
#      (tests/shell/orla-test@local), que roda as verificações por dentro.
#   3. Lê o log: cada verificação vira PASS/FAIL, e qualquer erro ou aviso
#      vindo dos arquivos da Orla também conta como falha.
#
# Uso:
#   ./scripts/test-shell.sh          # tudo (uns 2 minutos)
#   ./scripts/test-shell.sh --quick  # pula "mudar todas as opções"
#
# Precisa do gnome-shell 51 e de um app simples instalado (Editor de Texto,
# Calculadora ou Arquivos) para abrir uma janela de teste.

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="orla-dock@viniciusbispo19"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

WORK="$(mktemp -d -t orla-test-XXXXXX)"
mkdir -p "$WORK/config" "$WORK/data/gnome-shell/extensions" "$WORK/out"
ln -s "$PROJECT_DIR" "$WORK/data/gnome-shell/extensions/$UUID"
ln -s "$PROJECT_DIR/tests/shell/orla-test@local" "$WORK/data/gnome-shell/extensions/orla-test@local"

# O schema precisa estar compilado para a extensão ler as opções.
glib-compile-schemas "$PROJECT_DIR/schemas"

# Roda dentro de um D-Bus próprio (dbus-run-session), então o dconf usado é
# o da pasta temporária, não o seu.
# O Shell de teste roda por um atalho com outro nome de processo
# ("orla-test-shell"): ferramentas que encerram "gnome-shell --headless"
# soltos (ex.: as de outros projetos) não derrubam estes testes no meio.
ln -s "$(command -v gnome-shell)" "$WORK/orla-test-shell"

cat > "$WORK/session.sh" <<'INNER'
#!/usr/bin/env bash
dconf write /org/gnome/shell/enabled-extensions "['orla-dock@viniciusbispo19', 'orla-test@local']"
dconf write /org/gnome/shell/disable-user-extensions false
dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"
dconf write /org/gnome/shell/favorite-apps "['org.gnome.Nautilus.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Calculator.desktop']"
exec timeout 600 "$ORLA_SHELL" --headless --virtual-monitor ${ORLA_TEST_MONITOR:-1920x1080} --wayland --no-x11 --force-animations
INNER
chmod +x "$WORK/session.sh"

echo "==> Iniciando o GNOME Shell de teste (pasta: $WORK)"
env -u WAYLAND_DISPLAY -u DISPLAY \
    XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" \
    ORLA_TEST_OUT="$WORK/out" ORLA_TEST_QUICK="$QUICK" ORLA_TEST_IMAGE="${ORLA_TEST_IMAGE:-}" \
    SHELL_DEBUG=backtrace-warnings \
    ORLA_SHELL="$WORK/orla-test-shell" dbus-run-session -- "$WORK/session.sh" > "$WORK/shell.log" 2>&1

echo
grep -o 'ORLATEST \(PASS\|FAIL\|INFO\).*' "$WORK/shell.log" | sed 's/^ORLATEST //'

FAILS=$(grep -c 'ORLATEST FAIL' "$WORK/shell.log")
# Avisos e erros cujo rastro passa pelos arquivos da Orla.
ORLA_WARNINGS=$(grep -c "extensions/$UUID/" "$WORK/shell.log")
if ! grep -q 'ORLATEST DONE' "$WORK/shell.log"; then
    echo "FAIL os testes não chegaram ao fim"
    FAILS=$((FAILS + 1))
fi
# Erros de compilação de shader (o vidro) não passam pelos arquivos da Orla.
SHADER_ERRORS=$(grep -ciE "shader.*(error|fail)|glsl.*error|failed to (compile|link)" "$WORK/shell.log")
if [ "$SHADER_ERRORS" -gt 0 ]; then
    echo "FAIL $SHADER_ERRORS erro(s) de shader no log:"
    grep -iE -A4 "shader.*(error|fail)|glsl.*error|failed to (compile|link)" "$WORK/shell.log" | head -30
    FAILS=$((FAILS + 1))
fi
if [ "$ORLA_WARNINGS" -gt 0 ]; then
    echo "FAIL $ORLA_WARNINGS linha(s) de erro/aviso da Orla no log:"
    grep -B2 "extensions/$UUID/" "$WORK/shell.log" | head -30
    FAILS=$((FAILS + 1))
fi

echo
echo "Log completo: $WORK/shell.log"
echo "Capturas:     $WORK/out/"
if [ "$FAILS" -gt 0 ]; then
    echo "==> $FAILS falha(s)"
    exit 1
fi
echo "==> Tudo passou"
