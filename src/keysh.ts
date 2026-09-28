// tmux のキー、フック、ペインのコマンドから呼ぶ小さな sh。引数: <socket> <action> [args...]
// 本文は一覧のプロセスが tmux のグローバル環境 WN_SH に置き、`sh -c "$WN_SH" wn <socket> ...` で呼ぶ。
// ファイルから読まないので、動いている一覧と同じ版の処理が走る(同じ場所に入れ直す更新でも混ざらない)。
// 一覧への知らせは、@wn_pid に SIGUSR2 を送るだけにする。
export const KEY_SH = String.raw`S="$1"; A="$2"; shift 2
T() { tmux -L "$S" "$@"; }
notify() {
	pid=$(T show -gv @wn_pid 2>/dev/null)
	[ -n "$pid" ] && kill -USR2 "$pid" 2>/dev/null
	return 0
}
to_list() { T switch-client -c "$1" -t '=list' 2>/dev/null; }
clients_on() { T list-clients -F '#{client_tty}	#{session_name}' 2>/dev/null | awk -F '	' -v s="$1" '$2==s{print $1}'; }

case "$A" in
attach)
	# <id>: claude の画面(ペインのコマンド)
	id="$1"
	claude attach "$id"
	rc=$?
	if [ "$rc" -ne 0 ]; then
		printf '\r\n[claude attach exited with code %s. Press any key to return to the list.]' "$rc"
		stty raw -echo 2>/dev/null
		dd bs=1 count=1 >/dev/null 2>&1
		stty sane 2>/dev/null
	fi
	for c in $(clients_on "$id"); do to_list "$c"; done
	T set -g @wn_ev "exit $id $rc"
	notify
	;;
trust)
	# <session>: 対話モードの claude で信頼の確認を出す。承認を見届けたら一覧がこのセッションを畳む
	sn="$1"
	claude
	for c in $(clients_on "$sn"); do to_list "$c"; done
	notify
	;;
left)
	# <session>: 空のプロンプトの ← で Agent View に入った
	sn="$1"
	for c in $(clients_on "$sn"); do to_list "$c"; done
	T set -g @wn_ev "left $sn"
	notify
	T kill-session -t "=$sn"
	;;
popup)
	# <session> <client_tty>: claude の画面から作業台を出す
	sn="$1"; ct="$2"
	id=$(T show -t "=$sn:" -v @wn_id 2>/dev/null)
	cwd=$(T show -t "=$sn:" -v @wn_cwd 2>/dev/null)
	name=$(T show -t "=$sn:" -v @wn_name 2>/dev/null)
	[ -n "$id" ] || exit 0
	[ -d "$cwd" ] || cwd="$HOME"
	T display-popup -c "$ct" -E -w 90% -h 85% -d "$cwd" -T " workbench: $name " \
		env -u TMUX -u WN_SH tmux -L "$S" new-session -A -s "sh-$id" -c "$cwd" -e WN_SH=
	notify
	;;
back)
	# <session> <client_tty>: ctrl+q l。作業台の中なら popup も閉じる
	sn="$1"; ct="$2"
	case "$sn" in
	sh-*)
		id=$(printf '%s' "$sn" | cut -c4-)
		for c in $(clients_on "$id"); do
			T display-popup -C -c "$c" 2>/dev/null
			to_list "$c"
		done
		;;
	*) to_list "$ct" ;;
	esac
	notify
	;;
req)
	# 一覧に処理を頼む(メニューなど)。残りの引数をそのまま渡す
	T set -g @wn_req "$*"
	notify
	;;
wb)
	# <id>: claude の画面のステータス行の左側。作業台で動いているコマンド、シェルだけなら (shell)、なければ空
	id="$1"
	pids=$(T list-panes -s -t "=sh-$id" -F '#{pane_pid}' 2>/dev/null) || exit 0
	[ -n "$pids" ] || exit 0
	# シェルの子をプロセスグループごとにまとめ、パイプは " | " でつなぐ
	cmds=$(ps -A -o ppid=,pgid=,args= | awk -v p=" $(echo $pids) " '
		{ pp = $1; g = $2; sub(/^ *[0-9]+ +[0-9]+ +/, "");
		  if (!index(p, " " pp " ")) next
		  if (!(g in grp)) { order[++n] = g; grp[g] = $0 } else grp[g] = grp[g] " | " $0 }
		END { for (i = 1; i <= n; i++) out = out (i > 1 ? " · " : "") grp[order[i]]; print out }')
	if [ -n "$cmds" ]; then printf '⚙ %s' "$cmds"; else printf '⌂ workbench (shell)'; fi
	;;
notify)
	notify
	;;
esac
exit 0
`;
