#!/usr/bin/env bash
set -euo pipefail

USAGE="usage: pr-attach-image.sh --pr N --image FILE [--alt TEXT] [--repo OWNER/NAME]"
PR="" IMAGE="" ALT="" REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="${2-}"; shift 2 ;;
    --image) IMAGE="${2-}"; shift 2 ;;
    --alt) ALT="${2-}"; shift 2 ;;
    --repo) REPO="${2-}"; shift 2 ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; echo "$USAGE" >&2; exit 2 ;;
  esac
done

[ -n "$PR" ] && [ -n "$IMAGE" ] || { echo "$USAGE" >&2; exit 2; }
[ -f "$IMAGE" ] || { echo "no such image: $IMAGE" >&2; exit 1; }
[ -n "$ALT" ] || ALT="Screenshot of the change in this PR"
ALT=$(printf '%s' "$ALT" | tr '\n\r\t]' '   )')

REPO_ARGS=()
[ -n "$REPO" ] && REPO_ARGS=(--repo "$REPO")
gh_repo() { gh "$@" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"}; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
gh_repo pr view "$PR" --json body --jq .body > "$WORK/body" \
  || { echo "could not read the body of PR #$PR" >&2; exit 1; }
printf '![%s](%s)\n\n' "$ALT" "$IMAGE" > "$WORK/new"
awk 'NR==1 && (/^[[:space:]]*<img / || /^[[:space:]]*!\[/){ skip=1; next } skip && NF==0 { skip=0; next } { skip=0; print }' \
  "$WORK/body" >> "$WORK/new"
gh_repo pr edit "$PR" --body-file "$WORK/new" --attach "$IMAGE" >/dev/null

gh_repo pr view "$PR" --json body --jq .body | head -1
echo "attached as the first line of PR #$PR"
