// Controlled testsrc2 input only: never captures a desktop, window, camera or microphone.
/* global process, console, setTimeout, clearTimeout, window, document, URL */
import {fork,spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {createNativeCaptureServer} from '../dist/server.js';
import {edgeLaunchArguments} from '../dist/cli.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const ffmpeg=process.env.BABAGAN_TEST_FFMPEG;
if(!ffmpeg)throw new Error('Set BABAGAN_TEST_FFMPEG to a trusted FFmpeg executable. Only synthetic input is used.');
const origin='http://127.0.0.1:5188';
const steps=process.argv.includes('--steps');
const idleGap=process.argv.includes('--idle-gap');
if(process.argv.includes('--helper')){
 const helper=await createNativeCaptureServer({ffmpeg,origin,idleTimeoutMs:300000,getActiveDisplayCount:async()=>1,
  spawnProcess:(exe,args)=>{const actual=[...args],input=actual.indexOf('-i');actual[input+1]=steps?"color=black:size=1920x1080:rate=120[bg];testsrc2=size=1920x1080:rate=120[fg];[bg][fg]overlay=shortest=1:enable='gte(mod(t,30),8)'":'testsrc2=size=1920x1080:rate=120';actual.splice(input,0,'-re');const vf=actual.indexOf('-vf')+1;actual[vf]=actual[vf].replace('hwdownload,format=bgra,','');if(idleGap)actual[vf]=actual[vf].replace('showinfo=checksum=0',"select='eq(n,0)+gte(t,35)',showinfo=checksum=0");return spawn(exe,actual,{windowsHide:true,stdio:['pipe','pipe','pipe']});}});
 process.send?.({port:helper.port,token:helper.token});const stop=()=>void helper.close().then(()=>process.exit(0));process.once('message',stop);process.once('disconnect',stop);process.once('SIGTERM',stop);
}else{
 const {chromium}=await import('../../web/node_modules/@playwright/test/index.mjs');
 const {createServer}=await import('../../web/node_modules/vite/dist/node/index.js');
 const out=resolve(root,'output/native-validation');await mkdir(out,{recursive:true});
 const duration=Number(process.argv.find(a=>a.startsWith('--seconds='))?.slice(10)||180);
 if(!Number.isFinite(duration)||duration<10||duration>600)throw new Error('Test duration must be 10–600 seconds.');
 const name=(idleGap?'acquisition-idle-gap':steps?'scene-steps':'continuous')+`-${duration}s-`+new Date().toISOString().replace(/[:.]/g,'-')+(process.argv.includes('--headed')?'-headed':'');
 const vite=await createServer({root,configFile:false,resolve:{alias:{'@meeting/contracts':resolve(root,'packages/contracts/src/index.ts')}},server:{host:'127.0.0.1',port:5188,strictPort:true,hmr:false,headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}});await vite.listen();
 const child=fork(fileURLToPath(import.meta.url),['--helper',...(steps?['--steps']:[]),...(idleGap?['--idle-gap']:[])],{stdio:['ignore','ignore','pipe','ipc']});let browser,page;
 try{
  const config=await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Synthetic helper startup timed out')),10000);child.once('message',m=>{clearTimeout(deadline);resolve(m);});child.once('error',reject);child.once('exit',()=>reject(new Error('Synthetic helper exited')));});
  const flags=edgeLaunchArguments('unused',origin).filter(a=>a.startsWith('--')&&!a.startsWith('--user-data-dir')&&a!=='--new-window');
  browser=await chromium.launch({channel:'msedge',headless:!process.argv.includes('--headed'),args:flags});const context=await browser.newContext({viewport:{width:1280,height:720}});page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/apps/native-capture/diagnostics/browser-pipeline.html#nativeCapture=1.${config.port}.${config.token}`);
  await page.getByRole('button',{name:'Start synthetic share'}).click();await page.waitForFunction(()=>window.ready||window.failure,{timeout:25000});const failure=await page.evaluate(()=>window.failure);if(failure)throw new Error(failure);
  let other;
  for(let elapsed=0;elapsed<duration;elapsed+=10){
   if(elapsed===60){other=await context.newPage();await other.setContent('<title>Secondary test tab</title><p>Only synthetic video is running in the other test tab.</p>');await other.bringToFront();await page.evaluate(()=>window.testPhase='other-tab-active');}
   if(elapsed===120){await page.bringToFront();await page.evaluate(()=>window.testPhase='foreground-restored');}
   await new Promise(r=>setTimeout(r,10000));const data=await page.evaluate(()=>({samples:window.samples,observerError:window.observerError}));
   await writeFile(resolve(out,`${name}.json`),JSON.stringify({browser:browser.version(),steps,idleGap,errors,...data},null,2));console.log(JSON.stringify({elapsed:elapsed+10,last:data.samples.at(-1)}));
   if(elapsed===10){const png=await page.evaluate(()=>{const video=document.querySelector('video'),canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);return canvas.toDataURL('image/png').split(',')[1];});await writeFile(resolve(out,`${name}.decoded.png`),Buffer.from(png,'base64'));}
  }
  await page.getByRole('button',{name:'Stop',exact:true}).click();await page.waitForFunction(()=>window.stopped);
 }finally{
  await browser?.close();
  if(child.exitCode===null){await new Promise(r=>{const timeout=setTimeout(()=>{child.kill();r();},5000);child.once('exit',()=>{clearTimeout(timeout);r();});if(child.connected)child.send('stop');else child.kill();});}
  await vite.close();
 }
}
