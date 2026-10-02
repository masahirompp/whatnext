// attach している間のキーの表。tmux の割り当て、一覧に戻ってから処理する頼みごとの列挙、キーの説明をここから作る
// (DESIGN.md「一覧と作業台の仕組み」。サイクル6ではキーを1つ足すのに6か所を触った)。
//
// kind:
//   back    whatnext の画面を一覧に戻す
//   req     一覧に戻さずに一覧に頼む(外のアプリのメニュー、次のセッション、作業台を作る)
//   backreq whatnext の画面を一覧に戻してから、一覧の同じ文字の操作をする
export type AttachKey = {
	letter: string;
	kind: 'back' | 'req' | 'backreq';
	action: string;
	help: string;
	// tmux の prefix の既定の割り当てがない文字は、文字だけでも同じ動作にする(説明には載せない)
	plain?: boolean;
};

export const ATTACH_KEYS: AttachKey[] = [
	{letter: 'l', kind: 'back', action: 'back', help: 'back'},
	{letter: 'j', kind: 'req', action: 'next', help: 'next', plain: true},
	{letter: 'w', kind: 'req', action: 'create', help: 'workbench'},
	{letter: 'e', kind: 'req', action: 'ext', help: 'external', plain: true},
	{letter: 'h', kind: 'backreq', action: 'hold', help: 'hold', plain: true},
	{letter: 'x', kind: 'backreq', action: 'stop', help: 'stop'},
	{letter: 'n', kind: 'backreq', action: 'new', help: 'new'},
	{letter: 'f', kind: 'backreq', action: 'waitfor', help: 'wait'},
];

export const BACKREQ_ACTIONS = new Set(ATTACH_KEYS.filter(k => k.kind === 'backreq').map(k => k.action));

export const ATTACH_HELP = ATTACH_KEYS.map(k => `^Q^${k.letter.toUpperCase()} ${k.help}`).join(' · ');
