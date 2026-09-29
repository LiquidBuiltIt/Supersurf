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
# Pass --client=claude to also register SuperSurf with the claude CLI
# (`claude mcp add`). Left unset, interactive mode offers to do this once the
# extension is connected; non-interactive mode just prints the command.
#
# Re-running the script is the upgrade path.
#
# Pass --latest to run the tip of main instead of a release: the script clones
# the repo into ~/.supersurf/dev/src and installs a small shim as `supersurf` that
# sets SUPERSURF_DEV_ENVIRONMENT, so the MCP server, the daemon and the
# managed-profile extension all run the clone's code. Re-run --latest to pull.
# Re-run without it to go back to the release binary.
#
# POSIX sh on purpose. The documented command pipes into `sh`, which is dash on
# most Debian and Ubuntu systems, so nothing here may assume bash.

set -eu

REPO="LiquidBuiltIt/Supersurf"
CWS_URL="https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek"
INSTALL_DIR="${SUPERSURF_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="latest"
ASSUME_YES=0
CLIENT=""
CLIENT_EXPLICIT=0
REGISTERED=0
LATEST=0
SRC_DIR="${SUPERSURF_SRC_DIR:-$HOME/.supersurf/dev/src}"
# Overridable so --latest can be tested against a local clone before a push.
SRC_URL="${SUPERSURF_SRC_URL:-https://github.com/$REPO.git}"

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
  --client <name>    Register SuperSurf with an MCP client. Supported: claude.
  --version <ver>    Install a specific release (e.g. 3.5.0) instead of the latest.
  --latest           Run the tip of main instead of a release. Clones the repo
                     into ~/.supersurf/dev/src. Re-run --latest to update.
  --dir <path>       Install into <path> instead of ~/.local/bin.
  -h, --help         Show this message.

Environment:
  SUPERSURF_INSTALL_DIR   Same as --dir.
  SUPERSURF_SRC_DIR       Where --latest keeps its clone (default ~/.supersurf/dev/src).
  NO_COLOR                Disable colored output.
EOF
}

# ------------------------------------------------------------- arguments ----

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)     ASSUME_YES=1 ;;
    --client=*)   CLIENT="${1#--client=}"; CLIENT_EXPLICIT=1 ;;
    --client)     [ $# -ge 2 ] || die "--client needs a value, e.g. --client claude"
                  CLIENT="$2"; CLIENT_EXPLICIT=1; shift ;;
    --version)    [ $# -ge 2 ] || die "--version needs a value, e.g. --version 3.5.0"
                  VERSION="$2"; shift ;;
    --dir)        [ $# -ge 2 ] || die "--dir needs a path"
                  INSTALL_DIR="$2"; shift ;;
    --latest)     LATEST=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "Unknown option: $1. Run with --help for usage." ;;
  esac
  shift
done

# Validated once, up front, so a bad value fails before any network work
# rather than after the extension handshake. The case is the one place to
# extend when a second client (cursor, codex, ...) is supported.
case "$CLIENT" in
  ""|claude) ;;
  *) die "Unsupported --client value: '$CLIENT'. Supported values: claude" ;;
esac

if [ "$LATEST" -eq 1 ] && [ "$VERSION" != "latest" ]; then
  die "--latest and --version cannot be combined. --latest installs the tip of main."
fi

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
are Node packages it launches with npx. Install Node.js 18 or newer
(https://nodejs.org, or your package manager) and run this script again."
  fi

  node_version=$(node --version 2>/dev/null || printf 'unknown')
  node_major=$(printf '%s' "$node_version" | sed -n 's/^v\{0,1\}\([0-9]*\).*/\1/p')

  if [ -z "$node_major" ] || [ "$node_major" -lt 18 ]; then
    die "SuperSurf needs Node.js 18 or newer, found $node_version.

The MCP server and the daemon are Node packages the \`supersurf\` binary
launches with npx. Upgrade Node (https://nodejs.org, or your package
manager) and run this script again."
  fi

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

  # Report which version landed. `--version` arrived in 3.5.0, so an older
  # binary answers nothing here — that is not an install failure, since the
  # --help gate above already proved this binary runs on this machine.
  installed_version=$("$BIN" --version 2>/dev/null) || installed_version=""
  if [ -n "$installed_version" ]; then
    ok "supersurf $installed_version -> $BIN"
  else
    ok "supersurf -> $BIN"
  fi
}

# Clone (or update) main and install a shim in place of the release binary.
# The shim is what makes every component follow the clone: it exports
# SUPERSURF_DEV_ENVIRONMENT, and the CLI and daemon route to that root.
install_latest() {
  command -v git >/dev/null 2>&1 || die "--latest needs git on your PATH."
  command -v npm >/dev/null 2>&1 || die "--latest needs npm on your PATH."

  if [ -d "$SRC_DIR/.git" ]; then
    # Only ever delete a clone this script made: its origin must be SRC_URL.
    origin=$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null) || origin=""
    [ "$origin" = "$SRC_URL" ] \
      || die "$SRC_DIR is a clone of '$origin', not $SRC_URL. Move it aside, or set SUPERSURF_SRC_DIR."
    step "Updating $SRC_DIR"
    if [ -n "$(git -C "$SRC_DIR" status --porcelain)" ] || ! git -C "$SRC_DIR" pull --ff-only; then
      warn "$SRC_DIR has local changes or has diverged from main. Cloning it again."
      rm -rf "$SRC_DIR"
    fi
  elif [ -e "$SRC_DIR" ]; then
    die "$SRC_DIR exists but is not a git clone. Move it aside, or set SUPERSURF_SRC_DIR."
  fi
  if [ ! -d "$SRC_DIR" ]; then
    step "Cloning $SRC_URL into $SRC_DIR"
    git clone "$SRC_URL" "$SRC_DIR" || die "git clone failed."
  fi

  # `npm install`, not `npm ci`: package-lock.json is gitignored upstream.
  step "Installing dependencies"
  ( cd "$SRC_DIR" && npm install --no-audit --no-fund --loglevel=error ) \
    || die "npm install failed in $SRC_DIR."

  # tsx is a server devDependency; npm may or may not hoist it, so ask node.
  loader=$(cd "$SRC_DIR/server" && node -p \
    "require('path').join(require('path').dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')" \
    2>/dev/null) || loader=""
  [ -n "$loader" ] && [ -f "$loader" ] || die "tsx is missing in $SRC_DIR. Run npm install there, then re-run."

  mkdir -p "$INSTALL_DIR" || die "Could not create $INSTALL_DIR."
  [ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable. Pass --dir <path> to install elsewhere."

  # ponytail: paths are single-quoted into the shim; a clone path containing ' breaks it.
  tmp="$INSTALL_DIR/.supersurf.download.$$"
  trap 'rm -f "$tmp"' EXIT INT TERM
  cat > "$tmp" <<EOF
#!/bin/sh
# Written by the SuperSurf installer (--latest). Runs the CLI from $SRC_DIR
# and routes the MCP server, the daemon and the extension there too.
SUPERSURF_DEV_ENVIRONMENT='$SRC_DIR'
export SUPERSURF_DEV_ENVIRONMENT
exec node --import 'file://$loader' '$SRC_DIR/cli/src/supersurf.ts' "\$@"
EOF
  chmod +x "$tmp"
  mv -f "$tmp" "$INSTALL_DIR/supersurf"
  trap - EXIT INT TERM
  BIN="$INSTALL_DIR/supersurf"

  "$BIN" --help >/dev/null 2>&1 \
    || die "The shim at $BIN does not run. --latest needs Node.js 20.6+ or 18.19+ (for node --import). Found $(node --version 2>/dev/null)."
  ok "supersurf from main @ $(git -C "$SRC_DIR" rev-parse --short HEAD) -> $BIN"
}

# --latest never stops a running daemon: it may be serving live sessions. A
# daemon from another build under a dev CLI can misbehave, so say so and hand
# over the commands instead.
warn_stale_daemon() {
  pid=$(cat "$HOME/.supersurf/daemon.pid" 2>/dev/null) || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  src_real=$(cd "$SRC_DIR" && pwd -P)
  case "$(ps -o args= -p "$pid" 2>/dev/null)" in
    *"$src_real/daemon/dist/main.js"*) return 0 ;;
  esac
  say ""
  warn "A SuperSurf daemon (pid $pid) is still running, and it is not the build in $SRC_DIR."
  say  "    It runs a different version than the CLI you just installed, so things may break."
  say  "    It was left running because it may be serving live sessions."
  say  "    Restart it on main:  ${BOLD}supersurf daemon restart${RESET}"
  say  "    Or stop it:          ${BOLD}supersurf daemon stop${RESET}"
  say  "    If stop hangs:       ${BOLD}kill $pid${RESET}"
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

# --------------------------------------------------------------- clients ----

# `claude mcp add` failing must never fail the install: the binary is already
# in place, so a registration hiccup is a `warn`, never a `die`. Re-running
# the installer is the documented upgrade path, so a second `add` for a name
# that already exists is the expected idempotent case, not an error.
register_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not found on PATH; skipping registration"
    return 0
  fi

  out=$(claude mcp add --scope user supersurf -- supersurf mcp 2>&1) && rc=0 || rc=$?

  # `claude mcp add` for a name that already exists prints "already exists" and
  # exits 0 (verified against 2.1.267) — it declines rather than overwriting.
  # Matched on the message, not the exit code, so re-running the installer does
  # not report "Registered" for a call that registered nothing. Kept outside the
  # exit-code branches so a future release that reports this as an error lands
  # in the same arm.
  case "$out" in
    *[Aa]lready*) ok "supersurf is already registered with the claude CLI"
                  REGISTERED=1
                  install_claude_plugin
                  return 0 ;;
  esac

  if [ "$rc" -eq 0 ]; then
    ok "Registered supersurf with the claude CLI"
    REGISTERED=1
    install_claude_plugin
    return 0
  fi

  warn "Could not register with the claude CLI: $out"
}

# The plugin carries the SuperSurf skills. Same rules as `claude mcp add`:
# never fail the install, and a second run is the expected idempotent case.
install_claude_plugin() {
  if ! claude --help </dev/null 2>/dev/null | grep -qE '^[[:space:]]*plugin'; then
    warn "This claude CLI has no plugin support — skipping the SuperSurf skills"
    say "  To add them later, run in Claude Code:"
    say "    /plugin marketplace add LiquidBuiltIt/Supersurf"
    say "    /plugin install supersurf@supersurf"
    return 0
  fi

  out=$(claude plugin marketplace add LiquidBuiltIt/Supersurf </dev/null 2>&1) || case "$out" in
    *[Aa]lready*) ;;
    *) warn "Could not add the SuperSurf plugin marketplace: $out"; return 0 ;;
  esac

  out=$(claude plugin install supersurf@supersurf </dev/null 2>&1) && rc=0 || rc=$?
  case "$out" in
    *[Aa]lready*) ok "SuperSurf plugin is already installed" ;;
    *) if [ "$rc" -eq 0 ]; then ok "Installed the SuperSurf plugin (skills)"
       else warn "Could not install the SuperSurf plugin: $out"; return 0; fi ;;
  esac

  if [ -d "$HOME/.claude/skills/supersurf" ]; then
    warn "A hand-copied skill exists at ~/.claude/skills/supersurf — remove it; the plugin now provides the skill"
  fi
}

# One-line change to add a second client later: a new case arm here.
register_client() {
  step "Registering with your MCP client"
  case "$CLIENT" in
    claude) register_claude ;;
  esac
}

# ------------------------------------------------------------------ main ----

DOWNLOADER=$(detect_downloader)

say ""
say "${BOLD}SuperSurf installer${RESET}"
say ""

preflight_node
if [ "$LATEST" -eq 1 ]; then install_latest; else install_binary; fi
ensure_on_path

# Interactive is the default. `--yes` opts out, and so does the absence of a
# controlling terminal: piping into `sh` makes stdin the script itself, so a
# bare `read` would eat the script's own remaining lines. Everything that
# prompts talks to /dev/tty directly instead.
if [ "$ASSUME_YES" -eq 1 ] || ! { [ -r /dev/tty ] && [ -c /dev/tty ]; }; then
  print_extension_step
  say ""
  [ -n "$CLIENT" ] && register_client
  # Printed whenever registration did not happen — including when it was
  # attempted and failed, so a warn is never the last word on what to do next.
  if [ "$REGISTERED" -eq 0 ]; then
    say "Point your MCP client at SuperSurf:"
    say "  ${BOLD}claude mcp add supersurf -- supersurf mcp${RESET}"
  fi
  if [ "$LATEST" -eq 1 ]; then warn_stale_daemon; fi
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

if [ "$CLIENT_EXPLICIT" -eq 1 ]; then
  say ""
  register_client
elif command -v claude >/dev/null 2>&1; then
  say ""
  step "Register with your MCP client"
  printf '  Found the claude CLI. Register SuperSurf now? [Y/n] '
  read -r answer < /dev/tty || answer=""
  case "$answer" in
    ''|[Yy]*) CLIENT=claude; register_client ;;
  esac
fi

say ""
if [ "$REGISTERED" -eq 1 ]; then
  say "${BOLD}Done.${RESET} SuperSurf is registered and ready."
else
  say "${BOLD}Done.${RESET} Point your MCP client at SuperSurf:"
  say "  ${BOLD}claude mcp add supersurf -- supersurf mcp${RESET}"
fi
if [ "$LATEST" -eq 1 ]; then warn_stale_daemon; fi
say ""
