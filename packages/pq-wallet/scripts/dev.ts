import { context } from 'esbuild';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = `${root}/.demo-dist`;
const args = process.argv.slice(2);
const index = args.indexOf('--port');
const port = index < 0 ? 4173 : Number(args[index + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535');
await mkdir(output, { recursive: true });
const build = await context({ entryPoints: [`${root}/demo/app.ts`], bundle: true, outfile: `${output}/app.js`,
  platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'info' });
await build.rebuild();
await copyFile(`${root}/demo/index.html`, `${output}/index.html`);
await copyFile(`${root}/demo/style.css`, `${output}/style.css`);
if (args.includes('--build')) {
  await build.dispose(); console.log('Browser wallet built in .demo-dist');
} else {
  await build.watch();
  const url = `http://127.0.0.1:${port}`;
  const routes: Record<string, { file: string; type: string }> = {
    '/': { file: `${root}/demo/index.html`, type: 'text/html' },
    '/app.js': { file: `${output}/app.js`, type: 'text/javascript' },
    '/style.css': { file: `${root}/demo/style.css`, type: 'text/css' },
  };
  const server = createServer(async (request, response) => {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? '')) {
      response.writeHead(403); response.end('Local access only'); return;
    }
    const route = routes[request.url ?? '/'];
    if (!route || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const data = await readFile(route.file);
      response.writeHead(200, { 'Content-Type': `${route.type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch { response.writeHead(500); response.end('Wallet build unavailable'); }
  });
  server.on('error', async error => { console.error(error.message); await build.dispose(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  Opaque wallet: ${url}\n  Local demo only. Press Ctrl+C to stop.\n`);
    if (!args.includes('--no-open')) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const openArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      const child = spawn(command, openArgs, { stdio: 'ignore', detached: true });
      child.on('error', () => console.log(`Open ${url} in your browser.`)); child.unref();
    }
  });
  const stop = async () => { server.close(); await build.dispose(); process.exit(0); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
}
