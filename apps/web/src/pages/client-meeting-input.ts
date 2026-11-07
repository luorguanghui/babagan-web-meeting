export interface ClientMeetingInput { slug: string; path: string; }

// Production IDs are base64url; retain the shared contract's 22–256 character range.
const slugPattern = /^[A-Za-z0-9_-]{22,256}$/;
const routePattern = /^\/(?:m|meetings)\/([A-Za-z0-9_-]{22,256})\/?$/;

/** Parse a room reference into a local lobby route without carrying URL capabilities. */
export function parseClientMeetingInput(value: string, trustedOrigin: string): ClientMeetingInput | undefined {
  let origin: URL;
  try { origin = new URL(trustedOrigin); } catch { return; }
  const localDevelopment = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== trustedOrigin || (origin.protocol !== 'https:' && !localDevelopment)) return;

  const input = value.trim();
  if (!input || input.length > 2048 || /[\s\\]/.test(input)
    || [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return;
  if (slugPattern.test(input)) return { slug: input, path: `/m/${input}` };

  let route = input;
  if (!input.startsWith('/')) {
    // Match the raw path before URL parsing can normalize dot segments or backslashes.
    // Search and fragment components are deliberately rejected, including empty ? / #.
    const absolute = /^https?:\/\/[^/?#]+(\/[^?#]*)$/i.exec(input);
    if (!absolute) return;
    route = absolute[1]!;
    let url: URL;
    try { url = new URL(input); } catch { return; }
    if (url.origin !== origin.origin || url.username || url.password || url.search || url.hash || url.pathname !== route) return;
  }
  const match = routePattern.exec(route);
  if (!match) return;
  const slug = match[1]!;
  return { slug, path: `/m/${slug}` };
}
