/* global Buffer, console, URL */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const input = new URL('../apps/web/node_modules/@libav.js/variant-vp8-opus/dist/', import.meta.url);
const output = new URL('../artifacts/screen-codecs/libav-6.10.9/', import.meta.url);
await mkdir(output, { recursive: true });
const names = ['libav-6.10.9.0-vp8-opus.mjs', 'libav-6.10.9.0-vp8-opus.wasm.mjs', 'libav-6.10.9.0-vp8-opus.wasm.wasm',
  'libav-6.10.9.0-vp8-opus.thr.mjs', 'libav-6.10.9.0-vp8-opus.thr.wasm'];
const artifacts = {};
for (const name of names) {
  let data = await readFile(new URL(name, input));
  if (name.endsWith('.thr.mjs')) {
    const source = data.toString('utf8');
    const anchor = 'var CAccessors={};';
    if (source.split(anchor).length !== 2) throw new Error('libav threaded binding patch does not match pinned build');
    // The prebuilt pthread module executes JS postamble before thread-side
    // WASM exports are ready. Numeric cwrap bindings otherwise cache undefined.
    // Resolve at first invocation, after WASM thread initialization.
    data = Buffer.from(source.replace(anchor,
      'var screenOriginalCwrap=Module.cwrap;Module.cwrap=function(){var binding=Array.from(arguments);return function(){return screenOriginalCwrap.apply(Module,binding).apply(null,arguments)}};' + anchor));
  }
  await writeFile(new URL(name, output), data);
  artifacts[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
await copyFile(new URL('libav.types.d.ts', input), new URL('libav.types.d.ts', output));
await writeFile(new URL('manifest.json', output), JSON.stringify({ package: '@libav.js/variant-vp8-opus', version: '6.10.9',
  sourceCommit: 'c80e885c3461f7bb7ea565c9631b34243ae0dbf1',
  modifications: 'Delay cwrap resolution until invocation in pthread postamble. See scripts/prepare-libav-codecs.mjs.',
  releaseReady: false, sourcesNotice: 'Complete corresponding sources must be included before distributing this build.', artifacts }, null, 2) + '\n');
console.log('Prepared pinned libav assets for local benchmark (not release-ready sources)');
