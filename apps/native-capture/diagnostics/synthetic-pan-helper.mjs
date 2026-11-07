/* global process */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createNativeCaptureServer } from '../dist/server.js';
import { panArguments } from './synthetic-pan.mjs';
const source = process.argv[2];
if (!source || !process.env.BABAGAN_TEST_FFMPEG) throw new Error('Synthetic chart and trusted FFmpeg are required');
const helper = await createNativeCaptureServer({ ffmpeg: process.env.BABAGAN_TEST_FFMPEG, origin: 'http://127.0.0.1:5188', idleTimeoutMs: 300000, getActiveDisplayCount: async () => 1,
  spawnProcess: (executable, args) => spawn(executable, panArguments(args, resolve(source)), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
process.send?.({ port: helper.port, token: helper.token });
const stop = () => void helper.close().then(() => process.exit(0));
process.once('message', stop); process.once('disconnect', stop); process.once('SIGTERM', stop);
