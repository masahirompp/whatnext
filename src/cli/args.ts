// cli: 引数の振り分け(PRODUCT.md「全体」)。

export type Command = {kind: 'list'} | {kind: 'workbench'} | {kind: 'help'} | {kind: 'unknown'; arg: string};

export function parseArgs(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined) return {kind: 'list'};
  if (first === '--help') return {kind: 'help'};
  if (first === 'workbench') return rest.length === 0 ? {kind: 'workbench'} : {kind: 'unknown', arg: rest[0] as string};
  return {kind: 'unknown', arg: first};
}

export const USAGE = `Usage:
  whatnext             Show your Claude Code sessions, ordered by which one to touch next.
  whatnext workbench   Show the workbench of the session you are looking at.
                       Run it in another split, tab or window of your terminal.
  whatnext --help      Show this help.
`;

export const INSIDE_MESSAGE =
  'whatnext: this shell runs inside whatnext. Run "whatnext" in another split or window of your terminal.';

export interface Settings {
  socket: string;
  port: number;
}

export function settings(env: NodeJS.ProcessEnv): Settings {
  const socket = env.WHATNEXT_TMUX_SOCKET || 'whatnext';
  const port = Number(env.WHATNEXT_PORT) || 14318;
  return {socket, port};
}
