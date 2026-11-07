/* global process, console, URL */
import { createRequire } from 'node:module';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const webRequire=createRequire(resolve(root,'apps/web/package.json'));
const viteRequire=createRequire(webRequire.resolve('vite/package.json'));
const {build}=await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
const outputRoot=resolve(root,'output');
const destination=resolve(outputRoot,process.argv[2]??'native-meeting');
const child=relative(outputRoot,destination);
if(!child||child.startsWith('..')||isAbsolute(child))throw new Error('Package destination must be inside this repository output directory.');
await mkdir(resolve(destination,'apps/native-capture/dist'),{recursive:true});await mkdir(resolve(destination,'scripts'),{recursive:true});
const cli=resolve(destination,'apps/native-capture/dist/cli.js');
await build({entryPoints:[resolve(root,'apps/native-capture/src/cli.ts')],outfile:cli,bundle:true,platform:'node',format:'esm',target:'node24',
 banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'},logLevel:'warning'});
await writeFile(resolve(destination,'package.json'),JSON.stringify({private:true,type:'module',engines:{node:'>=24 <25'}},null,2)+'\n');
for(const file of ['start-native-meeting.cmd','start-native-meeting.ps1'])await copyFile(resolve(root,'scripts',file),resolve(destination,'scripts',file));
await writeFile(resolve(destination,'启动本机共享.cmd'),'@echo off\r\ncall "%~dp0scripts\\start-native-meeting.cmd" %*\r\n');
await copyFile(resolve(root,'docs/runbooks/native-capture-user-guide.md'),resolve(destination,'使用说明.md'));
await copyFile(resolve(root,'apps/native-capture/node_modules/ws/LICENSE'),resolve(destination,'LICENSE-ws.txt'));
await copyFile(resolve(root,'packages/contracts/node_modules/@sinclair/typebox/license'),resolve(destination,'LICENSE-typebox.txt'));
const bytes=await readFile(cli);await writeFile(resolve(destination,'manifest.json'),JSON.stringify({schema:1,entry:'apps/native-capture/dist/cli.js',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),externalDependencies:['Node.js 24','FFmpeg ddagrab with dup_frames option','Microsoft Edge','PowerShell 7']},null,2)+'\n');
console.log(`Native package prepared: ${destination}`);
