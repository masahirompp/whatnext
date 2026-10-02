// tmux: attach している間のキーの表。tmux の割り当て、一覧に戻ってから処理する頼みごと、キーの説明を、この1か所から作る。

export type KeyAction = 'back' | 'next' | 'wb' | 'ext' | 'hold' | 'stop' | 'new' | 'wait';

export interface AttachKey {
  /** `ctrl+q` のあとに ctrl を押したまま押す文字。 */
  letter: string;
  action: KeyAction;
  help: string;
  /** 文字だけの形(tmux の既定の割り当てがない文字だけ)も同じ動作にする。 */
  bare: boolean;
  /** 一覧に戻ってから処理する頼みごと。 */
  returnsToList: boolean;
}

export const ATTACH_KEYS: readonly AttachKey[] = [
  {letter: 'l', action: 'back', help: 'back', bare: false, returnsToList: true},
  {letter: 'j', action: 'next', help: 'next', bare: true, returnsToList: false},
  {letter: 'w', action: 'wb', help: 'workbench', bare: false, returnsToList: false},
  {letter: 'e', action: 'ext', help: 'external', bare: true, returnsToList: false},
  {letter: 'h', action: 'hold', help: 'hold', bare: true, returnsToList: true},
  {letter: 'x', action: 'stop', help: 'stop', bare: false, returnsToList: true},
  {letter: 'n', action: 'new', help: 'new', bare: false, returnsToList: true},
  {letter: 'f', action: 'wait', help: 'wait', bare: false, returnsToList: true},
];

/** claude の画面のステータス行に出すキーの説明。 */
export function attachKeysHelp(): string {
  return ATTACH_KEYS.map(k => `^Q^${k.letter.toUpperCase()} ${k.help}`).join(' · ');
}
