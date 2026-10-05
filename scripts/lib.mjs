// Resolves which YouTube news channels are live right now.
//
// Quota (YouTube Data API v3, 10,000 free units/day):
//   videos.list        1 unit per call, up to 50 ids
//   playlistItems.list 1 unit per call
//   search.list      100 units per call  -> only for channels with no live stream found in their uploads,
//                                           at most once a day per channel and a few per run

const API = 'https://www.googleapis.com/youtube/v3';

export const DEFAULTS = {
  maxStreamsPerChannel: 3,
  // A channel with no live stream is only re-checked this often (unless it just lost one).
  idleRecheckMinutes: 180,
  // A channel that is live is still re-scanned this often to discover extra/replacement streams.
  discoveryHours: 12,
  // search.list calls allowed per run, and per channel retry interval.
  // 24/7 streams are often older than a channel's 50 most recent uploads, so search is how they are found.
  searchBudget: 6,
  searchRetryHours: 24,
};

export const uploadsPlaylistId = (channelId) => 'UU' + channelId.slice(2);

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function validateChannels(channels) {
  if (!Array.isArray(channels)) throw new Error('channels.json must be an array');
  const seen = new Set();
  for (const c of channels) {
    if (!/^UC[\w-]{22}$/.test(c?.id ?? '')) throw new Error(`Invalid channel id: ${c?.id}`);
    if (seen.has(c.id)) throw new Error(`Duplicate channel id: ${c.id}`);
    seen.add(c.id);
    for (const key of ['name', 'country', 'language', 'category']) {
      if (!c[key]) throw new Error(`Channel ${c.id} is missing "${key}"`);
    }
  }
  return channels;
}

export class YouTubeClient {
  /** Total quota units spent by this client (errors count as 1). */
  units = 0;

  constructor({
    apiKey,
    fetchImpl = fetch,
    retries = 2,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    if (!apiKey) throw new Error('apiKey is required');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.sleep = sleep;
  }

  async #get(path, params, cost) {
    const url = `${API}/${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        // The key goes in a header so it can never leak through logged URLs.
        res = await this.fetchImpl(url, { headers: { 'x-goog-api-key': this.apiKey } });
      } catch (e) {
        if (attempt < this.retries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new Error(`Network error calling ${path}: ${e.message}`);
      }
      this.units += res.ok ? cost : 1;
      if (res.ok) return res.json();
      if (res.status >= 500 && attempt < this.retries) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason;
      const error = new Error(
        `YouTube API ${path} failed: ${res.status} ${reason ?? body?.error?.message ?? ''}`.trim(),
      );
      error.status = res.status;
      error.reason = reason;
      throw error;
    }
  }

  async videos(ids) {
    if (ids.length === 0) return [];
    if (ids.length > 50) throw new Error('videos.list accepts at most 50 ids');
    const data = await this.#get(
      'videos',
      { part: 'snippet,liveStreamingDetails,status,contentDetails', id: ids.join(',') },
      1,
    );
    return data.items ?? [];
  }

  async uploadVideoIds(channelId, max = 50) {
    try {
      const data = await this.#get(
        'playlistItems',
        { part: 'contentDetails', playlistId: uploadsPlaylistId(channelId), maxResults: max },
        1,
      );
      return (data.items ?? []).map((item) => item.contentDetails.videoId);
    } catch (e) {
      if (e.status === 404) return []; // channel has no uploads playlist
      throw e;
    }
  }

  async searchLiveVideoIds(channelId) {
    const data = await this.#get(
      'search',
      { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: 5 },
      100,
    );
    return (data.items ?? []).map((item) => item.id.videoId).filter(Boolean);
  }
}

const truncate = (text = '', max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

const pickThumbnails = (thumbnails = {}) =>
  Object.fromEntries(
    ['default', 'medium', 'high']
      .filter((size) => thumbnails[size]?.url)
      .map((size) => [size, { url: thumbnails[size].url }]),
  );

/**
 * Returns an output stream entry, or null when the video must not be shown:
 * not live, not embeddable, not public, Made For Kids, or from another channel.
 */
export function toStream(video, channel) {
  const { snippet, status, liveStreamingDetails, contentDetails } = video;
  if (snippet?.liveBroadcastContent !== 'live') return null;
  if (status?.embeddable !== true) return null;
  if (status?.privacyStatus !== 'public') return null;
  if (status?.madeForKids === true) return null; // needs different data handling; skip
  if (snippet.channelId !== channel.id) return null;

  return {
    videoId: video.id,
    channelId: channel.id,
    title: snippet.title,
    description: truncate(snippet.description, 300),
    channelTitle: snippet.channelTitle,
    country: channel.country,
    language: channel.language,
    category: channel.category,
    thumbnails: pickThumbnails(snippet.thumbnails),
    concurrentViewers: Number(liveStreamingDetails?.concurrentViewers) || null,
    startedAt: liveStreamingDetails?.actualStartTime ?? null,
    regionRestriction: contentDetails?.regionRestriction ?? null,
  };
}

const isFatal = (error) => [400, 401, 403].includes(error.status); // bad key or quota: stop the run

const unique = (items) => [...new Set(items)];

/**
 * @param channels   validated contents of channels.json
 * @param previous   { streams: previously published streams, state: { [channelId]: { checkedAt, searchedAt } } }
 * @returns          { streams, state }
 */
export async function resolveStreams({
  channels,
  previous = { streams: [], state: {} },
  client,
  now = new Date(),
  options = {},
  log = () => {},
}) {
  const o = { ...DEFAULTS, ...options };
  const byId = new Map(channels.map((c) => [c.id, c]));
  const prevStreams = previous.streams.filter((s) => byId.has(s.channelId));
  const prevState = previous.state ?? {};
  const minutesSince = (iso) => (iso ? (now - Date.parse(iso)) / 60_000 : Infinity);

  // channelId -> Map(videoId -> stream)
  const live = new Map(channels.map((c) => [c.id, new Map()]));

  const verify = async (ids, channelOf) => {
    for (const batch of chunk(unique(ids), 50)) {
      for (const video of await client.videos(batch)) {
        const channel = byId.get(channelOf.get(video.id));
        const stream = channel && toStream(video, channel);
        if (stream) live.get(channel.id).set(stream.videoId, stream);
      }
    }
  };

  // 1. Re-verify what was live last time (1 unit per 50 videos).
  const prevChannelOf = new Map(prevStreams.map((s) => [s.videoId, s.channelId]));
  await verify([...prevChannelOf.keys()], prevChannelOf);

  // 2. Decide which channels need a discovery scan.
  const state = {};
  const due = [];
  for (const channel of channels) {
    const prev = prevState[channel.id] ?? {};
    state[channel.id] = { ...prev };
    const hadLive = prevStreams.some((s) => s.channelId === channel.id);
    const isLive = live.get(channel.id).size > 0;
    const age = minutesSince(prev.checkedAt);
    const needsScan = isLive
      ? age >= o.discoveryHours * 60
      : hadLive || age >= o.idleRecheckMinutes; // lost a stream: look for its replacement now
    if (needsScan) due.push(channel);
  }

  // 3. Scan the uploads playlists of due channels (1 unit each), then verify all candidates together.
  const candidateChannelOf = new Map();
  const scanned = [];
  for (const channel of due) {
    try {
      const ids = await client.uploadVideoIds(channel.id);
      for (const id of ids) if (!live.get(channel.id).has(id)) candidateChannelOf.set(id, channel.id);
      scanned.push(channel);
    } catch (e) {
      if (isFatal(e)) throw e;
      log(`warn: could not scan ${channel.name}: ${e.message}`);
    }
  }
  await verify([...candidateChannelOf.keys()], candidateChannelOf);
  for (const channel of scanned) state[channel.id].checkedAt = now.toISOString();

  // 4. Budgeted search fallback for channels whose live stream is buried in their uploads.
  //    Set "searchFallback": false on a channel in channels.json to opt it out.
  let budget = o.searchBudget;
  const searchedChannelOf = new Map();
  for (const channel of scanned) {
    if (channel.searchFallback === false || live.get(channel.id).size > 0 || budget <= 0) continue;
    if (minutesSince(state[channel.id].searchedAt) < o.searchRetryHours * 60) continue;
    budget--;
    state[channel.id].searchedAt = now.toISOString();
    try {
      for (const id of await client.searchLiveVideoIds(channel.id)) searchedChannelOf.set(id, channel.id);
    } catch (e) {
      if (isFatal(e)) throw e;
      log(`warn: search failed for ${channel.name}: ${e.message}`);
    }
  }
  await verify([...searchedChannelOf.keys()], searchedChannelOf);

  // 5. Assemble output in channels.json order, busiest streams first, capped per channel.
  const streams = channels.flatMap((channel) =>
    [...live.get(channel.id).values()]
      .sort((a, b) => (b.concurrentViewers ?? 0) - (a.concurrentViewers ?? 0))
      .slice(0, o.maxStreamsPerChannel),
  );

  return { streams, state };
}

const withoutViewers = (streams) => JSON.stringify(streams.map(({ concurrentViewers, ...rest }) => rest));

/**
 * Viewer counts change every minute, so they alone must not cause a commit.
 * Rewrite when the stream list changed, or periodically so the file (and repo) never goes stale.
 */
export function shouldWrite(previousDoc, streams, now, maxAgeHours) {
  if (!previousDoc || !Array.isArray(previousDoc.streams)) return true;
  if (withoutViewers(previousDoc.streams) !== withoutViewers(streams)) return true;
  const ageHours = (now - Date.parse(previousDoc.generatedAt)) / 3_600_000;
  return !(ageHours < maxAgeHours);
}
