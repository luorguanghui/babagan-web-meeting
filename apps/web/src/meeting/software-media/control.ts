import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const generation = Type.Integer({ minimum: 0, maximum: 0xffffffff });
const dimension = Type.Integer({ minimum: 16, maximum: 3840 });
const object = <T extends Record<string, import('@sinclair/typebox').TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const schema = Type.Union([
  object({ type: Type.Literal('hello'), version: Type.Literal(1), codecs: Type.Array(Type.Union([Type.Literal('h264'), Type.Literal('vp8')]), { maxItems: 2, uniqueItems: true }), audio: Type.Boolean() }),
  object({ type: Type.Literal('config'), generation, codec: Type.String({ pattern: '^(vp8|avc1\\.[0-9a-fA-F]{6})$' }), width: dimension,
    height: Type.Integer({ minimum: 16, maximum: 2160 }), audio: Type.Boolean() }),
  object({ type: Type.Literal('keyframe'), generation }),
  object({ type: Type.Literal('ready'), generation }),
  object({ type: Type.Literal('feedback'), generation, decodedFrames: count, receivedBytes: count }),
  object({ type: Type.Literal('stats'), generation, rawFrames: count, encodedFrames: count, encodedBytes: count,
    queueDrops: count, expiredDrops: count, encodeMs: Type.Number({ minimum: 0, maximum: 1000000 }),
    filter: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(4), Type.Literal(8)]), width: dimension,
    height: Type.Integer({ minimum: 16, maximum: 2160 }) }),
  object({ type: Type.Literal('error'), message: Type.String({ minLength: 1, maxLength: 512 }) })
]);
export type ControlMessage = Static<typeof schema>;
export function parseControl(raw: string): ControlMessage {
  if (raw.length > 16384) throw new Error('Control message too large');
  const message: unknown = JSON.parse(raw);
  if (!Value.Check(schema, message)) throw new Error('Invalid project media control');
  if (message.type === 'config' && ((message.width & 1) || (message.height & 1))) throw new Error('Invalid decoder dimensions');
  return message;
}
