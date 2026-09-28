#!/usr/bin/env node
import {launch, USAGE} from './launcher.js';

async function main(): Promise<number> {
	if (process.env.WHATNEXT_ROLE === 'list') {
		const {runList} = await import('./list.js');
		return runList();
	}
	for (const arg of process.argv.slice(2)) {
		if (arg === '--help' || arg === '-h') {
			process.stdout.write(USAGE + '\n');
			return 0;
		}
		process.stderr.write(`whatnext: unknown option ${arg}\n${USAGE}\n`);
		return 2;
	}
	return launch();
}

process.exitCode = await main();
