#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App, OPTIONS } from './app.js';
import { startOtel } from './otel.js';

const USAGE = `Usage: whatnext [options]

Options:
  --compare-wait  Show the waiting time from hooks and from OTel side by side (HOOK/OTEL).
  -h, --help      Show this help.`;

for (const a of process.argv.slice(2)) {
  if (a === '--compare-wait') OPTIONS.compareWait = true;
  else if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`whatnext: unknown option ${a}\n\n${USAGE}`);
    process.exit(2);
  }
}

if ((await startOtel()) === 'running') {
  console.error('whatnext is already running in another terminal. Use that one, or quit it first.');
  process.exit(1);
}
const instance = render(<App />, { alternateScreen: true, exitOnCtrlC: false });
await instance.waitUntilExit();
process.exit(0);
