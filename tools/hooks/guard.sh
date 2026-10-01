#!/bin/sh
# Private-path guard for yomi. Keeps personal data, local notes and secrets out of git.
#
#   sh tools/hooks/guard.sh staged            # paths and contents staged for the next commit (pre-commit)
#   sh tools/hooks/guard.sh commits <rev-list args>   # every commit in a range, e.g. origin/main..HEAD (pre-push)
#   sh tools/hooks/guard.sh tracked           # every tracked path at HEAD (CI)
#
# A path is rejected when it matches the private list below. When data/private-denylist.txt exists locally
# (one literal string per line, blank lines and lines starting with # ignored), file contents are also checked
# against it. Only file names are printed, never the matching text.
set -u

PRIVATE_RE='^(data|docs|conventions|memory|loop|changelog|scripts|\.claude|\.codex)/|(^|/)(CLAUDE|AGENTS)\.md$|^(ROADMAP|CHANGELOG)\.md$|^Makefile$|(^|/)\.env($|\.)|\.(db|db-journal|db-wal|db-shm|sqlite|sqlite3|eml|key|pem|p12|pfx)$|(^|/)(id_rsa|id_ed25519)$'
ALLOWED_RE='(^|/)\.env\.example$'

root=$(git rev-parse --show-toplevel) || exit 2
denylist_src="$root/data/private-denylist.txt"
patterns=""
cleanup() { [ -n "$patterns" ] && rm -f "$patterns"; }
trap cleanup EXIT INT TERM
if [ -f "$denylist_src" ]; then
  patterns=$(mktemp)
  grep -v -e '^[[:space:]]*$' -e '^#' "$denylist_src" > "$patterns" || true
  [ -s "$patterns" ] || { rm -f "$patterns"; patterns=""; }
fi

failed=0

# Reads paths (one per line) on stdin, prints the private ones.
private_paths() {
  grep -E "$PRIVATE_RE" | grep -vE "$ALLOWED_RE" || true
}

report_paths() {
  if [ -n "$1" ]; then
    echo "yomi guard: $2" >&2
    printf '%s\n' "$1" | sed 's/^/  /' >&2
    failed=1
  fi
}

case "${1:-}" in
  staged)
    paths=$(git diff --cached --name-only --diff-filter=ACMR)
    report_paths "$(printf '%s\n' "$paths" | private_paths)" "these staged paths are private and must not be committed (unstage with git restore --staged <path>):"
    if [ -n "$patterns" ] && [ -n "$paths" ]; then
      hits=$(printf '%s\n' "$paths" | tr '\n' '\0' | xargs -0 git grep --cached -l -I -F -f "$patterns" -- 2>/dev/null || true)
      report_paths "$hits" "these staged files contain text listed in data/private-denylist.txt:"
    fi
    ;;
  commits)
    shift
    for c in $(git rev-list "$@"); do
      paths=$(git diff-tree --no-commit-id --name-only -r --root --diff-filter=ACMR "$c")
      report_paths "$(printf '%s\n' "$paths" | private_paths)" "commit $(git rev-parse --short "$c") adds private paths:"
      if [ -n "$patterns" ] && [ -n "$paths" ]; then
        hits=$(printf '%s\n' "$paths" | tr '\n' '\0' | xargs -0 git grep -l -I -F -f "$patterns" "$c" -- 2>/dev/null | sed "s/^$c://" || true)
        report_paths "$hits" "commit $(git rev-parse --short "$c") has files containing text listed in data/private-denylist.txt:"
      fi
    done
    ;;
  tracked)
    report_paths "$(git ls-files | private_paths)" "these tracked paths are private and must be removed from git (git rm --cached <path>):"
    if [ -n "$patterns" ]; then
      hits=$(git grep -l -I -F -f "$patterns" 2>/dev/null || true)
      report_paths "$hits" "these tracked files contain text listed in data/private-denylist.txt:"
    fi
    ;;
  *)
    echo "usage: sh tools/hooks/guard.sh staged | commits <rev-list args> | tracked" >&2
    exit 2
    ;;
esac

exit $failed
