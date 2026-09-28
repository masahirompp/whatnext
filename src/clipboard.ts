import {spawn} from 'node:child_process';

// pbcopy があれば使い、なければ OSC 52(tmux の set-clipboard で外側の端末に渡る)
export function copy(text: string): Promise<void> {
	return new Promise(resolve => {
		const child = spawn('pbcopy', [], {stdio: ['pipe', 'ignore', 'ignore']});
		child.on('error', () => {
			process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
			resolve();
		});
		child.on('close', () => resolve());
		child.stdin.end(text);
	});
}
