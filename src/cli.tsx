#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { startOtel } from './otel.js';

await startOtel();
const instance = render(<App />, { alternateScreen: true, exitOnCtrlC: false });
await instance.waitUntilExit();
process.exit(0);
