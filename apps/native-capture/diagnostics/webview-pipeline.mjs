// Only the existing synthetic fixture/helper is used. Production trust rules stay unchanged.
/* global process, console, setTimeout, clearTimeout, URL */
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const origin = 'http://127.0.0.1:5188';
const seconds = Number(process.argv.find(value => value.startsWith('--seconds='))?.slice(10) || 90);
const bitrate = Number(process.argv.find(value => value.startsWith('--bitrate='))?.slice(10) || 10000000);
const steps = process.argv.includes('--steps');
const panSource = process.argv.find(value => value.startsWith('--pan-source='))?.slice(13);
const snapshots = !process.argv.includes('--no-snapshots');
if (!process.env.BABAGAN_TEST_FFMPEG || !Number.isInteger(seconds) || seconds < 10 || seconds > 600 || !Number.isInteger(bitrate) || bitrate < 1000000 || bitrate > 40000000) throw new Error('Specify the trusted synthetic FFmpeg path and valid diagnostic options.');
const output = resolve(root, 'output/webview2-validation', `${panSource ? 'large-pan' : steps ? 'scene-steps' : 'continuous'}-${seconds}s-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const sdk = resolve(root, 'output/desktop-build-cache/webview2-1.0.4314.35');
for (const file of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']) await copyFile(resolve(sdk, 'lib/net462', file), resolve(output, file));
await copyFile(resolve(sdk, 'runtimes/win-x64/native/WebView2Loader.dll'), resolve(output, 'WebView2Loader.dll'));
const executable = resolve(output, 'WebViewPipeline.exe');
const compiler = resolve(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
await new Promise((done, reject) => {
  const child = spawn(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/utf8output', '/nowarn:0649', `/out:${executable}`,
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll',
    `/reference:${resolve(output, 'Microsoft.Web.WebView2.Core.dll')}`, `/reference:${resolve(output, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    resolve(root, 'apps/native-capture/diagnostics/WebViewPipeline.cs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Diagnostic compilation failed')));
});
const { createServer } = await import('../../web/node_modules/vite/dist/node/index.js');
const vite = await createServer({ root, configFile: false, resolve: { alias: { '@meeting/contracts': resolve(root, 'packages/contracts/src/index.ts') } }, server: { host: '127.0.0.1', port: 5188, strictPort: true, hmr: false, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } } });
let helper, harness;
try {
  await vite.listen();
  helper = panSource
    ? fork(resolve(root, 'apps/native-capture/diagnostics/synthetic-pan-helper.mjs'), [resolve(panSource)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    : fork(resolve(root, 'apps/native-capture/diagnostics/browser-pipeline.mjs'), ['--helper', ...(steps ? ['--steps'] : [])], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const config = await new Promise((done, reject) => { const deadline = setTimeout(() => reject(new Error('Synthetic helper startup timed out')), 15000); helper.once('message', message => { clearTimeout(deadline); done(message); }); helper.once('error', reject); helper.once('exit', () => reject(new Error('Synthetic helper exited before readiness'))); });
  harness = spawn(executable, [], { windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
  harness.stdin.end(JSON.stringify({ url: `${origin}/apps/native-capture/diagnostics/browser-pipeline.html?bitrate=${bitrate}#nativeCapture=1.${config.port}.${config.token}`, seconds, output, steps, bitrate, largePan: Boolean(panSource), snapshots }) + '\n');
  harness.stdout.on('data', chunk => process.stdout.write(chunk)); harness.stderr.on('data', chunk => process.stderr.write(chunk));
  const code = await new Promise((done, reject) => { const deadline = setTimeout(() => { harness.kill(); reject(new Error('Synthetic WebView2 diagnostic exceeded its deadline')); }, (seconds + 100) * 1000); harness.once('error', reject); harness.once('exit', value => { clearTimeout(deadline); done(value); }); });
  await writeFile(resolve(root, 'output/webview2-validation/latest.json'), JSON.stringify({ output, exitCode: code }, null, 2));
  if (code !== 0) throw new Error(`WebView2 synthetic diagnostic failed; inspect samples.json under ${output}`);
  const data = JSON.parse(await readFile(resolve(output, 'samples.json'), 'utf8'));
  console.log(JSON.stringify({ output, browser: data.browser, samples: data.samples.length, errors: data.errors, stopped: data.stopped }));
} finally {
  if (harness && harness.exitCode === null) harness.kill();
  if (helper && helper.exitCode === null) await new Promise(done => { const timer = setTimeout(() => { helper.kill(); done(); }, 5000); helper.once('exit', () => { clearTimeout(timer); done(); }); if (helper.connected) helper.send('stop'); else helper.kill(); });
  await vite.close();
}
