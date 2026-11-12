#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# nested.sh — abre uma sessão GNOME Shell "aninhada" (dentro de uma janela).
#
# Por que isso é importante: se a extensão tiver um erro grave, quem cai é
# só essa janela, não a sua sessão de verdade. E como estamos no Wayland,
# não dá para "reiniciar o Shell" (Alt+F2 → r) como no X11 — a sessão
# aninhada é o jeito de testar mudanças sem fazer logout.
#
# Desde o GNOME 49 o antigo "--nested" foi substituído por "--devkit",
# que usa o programa mutter-devkit (pacote "mutter-devkit").
#
# - dbus-run-session: cria um barramento D-Bus próprio para a sessão de
#   teste, para ela não brigar com o Shell principal por nomes no D-Bus.
# - SHELL_DEBUG=backtrace-warnings: imprime a pilha de chamadas junto com
#   os avisos de JavaScript — muito útil para achar a linha do erro.
#
# Os logs (console.log, erros) aparecem NESTE terminal.

set -euo pipefail

export SHELL_DEBUG="${SHELL_DEBUG:-backtrace-warnings}"

exec dbus-run-session -- gnome-shell --devkit --wayland "$@"
