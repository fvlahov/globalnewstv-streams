#!/usr/bin/env node
// Usage: YOUTUBE_API_KEY=... node scripts/resolve.mjs [--dry-run]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveStreams, shouldWrite, validateChannels, YouTubeClient } from './lib.mjs';

const OUT_FILE = process.env.OUT_FILE ?? 'docs/streams.json';
const STATE_FILE = process.env.STATE_FILE ?? '.state/state.json';
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS ?? 6);
const dryRun = process.argv.includes('--dry-run');

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey) {
  console.error('YOUTUBE_API_KEY is not set');
  process.exit(1);
}

// A missing or corrupt cache must never break a run: it only costs a few extra quota units.
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback;
    throw e;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

const now = new Date();
const channels = validateChannels(JSON.parse(await readFile('channels.json', 'utf8')));
const previousDoc = await readJson(OUT_FILE, null);
const previousState = (await readJson(STATE_FILE, {})).state ?? {};

const client = new YouTubeClient({ apiKey });
const { streams, state } = await resolveStreams({
  channels,
  previous: { streams: previousDoc?.streams ?? [], state: previousState },
  client,
  now,
  log: console.warn,
});

const offline = channels.filter((c) => !streams.some((s) => s.channelId === c.id));
console.log(`${streams.length} live streams from ${channels.length - offline.length}/${channels.length} channels, ${client.units} quota units used`);
if (offline.length) console.log(`No live stream: ${offline.map((c) => c.name).join(', ')}`);

if (dryRun) {
  console.log('--dry-run: nothing written');
  process.exit(0);
}

await writeJson(STATE_FILE, { state });
if (shouldWrite(previousDoc, streams, now, MAX_AGE_HOURS)) {
  await writeJson(OUT_FILE, { version: 1, generatedAt: now.toISOString(), streams });
  console.log(`Wrote ${OUT_FILE}`);
} else {
  console.log(`${OUT_FILE} unchanged`);
}
