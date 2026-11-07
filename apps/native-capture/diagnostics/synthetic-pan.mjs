// Pure synthetic chart motion. A cached image is cropped anew at 120 Hz; the
// production selector samples 60 different viewport images rather than cloning frames.
export function panArguments(base, source, realtime = true) {
  const args = [...base];
  const input = args.indexOf('-i');
  if (input < 2 || args[input - 1] !== 'lavfi') throw new Error('Unexpected capture input');
  args[input - 1] = 'image2'; args[input + 1] = source;
  args.splice(input, 0, '-framerate', '120');
  const filter = args.indexOf('-vf') + 1;
  const x = "mod(if(lt(mod(t,90),30),n*10,if(lt(mod(t,90),60),n*14,480))+if(lt(mod(t,15),12),0,1000),2176)";
  const y = "mod(if(lt(mod(t,90),30),500,if(lt(mod(t,90),60),n*8,n*18))+if(lt(mod(t,15),12),0,550),1224)";
  const motion = `loop=loop=-1:size=1:start=0,crop=1920:1080:x='${x}':y='${y}',hflip=enable='gte(mod(t,15),12)',${realtime ? 'realtime,' : ''}`;
  args[filter] = args[filter].replace('hwdownload,format=bgra,', motion);
  return args;
}
