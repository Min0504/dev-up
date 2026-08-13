const ZSH = `# devup zsh completion — add to ~/.zshrc:  eval "$(dev completion zsh)"
_devup_projects() {
  local dir="\${DEVUP_HOME:-$HOME/.devup}/projects"
  [[ -d "$dir" ]] || return 0
  local -a projs
  projs=("\$dir"/*.yaml(N:t:r) "\$dir"/*.yml(N:t:r))
  (( \${#projs} )) && _describe -t projects 'project' projs
}
_dev_cli() {
  local -a subcmds
  subcmds=(
    'up:start a project environment'
    'down:stop a project environment'
    'restart:restart a project'
    'status:show project status'
    'logs:show service logs'
    'list:list registered projects'
    'doctor:check the environment'
    'init:create a project config'
    'register:link a repo-local config'
    'unregister:remove a registered project'
    'completion:print shell completion'
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'dev command' subcmds
  else
    case "\$words[2]" in
      up|down|restart|status|logs|unregister) _devup_projects ;;
      register) _files -g '*.y(a|)ml' ;;
    esac
  fi
}
compdef _dev_cli dev
compdef _devup_projects devup devdown devrestart devstatus devlogs
`;

const BASH = `# devup bash completion — add to ~/.bashrc:  eval "$(dev completion bash)"
_devup_projects() {
  local dir="\${DEVUP_HOME:-$HOME/.devup}/projects"
  [[ -d "$dir" ]] || return 0
  local names
  names=$(ls "$dir" 2>/dev/null | sed -E 's/\\.(yaml|yml)$//')
  COMPREPLY=($(compgen -W "$names" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
_dev_cli() {
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "up down restart status logs list doctor init register unregister completion" -- "\${COMP_WORDS[1]}"))
  else
    case "\${COMP_WORDS[1]}" in
      up|down|restart|status|logs|unregister) _devup_projects ;;
    esac
  fi
}
complete -F _dev_cli dev
for c in devup devdown devrestart devstatus devlogs; do complete -F _devup_projects "$c"; done
`;

export function completionScript(shell: string): string | null {
  if (shell === "zsh") return ZSH;
  if (shell === "bash") return BASH;
  return null;
}
