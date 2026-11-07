import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { createNativeCaptureServer, type NativeCaptureServer } from './server.js';

const servers: NativeCaptureServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function server(options: Parameters<typeof createNativeCaptureServer>[0] = {}) {
  const helper = await createNativeCaptureServer({ idleTimeoutMs: 10_000, getActiveDisplayCount: async () => 1, ...options });
  servers.push(helper);
  return helper;
}
async function connect(helper: NativeCaptureServer) {
  const socket = new WebSocket(`ws://127.0.0.1:${helper.port}/frames`, ['babagan-native-v1', `auth.${helper.token}`], { origin: helper.origin });
  sockets.push(socket);
  const messages: { binary: boolean; data: Buffer }[] = [];
  socket.on('message', (data: RawData, binary) => messages.push({ binary, data: Buffer.from(data as Buffer) }));
  await once(socket, 'open');
  return { socket, messages };
}
async function waitFor(predicate: () => boolean, timeout = 2500): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for native helper');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('loopback capture capability server', () => {
  it('requires exact origin, path, protocol and unguessable capability before upgrade', async () => {
    const helper = await server();
    expect(helper.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const [path, origin, protocols] of [
      ['/frames', 'https://evil.example', ['babagan-native-v1', `auth.${helper.token}`]],
      ['/frames', helper.origin, ['babagan-native-v1', 'auth.invalid']],
      ['/frames', helper.origin, [`auth.${helper.token}`]],
      ['/frames?token=unused', helper.origin, ['babagan-native-v1', `auth.${helper.token}`]],
      ['/other', helper.origin, ['babagan-native-v1', `auth.${helper.token}`]]
    ] as const) {
      const rejected = await new Promise<number | undefined>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${helper.port}${path}`, [...protocols], { origin });
        socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); socket.terminate(); });
        socket.on('error', () => {});
        socket.on('open', () => { socket.terminate(); reject(new Error('Unauthorized upgrade succeeded')); });
      });
      expect(rejected).toBe(403);
    }
    const client = await connect(helper);
    expect(client.socket.protocol).toBe('babagan-native-v1');
    expect(helper.launchUrl).toBe(`https://meet.babagan.cloud/#nativeCapture=1.${helper.port}.${helper.token}`);
  });

  it('waits for explicit start, sends format before a correctly framed packet, and stops owned process on disconnect', async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const helper = await server({ spawnProcess: () => child = spawn(process.execPath, ['-e',
      "process.stderr.write('[Parsed_showinfo_7 @ 1] n:0 pts:0 pts_time:0 pos:-1\\n');process.stdout.write('YUV4MPEG2 W4 H2 F120:1 Ip C420mpeg2\\nFRAME\\nabcdefghijkl');setInterval(()=>{},1000);"
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    const { socket, messages } = await connect(helper);
    expect(child).toBeUndefined();
    socket.send(JSON.stringify({ type: 'start', frameRate: 60 }));
    await waitFor(() => messages.some((message) => message.binary));
    expect(JSON.parse(messages[0].data.toString())).toEqual({ type: 'format', format: 'I420', width: 4, height: 2, frameRate: 60 });
    const packet = messages.find((message) => message.binary)!.data;
    expect(packet.length).toBe(28);
    expect(packet.readUInt32BE(0)).toBe(0x424e4331);
    expect(packet.readUInt32BE(4)).toBe(0);
    expect(Math.abs(packet.readDoubleBE(8) - Date.now() * 1000)).toBeLessThan(1_000_000);
    expect(packet.subarray(16).toString()).toBe('abcdefghijkl');
    const childClosed = once(child!, 'close');
    socket.close();
    await childClosed;
    expect(child!.signalCode !== null || child!.exitCode !== null).toBe(true);
  });

  it('contains malformed controls, serializes capture ownership, and permits restart after stop', async () => {
    const helper = await server({ spawnProcess: () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    const first = await connect(helper);
    const second = await connect(helper);
    first.socket.send('null');
    first.socket.send('{');
    first.socket.send(JSON.stringify({ type: 'start', frameRate: 120 }));
    await waitFor(() => first.messages.length === 3);
    expect(first.messages.map(({ data }) => JSON.parse(data.toString()).code)).toEqual(['invalid_control', 'invalid_control', 'invalid_control']);
    first.socket.send(JSON.stringify({ type: 'start', frameRate: 60 }));
    second.socket.send(JSON.stringify({ type: 'start', frameRate: 30 }));
    await waitFor(() => second.messages.length > 0);
    expect(JSON.parse(second.messages[0].data.toString()).code).toBe('capture_busy');
    first.socket.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => first.messages.some(({ data }) => JSON.parse(data.toString()).type === 'stopped'));
    second.socket.send(JSON.stringify({ type: 'start', frameRate: 30 }));
    second.socket.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => second.messages.some(({ data }) => JSON.parse(data.toString()).type === 'stopped'));
    expect(second.messages.filter(({ data }) => JSON.parse(data.toString()).code === 'capture_busy')).toHaveLength(1);
  });

  it('exits when idle and rejects unsafe configuration before listening', async () => {
    await expect(createNativeCaptureServer({ origin: 'https://meet.babagan.cloud/path' })).rejects.toThrow(/origin/i);
    await expect(createNativeCaptureServer({ origin: 'http://public.example' })).rejects.toThrow(/origin/i);
    const helper = await server({ idleTimeoutMs: 30 });
    await helper.closed;
  });
});
