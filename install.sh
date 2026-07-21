#!/usr/bin/env bash
# Daylight launcher — Linux installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Duckboy121/daylight-/main/install.sh | bash
#
# Downloads the latest Daylight AppImage from GitHub Releases, installs it under
# ~/.local, adds a `daylight` command and an application-menu entry. No root,
# no package manager. Re-run any time to update to the latest release.
set -euo pipefail

OWNER="Duckboy121"
REPO="daylight-"
APP="Daylight"

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/daylight"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons"
APPIMAGE="$DATA_DIR/$APP.AppImage"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
if have curl;   then DL="curl -fsSL";        DLO="curl -fL -o";
elif have wget; then DL="wget -qO-";         DLO="wget -O";
else die "need curl or wget installed"; fi

case "$(uname -m)" in
  x86_64|amd64)   ARCH="x86_64" ;;
  aarch64|arm64)  ARCH="aarch64" ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

# --- find the AppImage asset on the latest release ---------------------------
say "Looking up the latest Daylight release…"
API="https://api.github.com/repos/$OWNER/$REPO/releases/latest"
JSON="$($DL "$API")" || die "could not reach GitHub"

# All .AppImage download URLs on the release, newest asset first.
mapfile -t URLS < <(printf '%s' "$JSON" \
  | grep -o '"browser_download_url": *"[^"]*\.AppImage"' \
  | sed 's/.*"\(https[^"]*\)"/\1/')
[ "${#URLS[@]}" -gt 0 ] || die "this release has no Linux AppImage yet — check https://github.com/$OWNER/$REPO/releases"

# Prefer an arch-specific asset if one exists; else take the single/default one.
URL=""
for u in "${URLS[@]}"; do
  case "$u" in *"$ARCH"*) URL="$u"; break ;; esac
done
[ -n "$URL" ] || URL="${URLS[0]}"

VER="$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\([^"]*\)"/\1/' | head -1)"
say "Downloading $APP $VER ($ARCH)…"

# --- download + install ------------------------------------------------------
mkdir -p "$DATA_DIR" "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
TMP="$(mktemp)"
# shellcheck disable=SC2086
$DLO "$TMP" "$URL" || die "download failed"
chmod +x "$TMP"
mv -f "$TMP" "$APPIMAGE"
say "Installed to $APPIMAGE"

# `daylight` command
ln -sf "$APPIMAGE" "$BIN_DIR/daylight"

# Application-menu entry (best-effort icon extraction; needs no FUSE).
ICON_LINE="Icon=$APP"
if ( cd "$DATA_DIR" && "$APPIMAGE" --appimage-extract 'daylight.png' >/dev/null 2>&1 ) \
   && [ -f "$DATA_DIR/squashfs-root/daylight.png" ]; then
  cp -f "$DATA_DIR/squashfs-root/daylight.png" "$ICON_DIR/daylight.png"
  rm -rf "$DATA_DIR/squashfs-root"
  ICON_LINE="Icon=$ICON_DIR/daylight.png"
fi
cat > "$DESKTOP_DIR/daylight.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Daylight
Comment=Custom Minecraft launcher
Exec=$APPIMAGE
$ICON_LINE
Terminal=false
Categories=Game;
EOF
update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

# --- post-install notes ------------------------------------------------------
say "Done. Launch it with:  daylight   (or from your applications menu)"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "$BIN_DIR isn't on your PATH — add it, e.g.:"
     warn '  echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.profile && source ~/.profile' ;;
esac

# AppImages need FUSE 2 to run. Extraction above works without it, but launching
# does not — surface the fix rather than let it fail cryptically at first run.
if ! ( ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2' ); then
  warn "AppImages need FUSE 2. If 'daylight' won't start, install it:"
  warn "  Debian/Ubuntu:  sudo apt install libfuse2"
  warn "  Fedora:         sudo dnf install fuse"
  warn "  Arch:           sudo pacman -S fuse2"
  warn "…or run without FUSE:  daylight --appimage-extract-and-run"
fi
