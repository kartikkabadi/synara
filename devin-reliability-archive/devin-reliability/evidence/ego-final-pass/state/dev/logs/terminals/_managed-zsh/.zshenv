# Synara zsh env wrapper
_synara_home="${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zshenv" ]] && source "$_synara_home/.zshenv"
export ZDOTDIR='/tmp/devin-tool-idle-ego-final-pass/state/dev/logs/terminals/_managed-zsh'
