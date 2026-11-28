#!/usr/bin/env bash
# Orla Dock
# Copyright (c) 2026 Vinícius de Souza Bispo
# Licensed under the MIT License with Attribution Requirement - see LICENSE file
# SPDX-License-Identifier: LicenseRef-MIT-Attribution
#
# check.sh — confere as regras de revisão do extensions.gnome.org (EGO)
# que dá para verificar automaticamente. Rode antes de enviar uma versão:
#
#   ./scripts/check.sh
#
# O que ele NÃO substitui: os testes (scripts/test-shell.sh e
# scripts/test-prefs.sh) e uma lida no código por uma pessoa.

set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

FAILS=0
ok() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
# Mostra as linhas encontradas e falha se houver alguma.
none() {
    local what="$1"; shift
    local found
    # Linhas de comentário não contam (ex.: "// Nada de eval()").
    found=$("$@" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)')
    if [ -n "$found" ]; then
        fail "$what"
        echo "$found" | sed 's/^/     /' | head -20
    else
        ok "$what"
    fi
}

SHELL_JS=$(git ls-files 'extension.js' 'lib/*.js')
PREFS_JS=$(git ls-files 'prefs.js' 'prefs/*.js')

# --- 1. Sintaxe de todo o JavaScript (parser do GJS, sem executar) ---
bad=""
for f in $SHELL_JS $PREFS_JS; do
    out=$(gjs -c "
const [, b] = imports.gi.GLib.file_get_contents('$f');
try { Reflect.parse(new TextDecoder().decode(b), {target: 'module'}); } catch (e) { print('$f: ' + e); }")
    [ -n "$out" ] && bad+="$out"$'\n'
done
[ -z "$bad" ] && ok "sintaxe do JavaScript" || { fail "sintaxe do JavaScript"; echo "$bad" | sed 's/^/     /'; }

# --- 2. metadata.json ---
python3 -I - <<'EOF' && ok "metadata.json" || fail "metadata.json"
import json, re, sys
m = json.load(open('metadata.json'))
errors = []
for key in ('uuid', 'name', 'description', 'shell-version', 'url'):
    if not m.get(key):
        errors.append(f'falta "{key}"')
if not re.fullmatch(r'[A-Za-z0-9._-]+@[A-Za-z0-9._-]+', m.get('uuid', '')):
    errors.append('uuid fora do formato nome@dominio')
if 'version' in m:
    errors.append('"version" é atribuído pelo EGO; use só "version-name"')
if not all(re.fullmatch(r'\d+(\.\d+)?', v) for v in m.get('shell-version', [])):
    errors.append('shell-version com valor estranho')
if m.get('settings-schema') != 'org.gnome.shell.extensions.' + m['uuid'].split('@')[0]:
    errors.append('settings-schema deve ser org.gnome.shell.extensions.<nome>')
for e in errors:
    print('     ' + e)
sys.exit(1 if errors else 0)
EOF

# --- 3. Schema: id e caminho no padrão, compila no modo estrito ---
if glib-compile-schemas --strict --dry-run schemas 2>/dev/null &&
   grep -q 'path="/org/gnome/shell/extensions/orla-dock/"' schemas/*.gschema.xml; then
    ok "schema (compila no modo estrito, caminho no padrão)"
else
    fail "schema"
fi

# --- 4. Traduções ---
if msgfmt -c -o /dev/null po/pt_BR.po 2>/dev/null; then
    ok "traduções (po/pt_BR.po)"
else
    fail "traduções (po/pt_BR.po)"
fi

# --- 5. Cada processo só usa as bibliotecas dele ---
none "o Shell não importa GTK/Gdk/Adw" grep -nE "from 'gi://(Gtk|Gdk|Adw)['?]" $SHELL_JS
none "as preferências não importam St/Clutter/Meta/Shell nem a UI do Shell" \
    grep -nE "from 'gi://(St|Clutter|Meta|Shell|Mtk)['?]|org/gnome/shell/ui" $PREFS_JS

# --- 6. Nada de API antiga ou perigosa ---
none "sem módulos antigos (Lang, Mainloop, ByteArray, imports.*)" \
    grep -nE "imports\.(lang|mainloop|byteArray|gi|misc)\b|\bLang\.|\bMainloop\.|ByteArray" $SHELL_JS $PREFS_JS
none "sem eval/run_dispose" grep -nE "\beval\(|\brun_dispose\(" $SHELL_JS $PREFS_JS

# --- 7. Nada que trave o Shell (leitura de disco/D-Bus síncronas) ---
none "sem chamadas síncronas no processo do Shell" \
    grep -nE "call_sync\(|file_get_contents\(|load_contents\(|spawn_sync\(|spawn_command_line_sync\(|\.query_info\(|enumerate_children\(|query_exists\(|new_from_file(_at_size|_at_scale)?\(|replace_contents\(" $SHELL_JS

# --- 8. Nada criado na importação dos módulos ---
none "nenhum objeto do GNOME criado no topo dos módulos" \
    grep -nE "^(const|let|var) [A-Za-z_\$]+ = new (Gio|GLib|St|Clutter|Meta|Shell|GObject)\." $SHELL_JS
none "nenhum sinal ou temporizador ligado no topo dos módulos" \
    grep -nE "^[A-Za-z_\$][A-Za-z0-9_\$.]*\.(connect|connectObject)\(|^GLib\.(timeout_add|idle_add)" $SHELL_JS

# --- 9. O pacote só leva o necessário ---
./scripts/pack.sh >/dev/null 2>&1
ZIP=$(ls dist/*.shell-extension.zip 2>/dev/null | head -1)
if [ -z "$ZIP" ]; then
    fail "pacote gerado"
else
    extra=$(unzip -Z1 "$ZIP" | grep -vE "^(metadata\.json|extension\.js|prefs\.js|stylesheet\.css|prefs\.css|LICENSE|lib/|prefs/|icons/|schemas/[^/]+\.gschema\.xml$|schemas/$|locale/)" )
    if [ -n "$extra" ]; then
        fail "pacote: arquivos que não deveriam ir"
        echo "$extra" | sed 's/^/     /'
    elif unzip -Z1 "$ZIP" | grep -q "gschemas.compiled"; then
        fail "pacote: gschemas.compiled não deve ir (o GNOME compila ao instalar)"
    else
        ok "pacote ($(du -k "$ZIP" | cut -f1) KB, só arquivos da extensão)"
    fi
fi

echo
if [ "$FAILS" -gt 0 ]; then
    echo "==> $FAILS problema(s)"
    exit 1
fi
echo "==> Tudo certo para o envio"
