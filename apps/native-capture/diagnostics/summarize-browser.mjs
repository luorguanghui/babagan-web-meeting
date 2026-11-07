/* global process, console */
import {readFile,writeFile} from 'node:fs/promises';
const path=process.argv[2];if(!path)throw new Error('Pass the browser-pipeline JSON path.');
const data=JSON.parse(await readFile(path,'utf8'));
const mean=values=>{const v=values.filter(Number.isFinite);return v.length?Number((v.reduce((a,b)=>a+b,0)/v.length).toFixed(3)):null;};
const percentile=(values,p)=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?Number(v[Math.floor((v.length-1)*p)].toFixed(3)):null;};
function summarize(rows){return {samples:rows.length,sourceFps:mean(rows.map(r=>r.sourceFps)),encodedFps:mean(rows.map(r=>r.encodedFps)),decodedFps:mean(rows.map(r=>r.decodedFps)),encodedP05:percentile(rows.map(r=>r.encodedFps),.05),decodedP05:percentile(rows.map(r=>r.decodedFps),.05),actualMbps:mean(rows.map(r=>r.actualMbps)),targetMbps:mean(rows.map(r=>r.targetMbps)),qp:mean(rows.map(r=>r.qp)),maxPacketSendDelayMs:percentile(rows.map(r=>r.sendDelayMs),1),loss:rows.reduce((n,r)=>n+(r.lossDelta??0),0),sizes:[...new Set(rows.map(r=>`${r.width}x${r.height}`))],codecs:[...new Set(rows.map(r=>r.codec))]};}
const afterStartup=data.samples.filter(r=>r.elapsedSeconds>=5);
const motion=data.steps?afterStartup.filter(r=>r.elapsedSeconds%30>=9&&r.elapsedSeconds%30<29):afterStartup;
const transitions=data.steps?afterStartup.filter(r=>r.elapsedSeconds%30>=8&&r.elapsedSeconds%30<11):[];
const result={browser:data.browser,steps:data.steps,errors:data.errors,observerError:data.observerError,
 all:summarize(afterStartup),motion:summarize(motion),transitions:summarize(transitions),
 otherTabActiveMotion:summarize(motion.filter(r=>r.testPhase==='other-tab-active')),lastPacing:data.samples.at(-1)?.pacing,
 decodedFrameChecks:data.samples.at(-1)?.decodedChecks};
await writeFile(path.replace(/\.json$/,'.summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
