import {onPrompt, openReceiver} from './receiver.js';
import {debug, Store} from './store.js';
import {paint, screenSize, startTerminal} from './term.js';
import {configureServer} from './tmux.js';
import {frame} from './view.js';

// 専用サーバのセッション list の中で動く一覧のプロセス。
export async function runList(): Promise<number> {
	const store = new Store();
	// 確認を出せずに終わるとき(シグナル、想定外の例外): 残した attach と何も動いていない作業台を畳み、動いているものは残す。
	// 後始末が止まっても終われるように、10秒で打ち切る
	let ending = false;
	const end = (code: number) => {
		if (ending) return;
		ending = true;
		setTimeout(() => process.exit(code), 10000).unref();
		void store.cleanupOnSignal().finally(() => process.exit(code));
	};
	process.on('uncaughtException', e => {
		debug(`uncaught: ${e.stack ?? e}`);
		end(70);
	});
	process.on('unhandledRejection', e => debug(`unhandled: ${(e as Error)?.stack ?? e}`));
	process.on('exit', code => debug(`exit ${code}`));
	debug(`start pid=${process.pid} port=${process.env.WHATNEXT_PORT} socket=${process.env.WHATNEXT_TMUX_SOCKET}`);
	// SIGUSR2 は tmux のキーとフックからの知らせ
	process.on('SIGUSR2', () => store.onNotify());
	onPrompt(sid => void store.onPrompt(sid).catch(e => debug(`prompt: ${(e as Error).stack ?? e}`)));
	for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(sig, () => end(0));
	const err = await configureServer(process.pid);
	if (err) debug(`configure: ${err}`);
	await openReceiver();

	// 描画はキーや更新のたびではなく、setImmediate で1回にまとめる
	let scheduled = false;
	const render = () => {
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			paint(frame(store, screenSize()));
		});
	};
	store.subscribe(render);
	startTerminal(k => store.key(k), render);
	render();
	store.maybeFetchUsage(true);
	await store.refresh();
	await store.recoverLeftovers();
	return new Promise<number>(() => {});
}
