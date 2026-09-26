// Fixed rows and wait-for relations for trying layouts (WHATNEXT_DEMO=1).
import type { RawRow } from './model.js';

const cwd = process.cwd();
let n = 0;
const bg = (name: string, o: Partial<RawRow>): RawRow => {
  const id = `de${String(++n).padStart(6, '0')}`;
  return { kind: 'background', id, sessionId: `${id}-demo`, cwd, name, startedAt: 0, pid: 1000 + n, ...o };
};

export const demoRows: RawRow[] = [
  bg('fix-typo', { state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' }),
  bg('impl-auth', { state: 'done', status: 'idle' }),
  bg('review-auth', { state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' }),
  bg('lint-auth', { state: 'done', status: 'idle' }),
  bg('docs-auth', { state: 'working', status: 'busy' }),
  bg('ask-design', { state: 'blocked', status: 'idle' }),
  bg('flaky-test', { state: 'failed', status: 'idle' }),
  bg('bump-deps', { state: 'done', status: 'idle' }),
  bg('refactor-db', { state: 'done', status: 'idle' }),
  bg('tests-db', { state: 'working', status: 'busy' }),
  bg('migrate-db', { state: 'working', status: 'busy' }),
];

export const demoWaits: [string, string][] = [
  ['impl-auth', 'review-auth'],
  ['impl-auth', 'docs-auth'],
  ['review-auth', 'lint-auth'],
  ['refactor-db', 'tests-db'],
  ['refactor-db', 'migrate-db'],
];
