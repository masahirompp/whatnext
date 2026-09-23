#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('whatnext needs an interactive terminal.');
  process.exit(1);
}

const app = render(<App launchDir={process.cwd()} />, { alternateScreen: true, exitOnCtrlC: false });
await app.waitUntilExit();
