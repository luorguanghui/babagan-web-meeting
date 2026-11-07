/* global process, console */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildCaptureArguments } from '../dist/capture.js';
import { panArguments } from './synthetic-pan.mjs';
const source = process.argv[2], ffmpeg = process.env.BABAGAN_TEST_FFMPEG;
if (!source || !ffmpeg) throw new Error('Supply the synthetic chart and trusted FFmpeg.');
async function run(format, frames) {
  const args = panArguments(buildCaptureArguments(60), resolve(source), false);
  args[args.lastIndexOf('-f') + 1] = format; args.splice(args.lastIndexOf('-f'), 0, '-frames:v', String(frames));
  const start = performance.now();
  return await new Promise((done, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data.toString(); }); child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
    child.once('error', reject); child.once('exit', code => code === 0 ? done({ seconds: (performance.now() - start) / 1000, stdout }) : reject(new Error('Synthetic source benchmark failed: ' + stderr.slice(-1000))));
  });
}
const throughput = await run('null', 600);
const unique = await run('framemd5', 60);
const hashes = unique.stdout.split(/\r?\n/).filter(line => /^\d+,/.test(line)).map(line => line.split(',').at(-1).trim());
const result = { input: 'Cached 4096x2304 synthetic chart with full-viewport pan/diagonal/scroll and cuts; no desktop capture', selectedFrames: 600, seconds: throughput.seconds, sourceCeilingFps: 600 / throughput.seconds, measuredUniqueFrames: hashes.length, uniqueFullFrameHashes: new Set(hashes).size, hashes,
  generator: 'image2 120Hz → loop cached image → moving 1920x1080 crop → optional hard hflip cuts → production scale/I420/60Hz selection; realtime pacing disabled only for source ceiling test' };
const output = resolve('output/native-pan-source'); await mkdir(output, { recursive: true }); await writeFile(resolve(output, 'source-baseline.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, hashes: undefined }, null, 2));
if (hashes.length !== 60 || new Set(hashes).size !== 60 || result.sourceCeilingFps < 60) process.exitCode = 1;
