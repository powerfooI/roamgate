// All writes before publication belong to one fixed, exclusively created directory.
// In particular, a killed shell must not unlink storage still used by its child.
export function worktreeSnapshotCommand(
  root: string,
  quote: (value: string) => string,
) {
  return `
set -eu
umask 077
export LC_ALL=C
cd ${quote(root)}
export snapshot_root=$(pwd -P)
started=$(date +%s)
fail() { printf 'Last step snapshot refused: %s\\n' "$*" >&2; exit 1; }
# Manual publication cannot apply Git's shared-repository permissions.
# Read effective config (including inherited values) before creating storage.
shared=$(git config --get core.sharedRepository) || {
  [ "$?" -eq 1 ] || fail 'cannot read core.sharedRepository'
  shared=umask
}
case "$shared" in
  0|[fF][aA][lL][sS][eE]|umask) ;;
  *) fail 'shared repositories are not supported (core.sharedRepository)';;
esac
git_dir=$(git rev-parse --absolute-git-dir)
objects=$(git rev-parse --git-path objects)
objects=$(cd "$objects" && pwd -P)
# Nonstandard Git directories are not implicitly ignored like .git. Exclude
# their actual subtrees, including shared metadata for linked worktrees.
set -- .
for directory in "$git_dir" "$(git rev-parse --git-common-dir)"; do
  directory=$(cd "$directory" && pwd -P)
  case "$directory" in
    "$snapshot_root"/*) set -- "$@" ":(top,exclude,literal)\${directory#"$snapshot_root"/}";;
  esac
done
quarantine="$git_dir/roamgate-last-step-capture"
mkdir "$quarantine" 2>/dev/null || fail "capture locked at $quarantine; see docs/ARCHITECTURE.md"
cleanup() { rm -rf "$quarantine"; }
trap cleanup EXIT
trap 'trap - EXIT; exit 1' HUP INT TERM
printf '%s\\n' "$$" > "$quarantine/owner-pid"
# Fail closed if this shell cannot enforce the per-file disk bound.
ulimit -f 65536 || fail 'file size limits unavailable'
case "$objects$git_dir" in *'
'*) fail 'object directory contains a newline';; esac
mkdir "$quarantine/objects" "$quarantine/objects/info" "$quarantine/files" "$quarantine/sources"
printf '%s\\n' "$objects" > "$quarantine/objects/info/alternates"
index=$(git rev-parse --git-path index)
export GIT_OBJECT_DIRECTORY="$quarantine/objects"
export GIT_INDEX_FILE="$quarantine/index"
# Preserve staged gitlinks and skip-worktree metadata without writing the real index.
if [ -f "$index" ]; then
  cp "$index" "$GIT_INDEX_FILE"
elif git rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null; then
  git read-tree HEAD
else
  git read-tree --empty
fi
git ls-files --cached --others --exclude-standard -z -- "$@" > "$quarantine/paths"
git ls-files --cached --others --exclude-standard -- "$@" > "$quarantine/quoted-paths"
# Preserve sparse entries in one batch; materialized files override them below.
git ls-files -t --stage -- "$@" > "$quarantine/index-entries"
awk 'substr($0, 1, 2) == "S " { print substr($0, 3) }' "$quarantine/index-entries" > "$quarantine/sparse-entries"
git check-attr filter --stdin < "$quarantine/quoted-paths" > "$quarantine/attributes"
if grep -Ev ': filter: (unspecified|unset)$' "$quarantine/attributes" > /dev/null; then
  fail 'Git filter attributes are not supported'
fi
# Keep gitlinks without dereferencing their directories. All other symlinks,
# including symlink ancestors, are refused rather than followed.
touch "$quarantine/gitlinks"
printf '0 0\\n' > "$quarantine/budget"
export quarantine
xargs -0 sh -c '
  set -eu
  fail() { printf "Last step snapshot refused: %s\\n" "$*" >&2; exit 1; }
  read count total < "$quarantine/budget"
  for path do
    cd "$snapshot_root"
    # Untracked nested repositories are listed with a trailing slash.
    path=\${path%/}
    case "$path" in *"
"*|*"\t"*) fail "newline/tab filenames are not supported";; esac
    file="./$path"
    parent="$file"
    while :; do
      [ ! -L "$parent" ] || fail "symlink: $path"
      [ ! -d "$parent" ] || [ -x "$parent" ] || fail "unreadable directory: $path"
      case "$parent" in */*) parent=\${parent%/*};; *) break;; esac
    done
    if [ -d "$file" ]; then
      # Working repositories are gitlinks even when absent from the index.
      # Only uninitialized submodules need the indexed commit as a fallback.
      if [ -e "$file/.git" ]; then
        oid=$(git -C "$file" rev-parse --verify HEAD)
      else
        entry=$(git ls-files --stage -- ":(literal)$path")
        case "$entry" in
          "160000 "*) set -- $entry; oid=$2;;
          *) fail "non-file: $path";;
        esac
      fi
      printf "160000 %s\\t%s\\0" "$oid" "$path" >> "$quarantine/gitlinks"
      continue
    fi
    [ -e "$file" ] || continue
    [ -f "$file" ] && [ -r "$file" ] || fail "unreadable or special file: $path"
    count=$((count + 1))
    [ "$count" -le 10000 ] || fail "more than 10000 files"
    # dd reads at most 8 MiB + one byte, even if a file grows after listing.
    # The destination is a numbered regular file, never a worktree pathname.
    # Pin the containing directory as cwd as well as the final inode. A raced
    # ancestor symlink must not redirect the read outside the checkout.
    expected="$snapshot_root"
    case "$path" in */*) expected="$snapshot_root/\${path%/*}";; esac
    cd -P "$expected" || fail "directory changed: $path"
    [ "$PWD" = "$expected" ] || fail "symlink ancestor: $path"
    file="./\${path##*/}"
    ln -P "$file" "$quarantine/sources/$count" || fail "cannot pin file: $path"
    [ -f "$quarantine/sources/$count" ] && [ ! -L "$quarantine/sources/$count" ] || fail "file changed type: $path"
    report=$(dd if="$quarantine/sources/$count" of="$quarantine/files/$count" bs=8388609 count=1 2>&1) || fail "cannot read: $path"
    # GNU/BSD dd reports records in/out followed by the byte count (LC_ALL=C).
    set -- $report
    shift 6
    size=$1
    case "$size" in ""|*[!0-9]*) fail "unsupported dd byte count";; esac
    [ "$size" -le 8388608 ] || fail "file exceeds 8 MiB: $path"
    total=$((total + size))
    [ "$total" -le 33554432 ] || fail "worktree exceeds 32 MiB"
    mode=100644
    [ ! -x "$quarantine/sources/$count" ] || mode=100755
    printf "%s\\t%s\\n" "$mode" "$path" >> "$quarantine/metadata"
    printf "%s\\n" "$quarantine/files/$count" >> "$quarantine/blob-paths"
  done
  printf "%s %s\\n" "$count" "$total" > "$quarantine/budget"
' sh < "$quarantine/paths"
git read-tree --empty
git update-index --index-info < "$quarantine/sparse-entries"
git update-index -z --index-info < "$quarantine/gitlinks"
if [ -f "$quarantine/blob-paths" ]; then
  # --no-filters is essential: a racing .gitattributes/config edit cannot
  # spawn an unbounded clean filter after the attribute check.
  git -c core.bigFileThreshold=16m hash-object -w --no-filters --stdin-paths < "$quarantine/blob-paths" > "$quarantine/hashes"
  paste "$quarantine/hashes" "$quarantine/metadata" | awk -F '\t' '{ printf "%s %s\\t%s%c", $2, $1, $3, 0 }' > "$quarantine/entries"
  git update-index -z --index-info < "$quarantine/entries"
fi
tree=$(git write-tree)
# Publish blobs before trees, and child trees before parents. Interruption
# can leave unreachable complete objects, but not trees with missing children.
git ls-tree -r -t "$tree" | awk '$2 == "tree" { trees[++count]=$3 } END { for (i=count; i>0; i--) print trees[i] }' > "$quarantine/trees"
printf '%s\\n' "$tree" >> "$quarantine/trees"
# This is a host-local deadline, not a promise of remote SSH termination.
[ "$(( $(date +%s) - started ))" -lt 9 ] || fail 'capture deadline exceeded'
publish() {
  while IFS= read -r oid; do
    prefix=\${oid%\${oid#??}}
    name=\${oid#??}
    object="$quarantine/objects/$prefix/$name"
    [ -f "$object" ] || continue
    target="$objects/$prefix/$name"
    [ -d "$objects/$prefix" ] || mkdir "$objects/$prefix"
    # Non-overwriting hard links expose only the completed object inode.
    ln "$object" "$target" 2>/dev/null || [ -f "$target" ] || fail 'cannot publish object (hard links required)'
  done
}
if [ -f "$quarantine/hashes" ]; then publish < "$quarantine/hashes"; fi
publish < "$quarantine/trees"
cleanup
trap - EXIT
printf '%s\\n' "$tree"
`;
}
