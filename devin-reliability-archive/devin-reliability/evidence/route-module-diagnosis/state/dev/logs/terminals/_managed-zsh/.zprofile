# Synara zsh profile wrapper
_synara_home="${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zprofile" ]] && source "$_synara_home/.zprofile"
export ZDOTDIR='/tmp/devin-route-module-diagnosis/state/dev/logs/terminals/_managed-zsh'
