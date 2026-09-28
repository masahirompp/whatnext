import React from 'react';
import {render} from 'ink';
import {App} from './app.js';
import {openReceiver} from './receiver.js';
import {Store} from './store.js';
import {configureServer} from './tmux.js';

// 専用サーバのセッション list の中で動く一覧のプロセス。
export async function runList(): Promise<number> {
	const store = new Store();
	// SIGUSR2 は tmux のキーとフックからの知らせ
	process.on('SIGUSR2', () => store.onNotify());
	// 確認を出せずに終わるとき: 残した attach と何も動いていない作業台を畳み、動いているものは残す
	for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
		process.on(sig, () => {
			void store.cleanupOnSignal().finally(() => process.exit(0));
		});
	}
	await configureServer(process.pid);
	store.receiverOpen = await openReceiver();
	const app = render(<App store={store} />, {alternateScreen: true, exitOnCtrlC: false});
	store.maybeFetchUsage(true);
	await store.refresh();
	await store.recoverLeftovers();
	await app.waitUntilExit();
	return 0;
}
