import { describe, expect, it } from 'vitest';
import { FrameClock, type TimedFrame } from './timestamps.js';

describe('FFmpeg PTS clock', () => {
  it('pairs stderr and pixels arriving in either order and preserves PTS timing across delivery jitter', () => {
    const frames: TimedFrame[] = [];
    let now = 1_700_000_000_000;
    const clock = new FrameClock((frame) => frames.push(frame), () => now);
    clock.pushFrame(Buffer.from('first'), 0);
    clock.pushStderr(Buffer.from('[Parsed_showinfo_7 @ 1] n:   0 pts: 1000000 pts_time:1 '));
    clock.pushStderr(Buffer.from('pos: -1\n[Parsed_showinfo_7 @ 1] color_range:tv\n'));
    now += 500;
    clock.pushStderr(Buffer.from('[Parsed_showinfo_7 @ 1] n:   1 pts: 1016667 pts_time:1.016667 pos: -1\n'));
    clock.pushFrame(Buffer.from('second'), 1);
    clock.finish();
    expect(frames.map(({ frame, index, captureUs }) => [frame.toString(), index, captureUs])).toEqual([
      ['first', 0, 1_700_000_000_000_000], ['second', 1, 1_700_000_000_016_667]
    ]);
  });

  it('rejects lost synchronization instead of accumulating frames without timestamps', () => {
    const clock = new FrameClock(() => {});
    expect(() => {
      for (let i = 0; i < 9; i++) clock.pushFrame(Buffer.alloc(12), i);
    }).toThrow(/synchronization/i);
  });

  it('rejects duplicate or nonmonotonic PTS and unfinished pairs', () => {
    const clock = new FrameClock(() => {});
    clock.pushStderr(Buffer.from('[Parsed_showinfo_7 @ 1] n: 0 pts: 2 pts_time:2 pos: -1\n'));
    clock.pushFrame(Buffer.alloc(12), 0);
    expect(() => clock.pushStderr(Buffer.from('[Parsed_showinfo_7 @ 1] n: 1 pts: 1 pts_time:1 pos: -1\n'))).toThrow(/timestamp/i);
    const unfinished = new FrameClock(() => {});
    unfinished.pushFrame(Buffer.alloc(12), 0);
    expect(() => unfinished.finish()).toThrow(/synchronization/i);
  });

  it('bounds stderr lines even when FFmpeg emits no newline', () => {
    const clock = new FrameClock(() => {});
    expect(() => clock.pushStderr(Buffer.alloc(16_385, 65))).toThrow(/stderr/i);
  });

  it('uses integer PTS and time base so long meetings do not lose precision in rounded pts_time text', () => {
    const times: number[] = [];
    const clock = new FrameClock(({ captureUs }) => times.push(captureUs), () => 1_700_000_000_000);
    clock.pushStderr(Buffer.from('[Parsed_showinfo_7 @ 1] config in time_base: 1/1000000, frame_rate: 120/1\n'));
    clock.pushFrame(Buffer.alloc(12), 0);
    clock.pushStderr(Buffer.from('[Parsed_showinfo_7 @ 1] n: 0 pts: 90000000000 pts_time:90000 pos: -1\n'));
    clock.pushFrame(Buffer.alloc(12), 1);
    clock.pushStderr(Buffer.from('[Parsed_showinfo_7 @ 1] n: 1 pts: 90000016667 pts_time:90000 pos: -1\n'));
    expect(times).toEqual([1_700_000_000_000_000, 1_700_000_000_016_667]);
  });
});
