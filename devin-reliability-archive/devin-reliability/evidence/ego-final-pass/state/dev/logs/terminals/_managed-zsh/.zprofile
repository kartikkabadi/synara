# Synara zsh profile wrapper
_synara_home="${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zprofile" ]] && source "$_synara_home/.zprofile"
export ZDOTDIR='/tmp/devin-tool-idle-ego-final-pass/state/dev/logs/terminals/_managed-zsh'
