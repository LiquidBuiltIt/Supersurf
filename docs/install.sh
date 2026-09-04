#!/bin/sh
#
# SuperSurf installer.
#
#   curl -fsSL https://liquidbuiltit.github.io/Supersurf/install.sh | sh
#
# One script, two modes. Interactive is the default: it installs the binary,
# starts the daemon, opens the Chrome Web Store listing and waits until the
# extension actually connects. Pass --yes, or run it anywhere without a
# controlling terminal (CI, Docker, an agent), and it installs the binary and
# prints the extension URL without prompting.
#
# Re-running the script is the upgrade path.
#
# POSIX sh on purpose. The documented command pipes into `sh`, which is dash on
# most Debian and Ubuntu systems, so nothing here may assume bash.

set -eu

REPO="LiquidBuiltIt/Supersurf"
CWS_URL="https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek"
INSTALL_DIR="${SUPERSURF_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="latest"
ASSUME_YES=0

# How long interactive mode waits for the extension to connect. Installing from
# the Web Store is a multi-step human action; a short timeout would fire while
# the user is still reading the listing.
HANDSHAKE_TIMEOUT=180

# ---------------------------------------------------------------- output ----

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RESET=$(printf '\033[0m')
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n%sError:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
SuperSurf installer

Usage:
  curl -fsSL https://liquidbuiltit.github.io/Supersurf/install.sh | sh
  curl -fsSL https://liquidbuiltit.github.io/Supersurf/install.sh | sh -s -- --yes

Options:
  --yes              Never prompt. Install the binary, print the extension URL, exit.
  --version <ver>    Install a specific release (e.g. 3.5.0) instead of the latest.
  --dir <path>       Install into <path> instead of ~/.local/bin.
  -h, --help         Show this message.

Environment:
  SUPERSURF_INSTALL_DIR   Same as --dir.
  NO_COLOR                Disable colored output.
EOF
}

# ------------------------------------------------------------- arguments ----

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)   ASSUME_YES=1 ;;
    --version)  [ $# -ge 2 ] || die "--version needs a value, e.g. --version 3.5.0"
                VERSION="$2"; shift ;;
    --dir)      [ $# -ge 2 ] || die "--dir needs a path"
                INSTALL_DIR="$2"; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "Unknown option: $1. Run with --help for usage." ;;
  esac
  shift
done

# ------------------------------------------------------------- platform ----

detect_asset() {
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Linux)  os_part="linux" ;;
    Darwin) os_part="darwin" ;;
    *)      die "SuperSurf supports macOS and Linux only. This machine reports '$os'." ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch_part="x64" ;;
    aarch64|arm64) arch_part="arm64" ;;
    *)             die "No SuperSurf binary is built for '$arch'. Supported: x86_64, arm64." ;;
  esac

  printf 'supersurf-%s-%s' "$os_part" "$arch_part"
}

# Download tool. curl first, because the documented command already proves the
# user has it; wget covers the minimal images that ship only wget.
detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    printf 'curl'
  elif command -v wget >/dev/null 2>&1; then
    printf 'wget'
  else
    die "Neither curl nor wget is installed. Install one and re-run."
  fi
}

fetch() {
  # fetch <url> <destination>
  case "$DOWNLOADER" in
    curl) curl -fsSL --retry 3 -o "$2" "$1" ;;
    wget) wget -q -t 3 -O "$2" "$1" ;;
  esac
}

# --------------------------------------------------------------- checks ----

# SuperSurf's MCP server and daemon are Node programs the binary shells out to.
# A binary installed next to a missing Node fails on the user's first
# `supersurf mcp`, with an error that names npx rather than this omission.
preflight_node() {
  step "Checking prerequisites"

  missing=""
  command -v node >/dev/null 2>&1 || missing="node"
  command -v npx  >/dev/null 2>&1 || missing="${missing:+$missing and }npx"

  if [ -n "$missing" ]; then
    die "SuperSurf needs $missing on your PATH.

The \`supersurf\` binary is self-contained, but the MCP server and the daemon
are Node packages it launches with npx. Install Node.js 20 or newer
(https://nodejs.org, or your package manager) and run this script again."
  fi

  node_version=$(node --version 2>/dev/null || printf 'unknown')
  ok "node $node_version"

  if ! command -v chromium >/dev/null 2>&1 \
    && ! command -v chromium-browser >/dev/null 2>&1 \
    && ! command -v google-chrome >/dev/null 2>&1 \
    && ! command -v google-chrome-stable >/dev/null 2>&1 \
    && [ ! -d "/Applications/Google Chrome.app" ]; then
    # Not fatal: the user may install Chrome after SuperSurf, and managed
    # profiles are the only feature that needs a binary this script can find.
    warn "No Chrome or Chromium found. SuperSurf needs one to drive a browser."
  fi
}

# --------------------------------------------------------------- install ----

install_binary() {
  asset=$(detect_asset)

  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/$REPO/releases/latest/download/$asset"
  else
    url="https://github.com/$REPO/releases/download/v${VERSION#v}/$asset"
  fi

  step "Downloading supersurf ($asset, $VERSION)"
  say "  $DIM$url$RESET"

  mkdir -p "$INSTALL_DIR" || die "Could not create $INSTALL_DIR."
  [ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable. Pass --dir <path> to install elsewhere."

  # Download beside the final path, not into /tmp: the rename that publishes the
  # new binary must stay on one filesystem, so an interrupted download can never
  # leave a half-written `supersurf` in place of a working one.
  tmp="$INSTALL_DIR/.supersurf.download.$$"
  trap 'rm -f "$tmp"' EXIT INT TERM

  if ! fetch "$url" "$tmp"; then
    rm -f "$tmp"
    if [ "$VERSION" = "latest" ]; then
      die "Download failed. GitHub may have no published release yet, or the network refused the request.
Check https://github.com/$REPO/releases and try again."
    fi
    die "Download failed. Is v${VERSION#v} a published release?
Check https://github.com/$REPO/releases/tag/v${VERSION#v}"
  fi

  # A 404 page or an HTML redirect is a successful HTTP response to some
  # downloaders. The binary is ~95 MB, so anything tiny is not one.
  size=$(wc -c < "$tmp" | tr -d ' ')
  if [ "$size" -lt 1000000 ]; then
    rm -f "$tmp"
    die "The download is only $size bytes, which is not a SuperSurf binary.
The release asset '$asset' is probably missing. Check https://github.com/$REPO/releases"
  fi

  chmod +x "$tmp"
  mv -f "$tmp" "$INSTALL_DIR/supersurf"
  trap - EXIT INT TERM

  BIN="$INSTALL_DIR/supersurf"

  # Prove the binary runs here. A bare invocation prints usage and exits 0, so
  # a non-zero exit means the download is the wrong architecture or truncated —
  # worth catching now, not on the user's first real command.
  if ! "$BIN" --help >/dev/null 2>&1; then
    die "supersurf installed to $BIN, but it does not run on this machine.
That usually means the wrong architecture was downloaded. Please report it at
https://github.com/$REPO/issues with the output of: uname -sm"
  fi

  ok "supersurf -> $BIN"
}

# ------------------------------------------------------------------ PATH ----

# Only touch a shell profile when the install directory is genuinely absent from
# PATH. Appending unconditionally accumulates a duplicate line on every re-run,
# and re-running is the documented upgrade path.
ensure_on_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      ok "$INSTALL_DIR is already on your PATH"
      return 0 ;;
  esac

  case "${SHELL:-}" in
    */zsh)  profile="$HOME/.zshrc" ;;
    */bash) if [ -f "$HOME/.bashrc" ]; then profile="$HOME/.bashrc"; else profile="$HOME/.bash_profile"; fi ;;
    */fish) profile="" ;;
    *)      profile="$HOME/.profile" ;;
  esac

  if [ -z "$profile" ]; then
    warn "$INSTALL_DIR is not on your PATH."
    say  "  fish does not read POSIX profiles. Run:"
    say  "    ${BOLD}fish_add_path $INSTALL_DIR${RESET}"
    return 0
  fi

  line="export PATH=\"$INSTALL_DIR:\$PATH\""
  if [ -f "$profile" ] && grep -Fqs "$INSTALL_DIR" "$profile"; then
    warn "$profile already references $INSTALL_DIR, but it is not on this shell's PATH."
    say  "  Open a new terminal, or run: ${BOLD}. $profile${RESET}"
    return 0
  fi

  printf '\n# Added by the SuperSurf installer\n%s\n' "$line" >> "$profile"
  ok "Added $INSTALL_DIR to your PATH in $profile"
  warn "Open a new terminal, or run ${BOLD}. $profile${RESET}, before using \`supersurf\`."
}

# ------------------------------------------------------------- extension ----

print_extension_step() {
  say ""
  step "One manual step is left: the Chrome extension"
  say "  Install it from the Chrome Web Store:"
  say "  ${BOLD}$CWS_URL${RESET}"
  say ""
  say "  ${DIM}The installer cannot do this for you — a Web Store install needs a"
  say "  human click, and an extension cannot be sideloaded into a running"
  say "  profile. Managed profiles (\`supersurf profiles create\`) do not need it:"
  say "  the daemon sideloads the extension into those itself.$RESET"
}

# Try the OS-native opener, but never depend on it. xdg-open exits 0 on SSH
# sessions, WSL, headless boxes and minimal distros without xdg-utils while
# opening nothing at all, so the URL is printed either way.
open_url() {
  case "$(uname -s)" in
    Darwin)
      command -v open >/dev/null 2>&1 && open "$1" >/dev/null 2>&1 && return 0 ;;
    Linux)
      if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 && return 0
      fi ;;
  esac
  return 1
}

# Matches the daemon's non-verbose status line, `  Extension:   connected`.
# The trailing anchor is load-bearing: an unanchored `connected` also matches
# `disconnected`, which would report success against a daemon nothing is
# attached to. This is a string coupling to daemon/src/main.ts printStatus().
extension_connected() {
  "$BIN" daemon status 2>/dev/null | grep -q 'Extension:[[:space:]]*connected$'
}

# Wait for the extension's WebSocket handshake rather than asking the user to
# confirm they installed it. A press-Enter-when-done prompt reports a success it
# never verified: the user can press Enter having installed nothing.
wait_for_extension() {
  step "Waiting for the extension to connect"
  say  "  ${DIM}Press Enter to skip this check.$RESET"

  skip_marker=$(mktemp)
  # POSIX `read` has no timeout, so the reader waits in the background and
  # reports through a file the polling loop can test without blocking.
  ( read -r _ < /dev/tty 2>/dev/null; printf 'skip' > "$skip_marker" ) &
  reader_pid=$!

  waited=0
  connected=0
  while [ "$waited" -lt "$HANDSHAKE_TIMEOUT" ]; do
    if extension_connected; then connected=1; break; fi
    if [ -s "$skip_marker" ]; then break; fi
    sleep 2
    waited=$((waited + 2))
  done

  kill "$reader_pid" 2>/dev/null || true
  wait "$reader_pid" 2>/dev/null || true
  rm -f "$skip_marker"

  if [ "$connected" -eq 1 ]; then
    ok "Extension connected. SuperSurf is ready."
    return 0
  fi

  say ""
  warn "The extension has not connected yet."
  say  "  This is not an install failure — finish the Web Store step, then check:"
  say  "    ${BOLD}supersurf daemon status${RESET}"
}

# ------------------------------------------------------------------ main ----

DOWNLOADER=$(detect_downloader)

say ""
say "${BOLD}SuperSurf installer${RESET}"
say ""

preflight_node
install_binary
ensure_on_path

# Interactive is the default. `--yes` opts out, and so does the absence of a
# controlling terminal: piping into `sh` makes stdin the script itself, so a
# bare `read` would eat the script's own remaining lines. Everything that
# prompts talks to /dev/tty directly instead.
if [ "$ASSUME_YES" -eq 1 ] || ! { [ -r /dev/tty ] && [ -c /dev/tty ]; }; then
  print_extension_step
  say ""
  say "Point your MCP client at SuperSurf:"
  say "  ${BOLD}claude mcp add supersurf -- supersurf mcp${RESET}"
  say ""
  exit 0
fi

say ""
step "Starting the daemon"
if "$BIN" daemon start >/dev/null 2>&1; then
  ok "Daemon running on port 5555"
else
  warn "Could not start the daemon. Run ${BOLD}supersurf daemon status${RESET} to see why."
fi

print_extension_step
if open_url "$CWS_URL"; then
  ok "Opened the listing in your browser"
else
  warn "Could not open a browser here. Open the URL above yourself."
fi

say ""
wait_for_extension

say ""
say "${BOLD}Done.${RESET} Point your MCP client at SuperSurf:"
say "  ${BOLD}claude mcp add supersurf -- supersurf mcp${RESET}"
say ""
