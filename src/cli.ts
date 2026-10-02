#!/usr/bin/env node
// cli: 起動の振り分け(一覧、`whatnext workbench`、`--help`、知らないオプション)。

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {INSIDE_MESSAGE, parseArgs, settings, USAGE} from './cli/args.js';
import {launch, workbench} from './cli/launcher.js';
import {isListRole, runList} from './cli/list.js';

const cliPath = fileURLToPath(import.meta.url);
const distDir = dirname(cliPath);

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(distDir, '..', 'package.json'), 'utf8')) as {version: string}).version;
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<number> {
  const env = process.env;
  const s = settings(env);
  if (env.WHATNEXT_ROLE === 'list' && isListRole(env, s)) {
    await runList(s, version(), distDir, cliPath);
    return -1;
  }
  const cmd = parseArgs(process.argv.slice(2));
  if (cmd.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd.kind === 'unknown') {
    process.stderr.write(`whatnext: unknown option ${cmd.arg}\n${USAGE}`);
    return 2;
  }
  if (env.WHATNEXT_ROLE) {
    process.stderr.write(`${INSIDE_MESSAGE}\n`);
    return 1;
  }
  if (cmd.kind === 'workbench') return workbench(s);
  return launch(s, version(), cliPath);
}

main().then(
  code => {
    if (code >= 0) process.exit(code);
  },
  e => {
    process.stderr.write(`whatnext: ${(e as Error)?.stack ?? e}\n`);
    process.exit(1);
  },
);
