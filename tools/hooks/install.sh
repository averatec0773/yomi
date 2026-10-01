#!/bin/sh
# pnpm hooks:install. Installs the private-path guard as git pre-commit and pre-push hooks.
#
# Each installed hook is a small wrapper that runs tools/hooks/<name> from the checkout, then the hook that was
# there before. An existing hook is never overwritten: it is renamed to <name>.local (content unchanged) and the
# wrapper runs it after the guard. Running this again is a no-op.
set -eu

MARKER="# yomi-private-guard"
root=$(git rev-parse --show-toplevel)
custom=$(git config --get core.hooksPath || true)
if [ -n "$custom" ]; then
  case "$custom" in /*) hooks_dir=$custom ;; *) hooks_dir="$root/$custom" ;; esac
else
  hooks_dir=$(git rev-parse --git-common-dir)/hooks
  case "$hooks_dir" in /*) ;; *) hooks_dir="$root/$hooks_dir" ;; esac
fi
mkdir -p "$hooks_dir"

write_wrapper() {
  name=$1
  target="$hooks_dir/$name"
  if [ "$name" = "pre-push" ]; then
    run='tmp=$(mktemp)
trap '\''rm -f "$tmp"'\'' EXIT
cat > "$tmp"
if [ -f "$root/tools/hooks/pre-push" ]; then
  sh "$root/tools/hooks/pre-push" "$@" < "$tmp" || exit $?
else
  echo "yomi guard: tools/hooks/pre-push not found in this checkout, skipped." >&2
fi
if [ -x "$0.local" ]; then "$0.local" "$@" < "$tmp"; exit $?; fi'
  else
    run='if [ -f "$root/tools/hooks/'"$name"'" ]; then
  sh "$root/tools/hooks/'"$name"'" "$@" || exit $?
else
  echo "yomi guard: tools/hooks/'"$name"' not found in this checkout, skipped." >&2
fi
if [ -x "$0.local" ]; then exec "$0.local" "$@"; fi'
  fi
  {
    echo "#!/bin/sh"
    echo "$MARKER (installed by pnpm hooks:install; your previous hook, if any, is $name.local)"
    echo 'root=$(git rev-parse --show-toplevel) || exit 1'
    echo "$run"
  } > "$target"
  chmod +x "$target"
}

for name in pre-commit pre-push; do
  target="$hooks_dir/$name"
  if [ -f "$target" ] && grep -q "$MARKER" "$target"; then
    echo "$name: already installed ($target)."
    continue
  fi
  if [ -e "$target" ]; then
    if [ -e "$target.local" ]; then
      echo "$name: an existing hook is at $target and $target.local is taken too; left both untouched." >&2
      echo "  Merge them by hand, then run pnpm hooks:install again." >&2
      exit 1
    fi
    mv "$target" "$target.local"
    write_wrapper "$name"
    echo "$name: installed. Your existing hook was kept as $name.local and still runs after the guard."
  else
    write_wrapper "$name"
    echo "$name: installed at $target."
  fi
done
