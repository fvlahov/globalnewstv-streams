import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chunk,
  resolveStreams,
  shouldWrite,
  toStream,
  uploadsPlaylistId,
  validateChannels,
  YouTubeClient,
} from '../scripts/lib.mjs';

const NOW = new Date('2026-10-05T12:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

const chan = (n, extra = {}) => ({
  id: `UC${String(n).padStart(22, '0')}`,
  name: `Channel ${n}`,
  country: 'GB',
  language: 'en',
  category: 'general',
  ...extra,
});

const video = (id, channel, over = {}) => ({
  id,
  snippet: {
    liveBroadcastContent: 'live',
    channelId: channel.id,
    channelTitle: channel.name,
    title: `Live ${id}`,
    description: 'desc',
    thumbnails: { default: { url: 'd' }, medium: { url: 'm' }, high: { url: 'h' }, maxres: { url: 'x' } },
  },
  status: { embeddable: true, privacyStatus: 'public', madeForKids: false },
  liveStreamingDetails: { concurrentViewers: '100', actualStartTime: '2026-10-05T00:00:00Z' },
  contentDetails: {},
  ...over,
});

/** Fake client that records every call so tests can assert on quota-relevant behaviour. */
function fakeClient({ videos = [], uploads = {}, search = {} }) {
  const calls = { videos: [], uploads: [], search: [] };
  return {
    calls,
    async videos(ids) {
      calls.videos.push(ids);
      return videos.filter((v) => ids.includes(v.id));
    },
    async uploadVideoIds(channelId) {
      calls.uploads.push(channelId);
      return uploads[channelId] ?? [];
    },
    async searchLiveVideoIds(channelId) {
      calls.search.push(channelId);
      return search[channelId] ?? [];
    },
  };
}

describe('toStream', () => {
  const c = chan(1);
  it('maps a live public embeddable video', () => {
    const s = toStream(video('v1', c), c);
    assert.equal(s.videoId, 'v1');
    assert.equal(s.concurrentViewers, 100);
    assert.deepEqual(Object.keys(s.thumbnails), ['default', 'medium', 'high']);
  });
  it('rejects videos that must not be shown', () => {
    const bad = (patch) => toStream(video('v', c, patch), c);
    assert.equal(bad({ snippet: { ...video('v', c).snippet, liveBroadcastContent: 'none' } }), null);
    assert.equal(bad({ snippet: { ...video('v', c).snippet, liveBroadcastContent: 'upcoming' } }), null);
    assert.equal(bad({ status: { embeddable: false, privacyStatus: 'public' } }), null);
    assert.equal(bad({ status: { embeddable: true, privacyStatus: 'unlisted' } }), null);
    assert.equal(bad({ status: { embeddable: true, privacyStatus: 'public', madeForKids: true } }), null);
    assert.equal(toStream(video('v', c), chan(2)), null); // belongs to another channel
  });
});

describe('resolveStreams', () => {
  it('discovers live streams from uploads and ignores the rest', async () => {
    const c = chan(1);
    const client = fakeClient({
      videos: [
        video('live', c),
        video('ended', c, { snippet: { ...video('ended', c).snippet, liveBroadcastContent: 'none' } }),
      ],
      uploads: { [c.id]: ['live', 'ended'] },
    });
    const { streams, state } = await resolveStreams({ channels: [c], client, now: NOW });
    assert.deepEqual(streams.map((s) => s.videoId), ['live']);
    assert.equal(state[c.id].checkedAt, NOW.toISOString());
    assert.equal(client.calls.videos.length, 1, 'candidates are verified in a single batch');
  });

  it('only re-verifies cached streams when no discovery is due (no playlist calls)', async () => {
    const c = chan(1);
    const client = fakeClient({ videos: [video('live', c)] });
    const previous = {
      streams: [{ videoId: 'live', channelId: c.id }],
      state: { [c.id]: { checkedAt: minutesAgo(30) } },
    };
    const { streams } = await resolveStreams({ channels: [c], previous, client, now: NOW });
    assert.deepEqual(streams.map((s) => s.videoId), ['live']);
    assert.deepEqual(client.calls.uploads, []);
  });

  it('rediscovers immediately when a stream ended', async () => {
    const c = chan(1);
    const client = fakeClient({ videos: [video('new', c)], uploads: { [c.id]: ['new'] } });
    const previous = {
      streams: [{ videoId: 'old', channelId: c.id }], // 'old' is gone from the API => not live
      state: { [c.id]: { checkedAt: minutesAgo(10) } },
    };
    const { streams } = await resolveStreams({ channels: [c], previous, client, now: NOW });
    assert.deepEqual(streams.map((s) => s.videoId), ['new']);
    assert.deepEqual(client.calls.uploads, [c.id]);
  });

  it('backs off on idle channels, then rechecks after the interval', async () => {
    const c = chan(1);
    const recent = { streams: [], state: { [c.id]: { checkedAt: minutesAgo(60) } } };
    const stale = { streams: [], state: { [c.id]: { checkedAt: minutesAgo(200) } } };

    const quiet = fakeClient({});
    await resolveStreams({ channels: [c], previous: recent, client: quiet, now: NOW });
    assert.deepEqual(quiet.calls.uploads, []);

    const due = fakeClient({});
    await resolveStreams({ channels: [c], previous: stale, client: due, now: NOW });
    assert.deepEqual(due.calls.uploads, [c.id]);
  });

  it('caps streams per channel, busiest first', async () => {
    const c = chan(1);
    const vids = ['a', 'b', 'c', 'd'].map((id, i) =>
      video(id, c, { liveStreamingDetails: { concurrentViewers: String(10 * (i + 1)) } }),
    );
    const client = fakeClient({ videos: vids, uploads: { [c.id]: ['a', 'b', 'c', 'd'] } });
    const { streams } = await resolveStreams({ channels: [c], client, now: NOW });
    assert.deepEqual(streams.map((s) => s.videoId), ['d', 'c', 'b']);
  });

  it('drops streams of channels removed from channels.json', async () => {
    const c = chan(1);
    const client = fakeClient({ videos: [video('gone', chan(2))] });
    const previous = { streams: [{ videoId: 'gone', channelId: chan(2).id }], state: {} };
    const { streams } = await resolveStreams({ channels: [c], previous, client, now: NOW });
    assert.deepEqual(streams, []);
    assert.deepEqual(client.calls.videos, [], 'nothing to verify');
  });

  it('uses search unless opted out, and not within the retry interval', async () => {
    const a = chan(1);
    const b = chan(2, { searchFallback: false }); // opted out
    const d = chan(3); // searched recently
    const client = fakeClient({ videos: [video('found', a)], search: { [a.id]: ['found'] } });
    const previous = {
      streams: [],
      state: { [d.id]: { searchedAt: minutesAgo(60) } },
    };
    const { streams, state } = await resolveStreams({ channels: [a, b, d], previous, client, now: NOW });
    assert.deepEqual(client.calls.search, [a.id]);
    assert.deepEqual(streams.map((s) => s.videoId), ['found']);
    assert.equal(state[a.id].searchedAt, NOW.toISOString());
  });

  it('respects the per-run search budget', async () => {
    const chans = [1, 2, 3].map((n) => chan(n));
    const client = fakeClient({});
    await resolveStreams({ channels: chans, client, now: NOW, options: { searchBudget: 2 } });
    assert.equal(client.calls.search.length, 2);
  });

  it('survives a non-fatal scan error but aborts on quota errors', async () => {
    const [a, b] = [chan(1), chan(2)];
    const failing = (status) => ({
      ...fakeClient({ videos: [video('ok', b)], uploads: { [b.id]: ['ok'] } }),
      async uploadVideoIds(id) {
        if (id === a.id) throw Object.assign(new Error('boom'), { status });
        return ['ok'];
      },
    });
    const warnings = [];
    const { streams, state } = await resolveStreams({
      channels: [a, b],
      client: failing(500),
      now: NOW,
      log: (m) => warnings.push(m),
    });
    assert.deepEqual(streams.map((s) => s.videoId), ['ok']);
    assert.equal(warnings.length, 1);
    assert.equal(state[a.id].checkedAt, undefined, 'failed scan is retried next run');

    await assert.rejects(resolveStreams({ channels: [a, b], client: failing(403), now: NOW }));
  });
});

describe('shouldWrite', () => {
  const s = [{ videoId: 'a', concurrentViewers: 1 }];
  const doc = (streams, hoursAgo) => ({ streams, generatedAt: new Date(NOW - hoursAgo * 3_600_000).toISOString() });

  it('writes when there is no previous file or the list changed', () => {
    assert.equal(shouldWrite(null, s, NOW, 6), true);
    assert.equal(shouldWrite(doc([{ videoId: 'b' }], 0.1), s, NOW, 6), true);
  });
  it('ignores viewer-count-only changes until the file is old enough', () => {
    assert.equal(shouldWrite(doc([{ videoId: 'a', concurrentViewers: 999 }], 1), s, NOW, 6), false);
    assert.equal(shouldWrite(doc([{ videoId: 'a', concurrentViewers: 999 }], 7), s, NOW, 6), true);
  });
});

describe('YouTubeClient', () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });

  it('sends the key as a header, never in the URL, and counts quota', async () => {
    const seen = [];
    const client = new YouTubeClient({
      apiKey: 'SECRET',
      fetchImpl: async (url, init) => (seen.push({ url, init }), ok({ items: [{ id: 'v' }] })),
    });
    await client.videos(['v']);
    assert.ok(!seen[0].url.includes('SECRET'));
    assert.equal(seen[0].init.headers['x-goog-api-key'], 'SECRET');
    assert.equal(client.units, 1);
  });

  it('treats a missing uploads playlist as empty', async () => {
    const client = new YouTubeClient({ apiKey: 'k', fetchImpl: async () => fail(404) });
    assert.deepEqual(await client.uploadVideoIds('UC' + 'a'.repeat(22)), []);
  });

  it('retries 5xx then succeeds; surfaces quota errors with their reason', async () => {
    let n = 0;
    const flaky = new YouTubeClient({
      apiKey: 'k',
      sleep: async () => {},
      fetchImpl: async () => (++n < 3 ? fail(503) : ok({ items: [] })),
    });
    assert.deepEqual(await flaky.videos(['v']), []);

    const quota = new YouTubeClient({
      apiKey: 'k',
      fetchImpl: async () => fail(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }),
    });
    await assert.rejects(quota.videos(['v']), (e) => e.status === 403 && e.reason === 'quotaExceeded');
  });

  it('refuses more than 50 ids per videos.list call', async () => {
    const client = new YouTubeClient({ apiKey: 'k', fetchImpl: async () => ok({}) });
    await assert.rejects(client.videos(Array.from({ length: 51 }, (_, i) => `v${i}`)));
  });
});

describe('helpers', () => {
  it('derives the uploads playlist id', () => {
    assert.equal(uploadsPlaylistId('UCoMdktPbSTixAyNGwb-UYkQ'), 'UUoMdktPbSTixAyNGwb-UYkQ');
  });
  it('chunks', () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));
  it('validates channels', () => {
    assert.throws(() => validateChannels([{ id: 'nope' }]), /Invalid channel id/);
    assert.throws(() => validateChannels([chan(1), chan(1)]), /Duplicate/);
    assert.throws(() => validateChannels([{ ...chan(1), country: '' }]), /country/);
    assert.equal(validateChannels([chan(1)]).length, 1);
  });
});
