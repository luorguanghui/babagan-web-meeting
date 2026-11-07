/**
 * Chromium otherwise starts probing against a default 5Mbps maximum even when
 * the RTP sender has a higher per-viewer cap. These are startup/maximum hints,
 * never a minimum rate; congestion control and sender budgets remain active.
 */
export function withNativeScreenBitrateHints(sdp: string, maxBitrate: number): string {
  if (!Number.isFinite(maxBitrate) || maxBitrate < 1000 || maxBitrate > 40_000_000) return sdp;
  const kbps = Math.floor(maxBitrate / 1000);
  const ending = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const result: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (!lines[index].startsWith('m=')) { result.push(lines[index++]); continue; }
    const start = index++;
    while (index < lines.length && !lines[index].startsWith('m=')) index++;
    const section = lines.slice(start, index);
    if (!/^m=video\s+(?!0(?:\s|\/))\d+\s/.test(section[0])) { result.push(...section); continue; }
    const payloads = new Set(section[0].split(/\s+/).slice(3));
    const codecs = new Set(section.flatMap(line => {
      const match = /^a=rtpmap:(\d+)\s+(H264|AV1|VP8|VP9)\/90000(?:\s|$)/i.exec(line);
      return match && payloads.has(match[1]) ? [match[1]] : [];
    }));
    const configured = new Set<string>();
    const hints = `x-google-start-bitrate=${kbps};x-google-max-bitrate=${kbps}`;
    const updated = section.map(line => {
      const match = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
      if (!match || !codecs.has(match[1])) return line;
      configured.add(match[1]);
      const params = match[2].split(';').map(value => value.trim()).filter(value => value && !/^x-google-(start|max)-bitrate\s*=/i.test(value));
      return `a=fmtp:${match[1]} ${[...params, hints].join(';')}`;
    });
    for (const line of updated) {
      result.push(line);
      const match = /^a=rtpmap:(\d+)\s/.exec(line);
      if (match && codecs.has(match[1]) && !configured.has(match[1])) result.push(`a=fmtp:${match[1]} ${hints}`);
    }
  }
  return result.join(ending);
}
