#!/usr/bin/env node
/* global console */
import { readFileSync } from 'node:fs';
import process from 'node:process';

function usage() {
  console.error('Usage: node scripts/collect-webrtc-stats.mjs STATS.ndjson');
  process.exit(64);
}

if (process.argv.length !== 3) usage();

const rows = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid JSON on line ${index + 1}.`); }
  });

if (rows.length === 0) throw new Error('No WebRTC statistics were recorded.');

const totals = {
  samples: rows.length,
  connections: 0,
  inboundPackets: 0,
  inboundPacketsLost: 0,
  outboundPackets: 0,
  outboundPacketsLost: 0,
  availableOutgoingBitrate: []
};

for (const row of rows) {
  for (const connection of row.connections ?? []) {
    totals.connections += 1;
    for (const stat of connection.stats ?? []) {
      if (stat.type === 'inbound-rtp') {
        totals.inboundPackets += Number(stat.packetsReceived ?? 0);
        totals.inboundPacketsLost += Number(stat.packetsLost ?? 0);
      }
      if (stat.type === 'outbound-rtp') {
        totals.outboundPackets += Number(stat.packetsSent ?? 0);
        totals.outboundPacketsLost += Number(stat.packetsLost ?? 0);
      }
      if (stat.type === 'candidate-pair' && stat.nominated && stat.availableOutgoingBitrate !== undefined) {
        totals.availableOutgoingBitrate.push(Number(stat.availableOutgoingBitrate));
      }
    }
  }
}

const rate = (lost, received) => received + lost === 0 ? 0 : Number((lost / (received + lost) * 100).toFixed(4));
const average = (values) => values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
console.log(JSON.stringify({
  samples: totals.samples,
  connections: totals.connections,
  packetLossPercent: {
    inbound: rate(totals.inboundPacketsLost, totals.inboundPackets),
    outbound: rate(totals.outboundPacketsLost, totals.outboundPackets)
  },
  averageAvailableOutgoingBitrate: average(totals.availableOutgoingBitrate)
}, null, 2));
