export type H264Profile = 'baseline' | 'constrainedBaseline' | 'main' | 'high' | 'constrainedHigh' | 'predictiveHigh444';

/** RFC 6184 profile_idc + constraint flags; a profile does not identify the encoder hardware. */
export function describeH264Profile(value: string): { profile: H264Profile; level: string } | undefined {
  if (!/^[0-9a-f]{6}$/i.test(value)) return undefined;
  const idc = parseInt(value.slice(0, 2), 16);
  const flags = parseInt(value.slice(2, 4), 16);
  const levelIdc = parseInt(value.slice(4), 16);
  if (![10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52].includes(levelIdc)) return undefined;
  let profile: H264Profile | undefined;
  if ((idc === 0x42 && (flags & 0x4f) === 0x40)
    || (idc === 0x4d && (flags & 0x8f) === 0x80)
    || (idc === 0x58 && (flags & 0xcf) === 0xc0)) profile = 'constrainedBaseline';
  else if ((idc === 0x42 && (flags & 0x4f) === 0)
    || (idc === 0x58 && (flags & 0xcf) === 0x80)) profile = 'baseline';
  else if (idc === 0x4d && (flags & 0xaf) === 0) profile = 'main';
  else if (idc === 0x64 && flags === 0) profile = 'high';
  else if (idc === 0x64 && flags === 0x0c) profile = 'constrainedHigh';
  else if (idc === 0xf4 && flags === 0) profile = 'predictiveHigh444';
  if (!profile) return undefined;
  const level = levelIdc === 11 && (flags & 0x10) !== 0 ? '1b'
    : levelIdc % 10 === 0 ? String(levelIdc / 10) : `${Math.floor(levelIdc / 10)}.${levelIdc % 10}`;
  return { profile, level };
}
