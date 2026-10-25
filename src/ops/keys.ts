import type {AttachKeyBinding} from '../../lib/tmux/tmux.js';

// attach している間のキーの表(DESIGN.md「一覧と作業台の仕組み」)。tmux の割り当て、
// 一覧に戻ってから処理する頼みごとの列挙、claude の画面のキーの説明を、この1か所から作る。

export type AttachAction = 'back' | 'workbench' | 'vscode' | 'note' | 'stop' | 'new' | 'wait';

interface AttachKey extends AttachKeyBinding {
  action: AttachAction;
  help: string;
  /** 一覧に戻ってから処理する。 */
  toList: boolean;
}

export const ATTACH_KEYS: readonly AttachKey[] = [
  {letter: 'l', action: 'back', bare: false, help: 'back', toList: true},
  {letter: 'w', action: 'workbench', bare: false, help: 'workbench', toList: false},
  {letter: 'v', action: 'vscode', bare: true, help: 'VS Code', toList: false},
  {letter: 'e', action: 'note', bare: true, help: 'note', toList: true},
  {letter: 'x', action: 'stop', bare: false, help: 'stop', toList: true},
  {letter: 'n', action: 'new', bare: false, help: 'new', toList: true},
  {letter: 'f', action: 'wait', bare: false, help: 'wait', toList: true},
];

export const ATTACH_KEYS_HELP = ATTACH_KEYS.map(k => `^Q^${k.letter.toUpperCase()} ${k.help}`).join(' · ');

export const isAttachAction = (s: string): s is AttachAction => ATTACH_KEYS.some(k => k.action === s);

/** 案内のプログラムが `Enter` で頼む、作業台を作る頼みごとの名前(attach している間のキーではない)。 */
export const GUIDE_CREATE = 'wbcreate';

export const LIST_KEYS_HELP =
  '↑↓ select · Enter attach · n new · ^X stop/delete · e note · f wait for · w workbench · v VS Code · r refresh · q quit';
