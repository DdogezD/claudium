#!/usr/bin/env bash
set -euo pipefail

# claudium dev installer — builds from the dev branch, installs as claudium
# Usage: curl -fsSL https://raw.githubusercontent.com/DdogezD/claudium/main/install_dev.sh | bash

# Override these two before sourcing the shared install logic
BRANCH="dev"
BUILD_DIR="$HOME/.cache/claudium-dev"

# Everything below is the same as install.sh, only using $BRANCH / $BUILD_DIR.
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
ORANGE='\033[38;5;208m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO="https://github.com/DdogezD/claudium.git"
INSTALL_DIR="$HOME/.local/bin"
BUN_MIN_VERSION="1.3.11"

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*"; exit 1; }

header() {
  echo ""
  printf "${BOLD}${ORANGE}"
  cat << 'ART'

_________   .__                         .___ .__
\_   ___ \  |  |   _____     __ __    __| _/ |__|  __ __    _____
/    \  \/  |  |   \__  \   |  |  \  / __ |  |  | |  |  \  /     \
\     \____ |  |__  / __ \_ |  |  / / /_/ |  |  | |  |  / |  Y Y  \
 \______  / |____/ (____  / |____/  \____ |  |__| |____/  |__|_|  /
        \/              \/               \/                     \/

ART
  printf "${RESET}"
  echo ""
  printf "  ${YELLOW}DEV BRANCH INSTALLER${RESET}\n"
  printf "  ${DIM}Installs from the ${BOLD}dev${RESET}${DIM} branch.${RESET}\n"
  echo ""
}

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

check_os() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      fail "Unsupported OS: $(uname -s). macOS or Linux required." ;;
  esac
  ok "OS: $(uname -s) $(uname -m)"
}

check_git() {
  if ! command -v git &>/dev/null; then
    fail "git is not installed. Install it first:
    macOS:  xcode-select --install
    Linux:  sudo apt install git  (or your distro's equivalent)"
  fi
  ok "git: $(git --version | head -1)"
}

check_rg() {
  if ! command -v rg &>/dev/null; then
    warn "ripgrep (rg) not found — install it for best results:
    macOS:  brew install ripgrep
    Linux:  sudo apt install ripgrep"
  else
    ok "rg: $(rg --version | head -1)"
  fi
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  local newer
  newer="$(printf '%s\n' "$1" "$2" | sort -V | tail -1)"
  [ "$newer" = "$1" ]
}

check_bun() {
  if command -v bun &>/dev/null; then
    local ver
    ver="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$ver" "$BUN_MIN_VERSION"; then
      ok "bun: v${ver}"
      return
    fi
    warn "bun v${ver} found but v${BUN_MIN_VERSION}+ required. Upgrading..."
  else
    info "bun not found. Installing..."
  fi
  install_bun
}

install_bun() {
  curl -fsSL https://bun.sh/install | bash
  # Source the updated profile so bun is on PATH for this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "bun installation succeeded but binary not found on PATH.
    Add this to your shell profile and restart:
      export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi
  ok "bun: v$(bun --version) (just installed)"
}

# -------------------------------------------------------------------
# Clone & build
# -------------------------------------------------------------------

clone_repo() {
  if [ -d "$BUILD_DIR" ]; then
    warn "$BUILD_DIR already exists"
    if [ -d "$BUILD_DIR/.git" ]; then
      info "Pulling latest changes from $BRANCH..."
      git -C "$BUILD_DIR" fetch origin "$BRANCH" 2>/dev/null
      git -C "$BUILD_DIR" checkout "$BRANCH" 2>/dev/null || true
      git -C "$BUILD_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null || {
        warn "Pull failed, continuing with existing copy"
      }
    fi
  else
    info "Cloning repository ($BRANCH branch) to cache..."
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$BUILD_DIR"
  fi
  ok "Source cache: $BUILD_DIR ($BRANCH branch)"
}

install_deps() {
  info "Installing dependencies..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun install --frozen-lockfile 2>/dev/null || bun install
  ok "Dependencies installed"
}

build_binary() {
  info "Building claudium..."
  cd "$BUILD_DIR" || fail "Cannot enter $BUILD_DIR"
  bun run build:dev:claudium
  local binary="$BUILD_DIR/claudium-cli-dev"
  ok "Binary built: $binary"
}

install_bypass_launcher() {
  local launcher="$INSTALL_DIR/claudium-bypass"

  cat > "$launcher" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export IS_SANDBOX=1
exec "$SCRIPT_DIR/claudium" --permission-mode bypassPermissions "$@"
EOF

  chmod +x "$launcher"
  ok "Installed: $launcher"
}

install_binary() {
  mkdir -p "$INSTALL_DIR"

  cp "$BUILD_DIR/claudium-cli-dev" "$INSTALL_DIR/claudium"
  chmod +x "$INSTALL_DIR/claudium"
  ok "Installed: $INSTALL_DIR/claudium"

  install_bypass_launcher

  rm -rf "$BUILD_DIR"
  ok "Build cache cleaned"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    warn "$INSTALL_DIR is not on your PATH"
    echo ""
    printf "${YELLOW}  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):${RESET}\n"
    printf "${BOLD}    export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    echo ""
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

header
info "Starting dev installation..."
echo ""

check_os
check_git
check_bun
check_rg
echo ""

clone_repo
install_deps
build_binary
install_binary

echo ""
printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
echo ""
printf "  ${BOLD}Run it:${RESET}\n"
printf "    ${CYAN}claudium${RESET}                           # interactive REPL\n"
printf "    ${CYAN}claudium-bypass${RESET}                    # interactive REPL with bypassPermissions\n"
printf "    ${CYAN}claudium -p \"your prompt\"${RESET}          # one-shot mode\n"
echo ""
printf "  ${BOLD}Set your API key:${RESET}\n"
printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
echo ""
printf "  ${BOLD}Also support OpenAI Chat Completions APIs:${RESET}\n"
printf "    ${CYAN}export CLAUDE_CODE_USE_OPENAI=1${RESET}\n"
printf "    ${CYAN}export OPENAI_BASE_URL=http://.../v1${RESET}\n"
echo ""
printf "  ${BOLD}See README.md for full configs.${RESET}\n"
echo ""
