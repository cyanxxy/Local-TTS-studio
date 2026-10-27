#!/usr/bin/env bash
# Installs Open TTS on an Apple Silicon Mac by building the latest release from
# source. GitHub Releases are source-only (see docs/releasing.md), so this is
# the one-command path for people who are not developing the app:
#
#   curl -fsSL https://raw.githubusercontent.com/cyanxxy/Local-TTS-studio/main/scripts/install-macos.sh | bash
#
# Run it again to update. Everything it builds with (source, Node, Rust if
# rustup is not already installed, build output) lives in one folder,
# $OPEN_TTS_INSTALL_HOME, so removing that folder removes the build toolchain.
# Homebrew packages and Xcode components it installs are shared system tools
# and stay.
#
# Options:
#   --check          Report what is missing; change nothing.
#   --ref REF        Build a tag or branch instead of the latest release.
#   --source DIR     Build an existing checkout in place (for developers).
#   --app-dir DIR    Install the app into DIR instead of /Applications.
#   -h, --help       Show this help.
#
# The whole script is one function called on the last line, so a download cut
# short by the network runs nothing.

set -euo pipefail

REPO_SLUG="cyanxxy/Local-TTS-studio"
REPO_URL="https://github.com/${REPO_SLUG}.git"
APP_NAME="Open TTS"
MIN_MACOS_MAJOR=26
MIN_FREE_GB=20
# Mirrors the macOS prerequisites in scripts/setup.mjs and docs/development.md.
BREW_FORMULAS=(cmake libomp openssl@3 pkg-config)

INSTALL_HOME="${OPEN_TTS_INSTALL_HOME:-$HOME/Library/Application Support/Open TTS Installer}"
TOOLCHAIN_DIR="$INSTALL_HOME/toolchain"

CHECK_ONLY=0
REF=""
SOURCE_DIR=""
LOCAL_SOURCE=0
APP_DIR=""
MISSING=()

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# In --check mode a missing piece is recorded and reported at the end;
# otherwise it is fatal unless the caller installs it.
missing() {
  if [[ $CHECK_ONLY -eq 1 ]]; then
    MISSING+=("$1")
    note "missing: $1"
  else
    die "$1"
  fi
}

usage() {
  cat <<'USAGE'
Builds and installs Open TTS on an Apple Silicon Mac (macOS 26 or newer).

Usage: install-macos.sh [--check] [--ref REF | --source DIR] [--app-dir DIR]

  --check          Report what is missing; change nothing.
  --ref REF        Build a tag or branch instead of the latest release.
  --source DIR     Build an existing checkout in place (for developers).
  --app-dir DIR    Install the app into DIR instead of /Applications.
  -h, --help       Show this help.

Set OPEN_TTS_INSTALL_HOME to keep the installer's files somewhere other than
~/Library/Application Support/Open TTS Installer.
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check) CHECK_ONLY=1 ;;
      --ref) [[ $# -ge 2 ]] || die "--ref needs a tag or branch."; REF="$2"; shift ;;
      --source) [[ $# -ge 2 ]] || die "--source needs a directory."; SOURCE_DIR="$2"; shift ;;
      --app-dir) [[ $# -ge 2 ]] || die "--app-dir needs a directory."; APP_DIR="$2"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1 (see --help)." ;;
    esac
    shift
  done
  if [[ -n $SOURCE_DIR && -n $REF ]]; then
    die "Use either --source or --ref, not both."
  fi
}

check_platform() {
  say "Checking this Mac"
  [[ $(uname -s) == Darwin ]] || die "This installer is for macOS. On Windows, see docs/development.md."
  [[ $(sysctl -n hw.optional.arm64 2>/dev/null || echo 0) == 1 ]] \
    || die "Open TTS needs an Apple Silicon Mac (M1 or newer)."
  [[ $(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0) == 0 ]] \
    || die "This shell runs under Rosetta. Open a native (arm64) Terminal and run the installer again."

  local version major
  version=$(sw_vers -productVersion)
  major=${version%%.*}
  (( major >= MIN_MACOS_MAJOR )) || die "Open TTS needs macOS ${MIN_MACOS_MAJOR} or newer; this Mac runs ${version}."
  note "macOS ${version} on Apple Silicon"

  local parent="$INSTALL_HOME"
  while [[ ! -d $parent ]]; do parent=$(dirname "$parent"); done
  local free_gb
  free_gb=$(df -g "$parent" | awk 'NR == 2 { print $4 }')
  if (( free_gb < MIN_FREE_GB )); then
    warn "Only ${free_gb} GB free. The build needs about ${MIN_FREE_GB} GB, and models need more later."
  fi
}

check_xcode() {
  say "Checking Xcode"
  local developer_dir
  developer_dir=$(xcode-select -p 2>/dev/null || true)
  if [[ $developer_dir != *.app/Contents/Developer ]]; then
    # The Command Line Tools alone cannot compile the Metal kernels. Point this
    # run at an installed Xcode instead of asking for sudo xcode-select.
    if [[ -d /Applications/Xcode.app ]]; then
      export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
      note "using /Applications/Xcode.app (xcode-select points at ${developer_dir:-nothing})"
    else
      missing "Xcode. Install it from the App Store (https://apps.apple.com/app/xcode/id497799835), open it once, then run this installer again."
      return
    fi
  fi

  if ! xcodebuild -license check >/dev/null 2>&1; then
    missing "Xcode's license has not been accepted. Run: sudo xcodebuild -license accept"
    return
  fi
  if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
    missing "Xcode has not finished its first launch. Run: sudo xcodebuild -runFirstLaunch"
    return
  fi

  if xcrun -sdk macosx metal --version >/dev/null 2>&1; then
    note "Xcode and its Metal Toolchain are ready"
  elif [[ $CHECK_ONLY -eq 1 ]]; then
    MISSING+=("Xcode's Metal Toolchain (the installer downloads it)")
    note "missing: Xcode's Metal Toolchain (the installer downloads it)"
  else
    say "Downloading Xcode's Metal Toolchain"
    xcodebuild -downloadComponent MetalToolchain
    xcrun -sdk macosx metal --version >/dev/null 2>&1 \
      || die "The Metal Toolchain is still unavailable. Install it from Xcode > Settings > Components."
  fi
}

find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    echo /opt/homebrew/bin/brew
  fi
}

# Checks for what each formula provides rather than the formula name, as
# scripts/setup.mjs does: a newer OpenSSL or pkgconf also satisfies the build.
brew_formula_needed() {
  local prefix="$1"
  case "$2" in
    cmake) ! command -v cmake >/dev/null 2>&1 ;;
    libomp) [[ ! -d $prefix/opt/libomp ]] ;;
    openssl@3) ! pkg-config --exists openssl >/dev/null 2>&1 ;;
    pkg-config) ! command -v pkg-config >/dev/null 2>&1 ;;
  esac
}

check_homebrew() {
  say "Checking Homebrew packages"
  local brew
  brew=$(find_brew)
  if [[ -z $brew ]]; then
    missing "Homebrew. Install it from https://brew.sh, then run this installer again."
    return
  fi
  eval "$("$brew" shellenv)"
  local prefix
  prefix=$("$brew" --prefix)

  local needed=() formula
  for formula in "${BREW_FORMULAS[@]}"; do
    if brew_formula_needed "$prefix" "$formula"; then needed+=("$formula"); fi
  done
  if [[ ${#needed[@]} -eq 0 ]]; then
    note "all build tools are installed"
  elif [[ $CHECK_ONLY -eq 1 ]]; then
    MISSING+=("Homebrew packages: ${needed[*]} (the installer installs them)")
    note "missing: ${needed[*]} (the installer installs them)"
  else
    say "Installing Homebrew packages: ${needed[*]}"
    "$brew" install "${needed[@]}"
  fi
}

latest_release_tag() {
  curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1
}

prepare_source() {
  if [[ -n $SOURCE_DIR ]]; then
    LOCAL_SOURCE=1
    SOURCE_DIR=$(cd "$SOURCE_DIR" && pwd)
    [[ -f $SOURCE_DIR/package.json && -f $SOURCE_DIR/scripts/setup.mjs ]] \
      || die "$SOURCE_DIR is not an Open TTS checkout."
    say "Using the checkout at $SOURCE_DIR"
    return
  fi

  if [[ -z $REF ]]; then
    REF=$(latest_release_tag)
    [[ -n $REF ]] || die "Could not look up the latest release on GitHub. Check your connection, or pass --ref."
  fi
  SOURCE_DIR="$INSTALL_HOME/source"

  if [[ $CHECK_ONLY -eq 1 ]]; then
    say "Would build ${REF} in $SOURCE_DIR"
    return
  fi

  say "Fetching Open TTS ${REF}"
  if [[ -d $SOURCE_DIR/.git ]]; then
    # This folder belongs to the installer; never reset anything else.
    local origin
    origin=$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)
    [[ $origin == "$REPO_URL" ]] \
      || die "$SOURCE_DIR is not the installer's checkout (origin: ${origin:-none}). Move it away and run again."
    git -C "$SOURCE_DIR" fetch --depth 1 --quiet origin "$REF"
    git -C "$SOURCE_DIR" checkout --quiet --force --detach FETCH_HEAD
  else
    mkdir -p "$INSTALL_HOME"
    rm -rf "$SOURCE_DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$SOURCE_DIR"
  fi
  note "at $(git -C "$SOURCE_DIR" rev-parse --short HEAD)"
}

# A private Node at the version in .nvmrc, and the npm pinned in
# package.json's packageManager, so a system Node or nvm setup is never changed.
ensure_node() {
  local node_dir="$TOOLCHAIN_DIR/node"
  if [[ $CHECK_ONLY -eq 1 ]]; then
    say "Checking Node.js"
    if [[ -x $node_dir/bin/node ]]; then note "private Node $("$node_dir/bin/node" --version) is installed"
    else note "the installer downloads its own Node.js from nodejs.org"; fi
    return
  fi

  local want
  want=$(tr -d '[:space:]' < "$SOURCE_DIR/.nvmrc")
  want=${want#v}
  if [[ ! -x $node_dir/bin/node || $("$node_dir/bin/node" --version) != "v$want" ]]; then
    say "Downloading Node.js ${want}"
    local tarball="node-v${want}-darwin-arm64.tar.xz"
    local base="https://nodejs.org/dist/v${want}"
    local tmp
    tmp=$(mktemp -d)
    curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) \
      || die "The Node.js download failed its checksum."
    mkdir -p "$TOOLCHAIN_DIR"
    tar -xJf "$tmp/$tarball" -C "$tmp"
    rm -rf "$node_dir"
    mv "$tmp/node-v${want}-darwin-arm64" "$node_dir"
    rm -rf "$tmp"
  fi
  export PATH="$node_dir/bin:$PATH"

  local want_npm
  want_npm=$(node -p 'require(process.argv[1]).packageManager.replace(/^npm@/, "")' "$SOURCE_DIR/package.json")
  if [[ $(npm --version) != "$want_npm" ]]; then
    say "Installing npm ${want_npm}"
    # Run outside the checkout so its .npmrc does not apply, and pin the prefix
    # so a user-level npm prefix cannot redirect the install.
    (cd "$TOOLCHAIN_DIR" && npm_config_prefix="$node_dir" npm install --global --no-audit --no-fund "npm@${want_npm}" >/dev/null)
  fi
  note "Node $(node --version), npm $(npm --version)"
}

# Uses an existing rustup. Without one, installs rustup into the installer's
# folder with --no-modify-path, so no shell profile is edited.
ensure_rust() {
  say "Checking Rust"
  local rustup_bin=""
  if command -v rustup >/dev/null 2>&1; then
    rustup_bin=$(command -v rustup)
  elif [[ -x $HOME/.cargo/bin/rustup ]]; then
    rustup_bin=$HOME/.cargo/bin/rustup
  elif [[ -x $TOOLCHAIN_DIR/rust/cargo/bin/rustup ]]; then
    export RUSTUP_HOME="$TOOLCHAIN_DIR/rust/rustup" CARGO_HOME="$TOOLCHAIN_DIR/rust/cargo"
    rustup_bin=$CARGO_HOME/bin/rustup
  fi

  if [[ -z $rustup_bin ]]; then
    if [[ $CHECK_ONLY -eq 1 ]]; then
      note "the installer installs its own rustup and Rust toolchain"
      return
    fi
    say "Installing rustup"
    export RUSTUP_HOME="$TOOLCHAIN_DIR/rust/rustup" CARGO_HOME="$TOOLCHAIN_DIR/rust/cargo"
    mkdir -p "$RUSTUP_HOME" "$CARGO_HOME"
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none >/dev/null
    rustup_bin=$CARGO_HOME/bin/rustup
  fi
  # rustup's proxies must win over a Homebrew Rust, which ignores the pin.
  local rustup_dir
  rustup_dir=$(dirname "$rustup_bin")
  export PATH="$rustup_dir:$PATH"

  if [[ $CHECK_ONLY -eq 1 ]]; then
    note "using $rustup_bin"
    return
  fi
  local channel
  channel=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$SOURCE_DIR/rust-toolchain.toml")
  [[ -n $channel ]] || die "Could not read the Rust version from rust-toolchain.toml."
  rustup toolchain install "$channel" --profile minimal --component clippy --component rustfmt >/dev/null
  note "Rust ${channel} via $rustup_bin"
}

app_is_running() {
  pgrep -f "/${APP_NAME}.app/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1
}

resolve_app_dir() {
  if [[ -n $APP_DIR ]]; then
    mkdir -p "$APP_DIR"
    APP_DIR=$(cd "$APP_DIR" && pwd)
  elif [[ -w /Applications ]]; then
    APP_DIR=/Applications
  else
    APP_DIR="$HOME/Applications"
    mkdir -p "$APP_DIR"
  fi
}

build_app() {
  say "Building Open TTS (the first build takes 15 to 30 minutes)"
  # Keep Rust build output with the rest of the installer's files instead of
  # the shared temporary directory scripts/rust-target-dir.mjs defaults to. A
  # developer's --source checkout keeps that default and its build cache.
  if [[ $LOCAL_SOURCE -eq 0 ]]; then
    export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$INSTALL_HOME/cargo-target}"
  fi
  (
    cd "$SOURCE_DIR"
    node scripts/setup.mjs --desktop --check
    npm ci --no-audit --no-fund
    npm run build:electron
    # --dir skips the DMG and ZIP: the installer only needs the app bundle.
    npx --no-install electron-builder --mac --arm64 --dir
  )
}

install_app() {
  local built="$SOURCE_DIR/release/mac-arm64/${APP_NAME}.app"
  [[ -d $built ]] || die "The build finished but ${built} is missing."
  app_is_running && die "Quit ${APP_NAME} and run the installer again; the new build is ready."

  local target="$APP_DIR/${APP_NAME}.app"
  say "Installing to $target"
  local staged="$APP_DIR/.${APP_NAME}.app.new" previous="$APP_DIR/.${APP_NAME}.app.old"
  rm -rf "$staged" "$previous"
  ditto "$built" "$staged"
  [[ -d $target ]] && mv "$target" "$previous"
  mv "$staged" "$target"
  rm -rf "$previous"
}

main() {
  parse_args "$@"
  if [[ $CHECK_ONLY -eq 0 ]]; then
    mkdir -p "$INSTALL_HOME"
    # Keep a log next to the build for troubleshooting.
    exec > >(tee "$INSTALL_HOME/install.log") 2>&1
  fi

  check_platform
  check_xcode
  check_homebrew
  prepare_source
  ensure_node
  ensure_rust
  resolve_app_dir

  if [[ $CHECK_ONLY -eq 1 ]]; then
    say "App folder: $APP_DIR"
    if [[ ${#MISSING[@]} -eq 0 ]]; then
      say "Ready to install. Run the installer without --check."
    else
      say "Before installing:"
      local item
      for item in "${MISSING[@]}"; do note "- $item"; done
    fi
    return
  fi

  app_is_running && die "Quit ${APP_NAME} first, then run the installer again."
  build_app
  install_app

  say "${APP_NAME} is installed: $APP_DIR/${APP_NAME}.app"
  note "Open it from Spotlight or Launchpad. Voice models download the first time you use them."
  note "To update, run the same install command again."
  note "Build files (several GB) are in: $INSTALL_HOME"
  note "Uninstall: delete the app and that folder. Your library and models are in ~/Library/Application Support/${APP_NAME}."
}

main "$@" </dev/null
