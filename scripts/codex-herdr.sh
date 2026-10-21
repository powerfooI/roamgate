# Source from an interactive shell's startup file (bash or zsh).
function _roamgate_codex {
  # An existing alias can use `command codex` or a specific executable path.
  if [ "${1:-}" = command ]; then shift; fi
  local codex_executable="$1"
  shift
  local codex_arg codex_value=0 codex_root=1
  if [ "${HERDR_ENV:-}" != 1 ]; then
    command "$codex_executable" "$@"
    return
  fi
  for codex_arg in "$@"; do
    if [ "$codex_value" = 1 ]; then
      codex_value=0
      continue
    fi
    case "$codex_arg" in
      --) break ;;
      --no-daemon|--remote|--remote=*)
        command "$codex_executable" "$@"
        return
        ;;
      -c|--config|--enable|--disable|-i|--image|-m|--model|--local-provider|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval|--remote-auth-token-env)
        codex_value=1
        ;;
      -*) ;;
      *)
        if [ "$codex_root" = 1 ]; then
          case "$codex_arg" in
            agents|app-server|remote-control)
              command "$codex_executable" "$@"
              return
              ;;
          esac
        fi
        codex_root=0
        ;;
    esac
  done
  command "$codex_executable" --no-daemon "$@"
}

function codex { _roamgate_codex codex "$@"; }

if _roamgate_codex_alias=$(alias codex 2>/dev/null); then
  # `alias` emits shell-quoted text; decode it without splitting its arguments.
  eval "_roamgate_codex_alias=${_roamgate_codex_alias#*=}"
  case "$_roamgate_codex_alias" in
    '_roamgate_codex '*) ;;
    *) alias codex="_roamgate_codex $_roamgate_codex_alias" ;;
  esac
fi
unset _roamgate_codex_alias
