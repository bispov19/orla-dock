#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# screenshots.sh — refaz as capturas da Orla Dock.
#
#   docs/screenshots/   em português (usadas no README)
#   store/screenshots/  em inglês (para a página do extensions.gnome.org)
#
# As cenas rodam num GNOME Shell de teste sem janela, com configurações
# temporárias (as suas não mudam), o papel de parede padrão do GNOME e
# arquivos de exemplo. As abas das preferências aparecem rapidamente na
# tela enquanto são capturadas.
#
# Uso: ./scripts/screenshots.sh

set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="orla-dock@viniciusbispo19"
WALLPAPER="file:///usr/share/backgrounds/gnome/blobs-d.svg"
cd "$PROJECT_DIR"
glib-compile-schemas schemas
mkdir -p locale/pt_BR/LC_MESSAGES
msgfmt -o locale/pt_BR/LC_MESSAGES/orla-dock.mo po/pt_BR.po

# Cenas do Shell, num idioma ($1) → pasta ($2).
shell_scenes() {
    local lang="$1" out="$2"
    local work
    work="$(mktemp -d -t orla-shots-XXXXXX)"
    mkdir -p "$work/config" "$work/data/gnome-shell/extensions" "$out"
    ln -s "$PROJECT_DIR" "$work/data/gnome-shell/extensions/$UUID"
    ln -s "$PROJECT_DIR/tests/shots/orla-shots@local" "$work/data/gnome-shell/extensions/orla-shots@local"
    cat > "$work/session.sh" <<INNER
#!/usr/bin/env bash
dconf write /org/gnome/shell/enabled-extensions "['$UUID', 'orla-shots@local']"
dconf write /org/gnome/shell/disable-user-extensions false
dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"
dconf write /org/gnome/shell/favorite-apps "['org.gnome.Nautilus.desktop', 'org.mozilla.firefox.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Calendar.desktop', 'org.gnome.Weather.desktop', 'org.gnome.Loupe.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Settings.desktop']"
dconf write /org/gnome/desktop/background/picture-uri "'$WALLPAPER'"
dconf write /org/gnome/desktop/background/picture-uri-dark "'$WALLPAPER'"
dconf write /org/gnome/desktop/interface/color-scheme "'prefer-dark'"
exec timeout 300 gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11 --force-animations
INNER
    chmod +x "$work/session.sh"
    env -u WAYLAND_DISPLAY -u DISPLAY \
        XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache" \
        LANG="$lang" LANGUAGE="${lang%%.*}" ORLA_SHOTS_OUT="$out" \
        dbus-run-session -- "$work/session.sh" > "$work/shell.log" 2>&1
    grep -o 'ORLASHOT.*' "$work/shell.log" | sed 's/^ORLASHOT /   /'
}

# Abas das preferências (escuras), num idioma ($1) → pasta ($2).
prefs_pages() {
    local lang="$1" out="$2"
    local work ext
    work="$(mktemp -d -t orla-prefs-shots-XXXXXX)"
    ext="$work/gnome-shell/extensions/$UUID"
    mkdir -p "$(dirname "$ext")"
    ln -s "$PROJECT_DIR" "$ext"
    GI_TYPELIB_PATH=/usr/lib64/gnome-shell/girepository-1.0:/usr/lib64/gnome-shell \
    LD_LIBRARY_PATH=/usr/lib64/gnome-shell GSETTINGS_BACKEND=memory \
    LANG="$lang" LANGUAGE="${lang%%.*}" ORLA_PREFS_HEIGHT=900 \
    ORLA_PREFS_SETUP='{"blur-enabled": true}' \
        timeout 120 gjs -m tests/prefs/render.js "$ext" "$work" dark > "$work/log" 2>&1
    cp "$work/dark-1.png" "$out/preferences.png"
    cp "$work/dark-4.png" "$out/glass.png"
    cp "$work/dark-7.png" "$out/about.png"
    echo "   preferências: preferences.png, glass.png, about.png"
}

echo "==> Capturas em português (docs/screenshots)"
TMP_PT="$(mktemp -d)"
shell_scenes pt_BR.UTF-8 "$TMP_PT"
prefs_pages pt_BR.UTF-8 "$TMP_PT"

echo "==> Capturas em inglês (store/screenshots)"
TMP_EN="$(mktemp -d)"
shell_scenes en_US.UTF-8 "$TMP_EN"
prefs_pages en_US.UTF-8 "$TMP_EN"

# docs/: as imagens do README.
mkdir -p docs/screenshots
for name in dock stack-fan stack-grid taskbar-start taskbar preferences glass about; do
    [ -f "$TMP_PT/$name.png" ] && cp "$TMP_PT/$name.png" "docs/screenshots/$name.png"
done

# store/: as da página do EGO (numeradas, na ordem em que aparecem).
mkdir -p store/screenshots
cp "$TMP_EN/dock.png" store/screenshots/01-dock-glass.png
cp "$TMP_EN/taskbar-start.png" store/screenshots/02-taskbar-start-menu.png
cp "$TMP_EN/stack-fan.png" store/screenshots/03-stack-fan.png
cp "$TMP_EN/glass.png" store/screenshots/04-glass-settings.png
echo "==> Pronto"
