import { describe, expect, it } from 'vitest';

import { parseClientMeetingInput } from './client-meeting-input.js';

const origin = 'https://meet.babagan.cloud';
const slug = 'WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG';
const expected = { slug, path: `/m/${slug}` };

describe('client meeting input', () => {
  it('turns IDs and either trusted room route into the existing local lobby path', () => {
    for (const value of [slug, `  ${slug}\n`, `/m/${slug}`, `/meetings/${slug}/`, `${origin}/m/${slug}`, `${origin}/meetings/${slug}`]) {
      expect(parseClientMeetingInput(value, origin)).toEqual(expected);
    }
    expect(parseClientMeetingInput('a'.repeat(22), origin)?.slug).toHaveLength(22);
    expect(parseClientMeetingInput('a'.repeat(256), origin)?.slug).toHaveLength(256);
    expect(parseClientMeetingInput('a'.repeat(21), origin)).toBeUndefined();
    expect(parseClientMeetingInput('a'.repeat(257), origin)).toBeUndefined();
  });

  it('rejects external navigation, credentials and unsupported protocols', () => {
    for (const value of [
      `https://evil.example/m/${slug}`, `https://meet.babagan.cloud.evil.example/m/${slug}`,
      `http://meet.babagan.cloud/m/${slug}`, `https://meet.babagan.cloud:444/m/${slug}`,
      `//meet.babagan.cloud/m/${slug}`, `https://user@meet.babagan.cloud/m/${slug}`,
      `https://meet.babagan.cloud@evil.example/m/${slug}`, `javascript:alert(1)`,
      `file:///m/${slug}`, `data:text/html,${slug}`, `intent://m/${slug}`,
    ]) expect(parseClientMeetingInput(value, origin)).toBeUndefined();
  });

  it('rejects path-normalization tricks and never propagates query or fragment capabilities', () => {
    for (const value of [
      `${origin}/wrong/../m/${slug}`, `${origin}/%2e%2e/m/${slug}`,
      `${origin}\\m\\${slug}`, `/m/${slug}%2fother`, `/m/%57${slug.slice(1)}`,
      `/m/${slug}/other`, `/create`, `/m/${slug}?next=https://evil.example`,
      `${origin}/m/${slug}#nativeCapture=1.5555.secret`, `${origin}/m/${slug}?`,
      `${origin}/m/${slug}#`, `${origin}/m/\t${slug}`, `/m/${slug}\u0000`, '', ' '.repeat(4),
    ]) expect(parseClientMeetingInput(value, origin)).toBeUndefined();
  });

  it('allows current loopback development origins without trusting arbitrary HTTP hosts', () => {
    for (const local of ['http://127.0.0.1:5188', 'http://localhost:5173', 'http://[::1]:5173']) {
      expect(parseClientMeetingInput(`${local}/m/${slug}`, local)).toEqual(expected);
    }
    expect(parseClientMeetingInput(`${origin}/m/${slug}`, 'http://localhost:5173')).toBeUndefined();
    expect(parseClientMeetingInput(slug, 'http://example.test')).toBeUndefined();
    expect(parseClientMeetingInput(slug, `${origin}/unexpected`)).toBeUndefined();
    expect(parseClientMeetingInput(slug, `${origin}/`)).toBeUndefined();
    expect(parseClientMeetingInput(slug, 'not-an-origin')).toBeUndefined();
  });
});
