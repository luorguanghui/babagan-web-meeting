/* global process, console */
import { readFile, writeFile } from 'node:fs/promises';
const path = process.argv[2];
if (!path) throw new Error('Pass the synthetic WebView2 samples.json path.');
const data = JSON.parse(await readFile(path, 'utf8'));
const mean = values => { const finite = values.filter(Number.isFinite); return finite.length ? Number((finite.reduce((a, b) => a + b, 0) / finite.length).toFixed(3)) : null; };
const p05 = values => { const finite = values.filter(Number.isFinite).sort((a, b) => a - b); return finite.length ? Number(finite[Math.floor((finite.length - 1) * .05)].toFixed(3)) : null; };
const range = values => { const finite = values.filter(Number.isFinite); return finite.length ? [Math.min(...finite), Math.max(...finite)].map(value => Number(value.toFixed(3))) : null; };
const summarize = rows => ({ samples: rows.length, sourceFps: mean(rows.map(row => row.sourceFps)), encodedFps: mean(rows.map(row => row.encodedFps)), decodedFps: mean(rows.map(row => row.decodedFps)), encodedP05: p05(rows.map(row => row.encodedFps)), decodedP05: p05(rows.map(row => row.decodedFps)), actualMbps: mean(rows.map(row => row.actualMbps)), actualMbpsRange: range(rows.map(row => row.actualMbps)), targetMbps: mean(rows.map(row => row.targetMbps)), targetMbpsRange: range(rows.map(row => row.targetMbps)), availableMbps: mean(rows.map(row => row.availableMbps)), qp: mean(rows.map(row => row.qp)), encodeMs: mean(rows.map(row => row.encodeMs)), loss: rows.reduce((n, row) => n + (row.lossDelta ?? 0), 0), sizes: [...new Set(rows.map(row => `${row.width}x${row.height}`))], visibility: [...new Set(rows.map(row => row.visibility))] });
const steady = data.samples.filter(row => row.elapsedSeconds >= 5);
const motion = data.steps ? steady.filter(row => row.elapsedSeconds % 30 >= 9 && row.elapsedSeconds % 30 < 29) : steady;
const summary = { runtime: data.runtime, browser: data.browser, input: data.input, bitrate: data.bitrate, snapshots: data.snapshots, sampledSeconds: data.sampledSeconds, errors: data.errors, observerError: data.observerError, failure: data.failure, stopped: data.stopped,
  all: summarize(steady), motion: summarize(motion), phases: Object.fromEntries(['foreground', 'background-test', 'window-minimized', 'foreground-restored'].map(phase => [phase, summarize(motion.filter(row => row.testPhase === phase))])),
  motionKinds: data.largePan ? Object.fromEntries([['horizontal-pan',0,30],['diagonal-pan',30,60],['fast-scroll',60,90]].map(([kind,start,end]) => [kind,summarize(steady.filter(row => { const time = data.motionCycleSeconds ? row.elapsedSeconds % data.motionCycleSeconds : row.elapsedSeconds; return time >= start && time < end; }))])) : undefined,
  trendSegments: data.sampledSeconds >= 180 ? Object.fromEntries([['first30',5,30],['middle30',data.sampledSeconds/2-15,data.sampledSeconds/2+15],['last30',data.sampledSeconds-30,data.sampledSeconds]].map(([label,start,end]) => [label,{ rangeSeconds:[start,end], ...summarize(steady.filter(row => row.elapsedSeconds >= start && row.elapsedSeconds < end)) }])) : undefined,
  repeatedHorizontal: data.largePan && data.sampledSeconds >= 180 ? Object.fromEntries(Array.from({length:Math.floor(data.sampledSeconds/90)+1},(_,i)=>i*90).filter(start=>start+30<=data.sampledSeconds).map(start=>[`${start}-${start+30}s`,summarize(steady.filter(row=>row.elapsedSeconds>=Math.max(5,start)&&row.elapsedSeconds<start+30))])) : undefined,
  codecs: [...new Set(steady.map(row => row.codec))], lastPacing: data.samples.at(-1)?.pacing };
await writeFile(path.replace(/\.json$/, '.webview-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
