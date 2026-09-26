// Run by Claude Code as a command hook in sessions whatnext launched. Forwards
// the hook input to whatnext's receiver and always exits 0 with no output, so
// the session sees no error when whatnext is closed and no decision is made
// for PermissionRequest (ADR-0003).
import http from 'node:http';

const port = Number(process.argv[2]) || 14318;
setTimeout(() => process.exit(0), 3000).unref();

const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/v1/hooks',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: 1000,
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    },
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.end(body);
});
