// tmux のキー、フック、ペインのコマンドから呼ぶ小さな sh。引数: <socket> <action> [args...]
// 本文は一覧のプロセスがサーバのオプション @wn_sh に置き、`sh -c "$(tmux show -gv @wn_sh)" wn <socket> ...` で呼ぶ。
// ファイルから読まないので、動いている一覧と同じ版の処理が走る(同じ場所に入れ直す更新でも混ざらない)。
// 一覧への知らせは、@wn_pid に SIGUSR2 を送るだけにする。
//
// クライアントは2種類ある。whatnext の画面(tty を @wn_main_tty に置く)と、作業台の画面(@wn_wb_tty)。
// 作業台の画面が映すのは sh-<id>(作業台)か wbguide(作業台がないときの案内。対象は @wn_guide_id)。
export const KEY_SH = String.raw`S="$1"; A="$2"; shift 2
T() { tmux -L "$S" "$@"; }
notify() {
	pid=$(T show -gv @wn_pid 2>/dev/null)
	[ -n "$pid" ] && kill -USR2 "$pid" 2>/dev/null
	return 0
}
clients_on() { T list-clients -F '#{client_tty}	#{session_name}' 2>/dev/null | awk -F '	' -v s="$1" '$2==s{print $1}'; }
to_list() { T switch-client -c "$1" -t '=list' 2>/dev/null; }
# つながっている whatnext の画面の tty(なければ空)
main_tty() {
	mt=$(T show -gv @wn_main_tty 2>/dev/null)
	[ -n "$mt" ] && T list-clients -F '#{client_tty}' 2>/dev/null | grep -qx "$mt" && printf '%s' "$mt"
	return 0
}
# 押した画面のセッションから、対象のセッションの id を決める
target_id() {
	case "$1" in
	sh-*) printf '%s' "$1" | cut -c4- ;;
	wbguide) T show -gv @wn_guide_id 2>/dev/null ;;
	*) printf '%s' "$1" ;;
	esac
}
no_list() { T display-message -c "$1" -d 3000 'The list is not open. Run "whatnext" to open it.' 2>/dev/null; }

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
back)
	# <session> <client_tty>: ctrl+q ctrl+l。作業台の画面で押しても、whatnext の画面を一覧に戻す
	mt=$(main_tty)
	if [ -z "$mt" ]; then no_list "$2"; exit 0; fi
	to_list "$mt"
	notify
	;;
backreq)
	# <what> <session> <client_tty>: whatnext の画面を一覧に戻してから、その行への操作を一覧に頼む
	mt=$(main_tty)
	if [ -z "$mt" ]; then no_list "$3"; exit 0; fi
	id=$(target_id "$2")
	to_list "$mt"
	T set -g @wn_req "$1 $id"
	notify
	;;
req)
	# <what> <session> <client_tty> [...]: 一覧に処理を頼む(メニューなど)
	T set -g @wn_req "$*"
	notify
	;;
wb)
	# <id>: claude の画面のステータス行の左側。作業台で動いているコマンド、シェルだけなら (shell)、なければ空
	id="$1"
	pids=$(T list-panes -s -t "=sh-$id" -F '#{?pane_dead,,#{pane_pid}}' 2>/dev/null) || exit 0
	pids=$(echo $pids)
	[ -n "$pids" ] || exit 0
	# シェルの子をプロセスグループごとにまとめ、パイプは " | " でつなぐ
	cmds=$(ps -A -o ppid=,pgid=,args= | awk -v p=" $pids " '
		{ pp = $1; g = $2; sub(/^ *[0-9]+ +[0-9]+ +/, "");
		  if (!index(p, " " pp " ")) next
		  if (!(g in grp)) { order[++n] = g; grp[g] = $0 } else grp[g] = grp[g] " | " $0 }
		END { for (i = 1; i <= n; i++) out = out (i > 1 ? " · " : "") grp[order[i]]; print out }')
	if [ -n "$cmds" ]; then printf '⚙ %s' "$cmds"; else printf '⌂ workbench (shell)'; fi
	;;
guide)
	# <kind> <id> <name> <cwd>: 作業台の画面の案内(セッション wbguide のペインのコマンド)
	# kind: none(選んでいる行がない)、tty(対話セッション)、no(作業台がない)、closed(最後のシェルを抜けた)
	kind="$1"; id="$2"; name="$3"; cwd="$4"
	T set -g @wn_guide_id "$id"
	T set -g @wn_guide "$kind	$id	$cwd"
	label=$(printf '%s' "$name" | sed 's/#/##/g')
	T set -t '=wbguide:' status-left " workbench: $label "
	short=$(printf '%s' "$cwd" | awk -v h="$HOME" 'index($0, h) == 1 { $0 = "~" substr($0, length(h) + 1) } { print }')
	printf '\033[?25l\033[H\033[2J'
	case "$kind" in
	none) printf 'No session selected.\r\n' ;;
	tty) printf '%s is an interactive session. It has no workbench.\r\n' "$name" ;;
	*)
		[ "$kind" = closed ] && printf 'Workbench closed.\r\n'
		printf 'No workbench for %s yet.\r\n' "$name"
		printf 'Enter: open a shell in %s\r\n' "$short"
		;;
	esac
	stty raw -echo 2>/dev/null
	while :; do
		c=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
		[ -n "$c" ] || exit 0
		case "$c" in
		0d | 0a)
			case "$kind" in no | closed)
				T set -g @wn_req "create $id guide"
				notify
				;;
			esac
			;;
		esac
	done
	;;
died)
	# <session> <pane_id>: 作業台のペインのコマンドが終わった(作業台は remain-on-exit on)。
	# ほかに生きているペインがあれば、ふだんどおり閉じる。最後のシェルなら、作業台の画面を案内に切り替えてから作業台を畳む
	# (先に畳むと、作業台の画面が見ているセッションが消えて、ほかのセッションに移ってしまう)
	sn="$1"; pane="$2"
	live=$(T list-panes -s -t "=$sn" -F '#{pane_dead}' 2>/dev/null | grep -c '^0$')
	if [ "$live" -gt 0 ]; then T kill-pane -t "$pane"; exit 0; fi
	id=$(printf '%s' "$sn" | cut -c4-)
	name=$(T show -t "=$sn:" -v @wn_name 2>/dev/null)
	cwd=$(T show -t "=$sn:" -v @wn_cwd 2>/dev/null)
	for c in $(clients_on "$sn"); do
		T respawn-pane -k -t '=wbguide:' sh -c "$(T show -gv @wn_sh)" wn "$S" guide closed "$id" "$name" "$cwd"
		T switch-client -c "$c" -t '=wbguide'
	done
	T kill-session -t "=$sn"
	notify
	;;
focus)
	# <client_tty>: 端末のフォーカスがクライアントに移った
	T set -g @wn_focus "$1"
	notify
	;;
notify)
	notify
	;;
esac
exit 0
`;
