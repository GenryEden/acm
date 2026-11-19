#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/GenryEden/acm/main/install.sh | sh

fail() {
    printf 'acm install: %s\n' "$*" >&2
    exit 1
}

fetch() {
    curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 -o "$2" "$1"
}

shell_quote() {
    printf "'"
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
    printf "'"
}

find_node_archive() {
    awk -v suffix="$1" 'length($2) >= length(suffix) &&
        substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }' "$work/checksums"
}

install_node() {
    case $(uname -s) in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        *) fail "The bundled runtime supports macOS and Linux. Install Node.js 22.5+ and npm to use your own runtime." ;;
    esac
    case $(uname -m) in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64) arch=x64 ;;
        *) fail "No bundled runtime for $(uname -m). Install Node.js 22.5+ and npm to use your own runtime." ;;
    esac

    target=$os-$arch
    if [ "$os" = linux ]; then
        for loader in /lib/ld-musl-*.so.1; do
            if [ -e "$loader" ]; then
                target=$target-musl
                break
            fi
        done
    fi

    printf 'Downloading Node.js 24 for %s...\n' "$target"
    base=https://nodejs.org/dist/latest-v24.x
    fetch "$base/SHASUMS256.txt" "$work/checksums"
    archive=$(find_node_archive "-$target.tar.gz")
    if [ -z "$archive" ] && [ "$target" = "$os-$arch-musl" ]; then
        # Match the official release version when it lacks a build for this musl target.
        standard_archive=$(find_node_archive "-$os-$arch.tar.gz")
        [ -n "$standard_archive" ] || fail "Could not determine the current Node.js 24 version."
        version=${standard_archive#node-}
        version=${version%-$os-$arch.tar.gz}
        base=https://unofficial-builds.nodejs.org/download/release/$version
        fetch "$base/SHASUMS256.txt" "$work/checksums"
        archive=$(find_node_archive "-$target.tar.gz")
    fi
    [ -n "$archive" ] || fail "No Node.js archive found for $os/$arch."
    fetch "$base/$archive" "$work/$archive"
    (
        cd "$work"
        awk -v archive="$archive" '$2 == archive { print }' checksums > node.sha256
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum -c node.sha256
        else
            shasum -a 256 -c node.sha256
        fi
    ) || fail "Node.js checksum verification failed."
    mkdir "$release/node"
    tar -xzf "$work/$archive" -C "$release/node" --strip-components=1
    PATH="$release/node/bin:$PATH"
    export PATH
    if ! "$release/node/bin/node" --version >/dev/null; then
        case $target in
            *-musl) fail "The downloaded Node.js could not run. On Alpine, install libstdc++ or provide Node.js 22.5+ and npm." ;;
            *) fail "The downloaded Node.js could not run on this system. Provide Node.js 22.5+ and npm." ;;
        esac
    fi
}

main() {
    set -eu
    source_url=https://github.com/GenryEden/acm/archive/refs/heads/main.tar.gz
    root=${ACM_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/acm}
    bin=${ACM_BIN_DIR:-$HOME/.local/bin}
    case $root in /*) ;; *) fail "ACM_INSTALL_DIR must be absolute." ;; esac
    case $bin in /*) ;; *) fail "ACM_BIN_DIR must be absolute." ;; esac

    mkdir -p "$root" "$bin"
    [ ! -d "$bin/acm" ] || fail "$bin/acm is a directory."
    work=
    release=
    launcher=
    trap 'if [ -n "$work" ]; then rm -rf "$work"; fi
          if [ -n "$release" ]; then rm -rf "$release"; fi
          if [ -n "$launcher" ]; then rm -f "$launcher"; fi' EXIT
    trap 'exit 1' HUP INT TERM
    work=$(mktemp -d "${TMPDIR:-/tmp}/acm-install.XXXXXXXX")
    release=$(mktemp -d "$root/acm.XXXXXXXX")

    printf 'Downloading acm...\n'
    fetch "$source_url" "$work/source.tar.gz"
    source=$work/source
    mkdir "$source"
    tar -xzf "$work/source.tar.gz" -C "$source" --strip-components=1
    [ -f "$source/package-lock.json" ] && [ -f "$source/bin/acm.mjs" ] ||
        fail "The source archive is missing required acm files."

    if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)' 2>/dev/null ||
        ! command -v npm >/dev/null 2>&1; then
        install_node
    fi
    node_bin=$(command -v node)

    printf 'Installing acm...\n'
    mkdir "$release/app"
    cp -R "$source/src" "$source/bin" "$source/package.json" "$source/package-lock.json" "$source/tsconfig.json" "$release/app/"
    (cd "$release/app" && npm ci --omit=dev --no-audit --no-fund)
    "$node_bin" "$release/app/bin/acm.mjs" --version

    launcher=$(mktemp "$bin/.acm.XXXXXXXX")
    {
        printf '#!/bin/sh\nexec '
        shell_quote "$node_bin"
        printf ' '
        shell_quote "$release/app/bin/acm.mjs"
        printf ' "$@"\n'
    } > "$launcher"
    chmod 755 "$launcher"
    mv -f "$launcher" "$bin/acm"
    launcher=
    release=

    printf '\nInstalled %s\n' "$bin/acm"
    case :$PATH: in
        *:"$bin":*) ;;
        *) printf 'To use acm in this shell, run:\n  export PATH='
           shell_quote "$bin"
           printf ':$PATH\n' ;;
    esac
    printf 'Try: acm list --all\n'
}

main
