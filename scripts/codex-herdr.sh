# Source from an interactive shell's startup file (bash or zsh).
function codex {
  local codex_arg
  if [ "${HERDR_ENV:-}" != 1 ]; then
    command codex "$@"
    return
  fi
  # These commands explicitly manage or inspect a shared server.
  case "${1:-}" in
    agents|app-server|remote-control)
      command codex "$@"
      return
      ;;
  esac
  for codex_arg in "$@"; do
    case "$codex_arg" in
      --) break ;;
      --no-daemon|--remote|--remote=*)
        command codex "$@"
        return
        ;;
    esac
  done
  command codex --no-daemon "$@"
}
