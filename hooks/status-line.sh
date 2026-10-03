#!/usr/bin/env sh
set -eu

# Everything up to the final exec uses shell builtins alone: the status line is
# redrawn often, and the PATH this hook is started with can be short of more
# than node.
case $0 in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "${SCRIPT_DIR:-/}" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# Antigravity can start this hook without the user's shell profile, so a Node
# installed through a version manager may be missing from PATH. The functions
# below run only in that case.

# The bundle targets Node 18, so an older install is not a node this hook can use.
MIN_NODE_MAJOR=18

has_node() {
  [ -f "$1/node" ] && [ -x "$1/node" ]
}

# Prints $1 when it holds a node.
node_dir() {
  has_node "$1" && printf '%s\n' "$1"
}

# Prints the first line of file $1 without surrounding blanks or a CR, or
# nothing when it cannot be read.
first_line() {
  fl_line=
  if [ -f "$1" ] && [ -r "$1" ]; then
    read -r fl_line < "$1" || :
  fi
  fl_line=${fl_line%"$CR"}
  printf '%s\n' "${fl_line%"${fl_line##*[!	 ]}"}"
}

# Among the directories whose path is $1 followed by a version, prints the one
# with the highest version that has $3/node in it, as <dir>/$3. $2 limits the
# search to that version or its sub-versions ("22" matches 22.11.0, not 2.0.0
# or 220.0.0); empty means any. A leading "v" is ignored on both sides. Names
# that are not versions of at most three parts are skipped, and so are parts
# too long for shell arithmetic and versions below MIN_NODE_MAJOR. The
# comparison is numeric, so 20.10.0 beats 20.9.0, which the glob's own ordering
# gets wrong.
newest_version() {
  nv_want=${2#v}
  nv_best=
  nv_major=0
  nv_minor=0
  nv_patch=0
  for nv_dir in "$1"*; do
    nv_ver=${nv_dir#"$1"}
    nv_ver=${nv_ver#v}
    case $nv_ver in
      '' | *[!0-9.]* | .* | *. | *..* | *.*.*.* | *[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*) continue ;;
    esac
    case $nv_ver in
      "${nv_want:-$nv_ver}" | "$nv_want".*) ;;
      *) continue ;;
    esac
    nv_a=${nv_ver%%.*}
    [ "$nv_a" -ge "$MIN_NODE_MAJOR" ] || continue
    has_node "$nv_dir/$3" || continue
    nv_rest=${nv_ver#"$nv_a"}
    nv_rest=${nv_rest#.}
    nv_b=${nv_rest%%.*}
    nv_rest=${nv_rest#"$nv_b"}
    nv_rest=${nv_rest#.}
    nv_c=${nv_rest%%.*}
    nv_b=${nv_b:-0}
    nv_c=${nv_c:-0}
    if [ -z "$nv_best" ] ||
      [ "$nv_a" -gt "$nv_major" ] ||
      { [ "$nv_a" -eq "$nv_major" ] && [ "$nv_b" -gt "$nv_minor" ]; } ||
      { [ "$nv_a" -eq "$nv_major" ] && [ "$nv_b" -eq "$nv_minor" ] && [ "$nv_c" -gt "$nv_patch" ]; }; then
      nv_best=$nv_dir
      nv_major=$nv_a
      nv_minor=$nv_b
      nv_patch=$nv_c
    fi
  done
  [ -n "$nv_best" ] && printf '%s\n' "$nv_best/$3"
}

# Like newest_version, but falls back to the highest install when $2 names
# nothing that is installed.
pick_version() {
  if [ -n "$2" ]; then
    newest_version "$1" "$2" "$3" && return 0
  fi
  newest_version "$1" "" "$3"
}

# nvm keeps the default as an alias that can name another alias ("lts/*" ->
# "lts/jod" -> "v22.11.0") or only part of a version ("22"). Follow the chain a
# bounded number of steps, then match what is left against the installs.
nvm_node_dir() {
  nn_name=default
  nn_hops=0
  while [ "$nn_hops" -lt 8 ] && [ -f "$1/alias/$nn_name" ]; do
    nn_name=$(first_line "$1/alias/$nn_name")
    nn_hops=$((nn_hops + 1))
  done
  [ "$nn_hops" -gt 0 ] || nn_name=
  pick_version "$1/versions/node/" "$nn_name" bin
}

# fnm's default alias is a link to the installation itself.
fnm_node_dir() {
  node_dir "$1/aliases/default/bin" && return 0
  newest_version "$1/node-versions/" "" installation/bin
}

find_node_dir() {
  CR=$(printf '\r')
  fd_home=${HOME:-}
  fd_data=${XDG_DATA_HOME:-$fd_home/.local/share}

  # Volta puts shims on PATH, and so can mise, but a shim runs only when its
  # manager has a version configured, which cannot be told without running it.
  # Here and for mise below, use the installs behind them: any of them starts.
  newest_version "${VOLTA_HOME:-$fd_home/.volta}/tools/image/node/" "" bin && return 0

  nvm_node_dir "${NVM_DIR:-$fd_home/.nvm}" && return 0

  if [ -n "${FNM_DIR:-}" ]; then
    fnm_node_dir "$FNM_DIR" && return 0
  else
    for fd_dir in "$fd_data/fnm" "$fd_home/Library/Application Support/fnm" "$fd_home/.fnm"; do
      fnm_node_dir "$fd_dir" && return 0
    done
  fi

  newest_version "${MISE_DATA_DIR:-$fd_data/mise}/installs/node/" "" bin && return 0
  newest_version "${ASDF_DATA_DIR:-$fd_home/.asdf}/installs/nodejs/" "" bin && return 0

  fd_dir=${NODENV_ROOT:-$fd_home/.nodenv}
  pick_version "$fd_dir/versions/" "$(first_line "$fd_dir/version")" bin && return 0

  # n installs into N_PREFIX, which a profile-less start does not carry, so try
  # the two home directories it is usually pointed at as well.
  for fd_dir in "${N_PREFIX:+$N_PREFIX/bin}" "$fd_home/n/bin" "$fd_home/.n/bin" "$fd_home/.local/bin"; do
    [ -n "$fd_dir" ] && node_dir "$fd_dir" && return 0
  done

  # Lets the tests reach the not-found branch on a machine that has a node in
  # one of the fixed directories below.
  [ -z "${AGY_HUD_NO_SYSTEM_NODE:-}" ] || return 1

  # Homebrew links node into <prefix>/bin, and keeps a versioned formula such
  # as node@22 unlinked under <prefix>/opt.
  for fd_dir in "${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
    [ -n "$fd_dir" ] || continue
    node_dir "$fd_dir/bin" && return 0
    newest_version "$fd_dir/opt/node@" "" bin && return 0
  done

  for fd_dir in /usr/bin /snap/bin; do
    node_dir "$fd_dir" && return 0
  done
  return 1
}

if ! command -v node >/dev/null 2>&1; then
  if NODE_DIR=$(find_node_dir); then
    # Appended, so nothing the caller's PATH already resolves changes.
    PATH=${PATH:+$PATH:}$NODE_DIR
    export PATH
  else
    echo "agy-hud: node not found on PATH or in a known version-manager directory" >&2
    exit 127
  fi
fi

exec node "$ROOT_DIR/dist/agy-hud.js" statusline
