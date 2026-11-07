import { describe, expect, it } from 'vitest';
import { Y4mParser } from './y4m.js';

describe('bounded Y4M decoding', () => {
  it('reassembles fragmented I420 frames without confusing pixel bytes with delimiters', () => {
    const frames: Buffer[] = [];
    const formats: unknown[] = [];
    const parser = new Y4mParser({ onFormat: (format) => formats.push(format), onFrame: (frame) => frames.push(frame) });
    const input = Buffer.concat([
      Buffer.from('YUV4MPEG2 W4 H2 F60:1 Ip A1:1 C420mpeg2 XYSCSS=420MPEG2\nFRAME\n'),
      Buffer.from('FRAME\n123456'), Buffer.from('FRAME\nabcdefghijkl')
    ]);
    for (let i = 0; i < input.length; i += 3) parser.push(input.subarray(i, i + 3));
    parser.finish();
    expect(formats).toEqual([{ width: 4, height: 2 }]);
    expect(frames.map((frame) => frame.toString())).toEqual(['FRAME\n123456', 'abcdefghijkl']);
  });

  it.each([
    'YUV4MPEG2 W3 H2 F60:1 Ip C420mpeg2\n',
    'YUV4MPEG2 W100000 H100000 F60:1 Ip C420mpeg2\n',
    'YUV4MPEG2 W4 H2 F60:1 Ip C444\n',
    'YUV4MPEG2 W4 H2 F60:1 It C420mpeg2\n',
    'YUV4MPEG2 W4 H2 F60:1 Ip C420p10\n',
    'YUV4MPEG2 W4 W6 H2 F60:1 Ip C420mpeg2\n',
    'YUV4MPEG2 W4 H2 F60:1 Ip C420mpeg2 XCOLORRANGE=FULL\n'
  ])('rejects unsupported or unsafe header %s before allocating a frame', (header) => {
    const parser = new Y4mParser({ onFormat() {}, onFrame() {} });
    expect(() => parser.push(Buffer.from(header))).toThrow();
  });

  it('rejects unbounded headers and truncated streams rather than resynchronizing', () => {
    const long = new Y4mParser({ onFormat() {}, onFrame() {} });
    expect(() => long.push(Buffer.alloc(4097, 65))).toThrow(/header/i);
    const short = new Y4mParser({ onFormat() {}, onFrame() {} });
    short.push(Buffer.from('YUV4MPEG2 W4 H2 F60:1 Ip C420mpeg2\nFRAME\n123'));
    expect(() => short.finish()).toThrow(/truncated/i);
  });
});
