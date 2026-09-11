require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// Serve static files with no-cache so phone always gets fresh files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

let musicQueue = [];
let favorites = [];
let playlists = [{ id: 'default', name: 'My Playlist', songs: [] }];

// Get local network IP
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --- Version (for SW update detection) ---
const APP_VERSION = Date.now();
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

// --- YouTube API Search (cached for speed) ---
const searchCache = new Map();
const SEARCH_TTL = 10 * 60 * 1000;

const https = require('https');
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/search';
const keepAgent = new https.Agent({ keepAlive: true });

// Fast YouTube search via Innertube (internal web API, no key needed)
async function searchInnertube(query, limit = 8) {
  const body = JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en' } },
    query
  });
  const res = await fetch(INNERTUBE_URL + '?key=' + INNERTUBE_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    agent: keepAgent,
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error('Innertube HTTP ' + res.status);
  const data = await res.json();
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object' || out.length >= limit) return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const r = o.videoRenderer;
      const title = (r.title?.runs || [{ text: '' }]).map(x => x.text).join('').trim();
      if (!title) return;
      const channelRaw = r.longBylineText?.runs || r.shortBylineText?.runs || [];
      const channel = channelRaw.map(x => x.text).join('').trim();
      const lenText = r.lengthText?.simpleText || (r.lengthText?.runs || []).map(x => x.text).join('');
      out.push({
        videoId: r.videoId,
        title,
        channel,
        durationText: lenText,
        thumbnail: r.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`
      });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(data);
  return out;
}

function parseDurationText(text) {
  const m = String(text || '').match(/(\d+):(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return 0;
  const a = +m[1], b = +m[2], c = +(m[3] || 0);
  return (c ? a * 3600 + b * 60 + c : a * 60 + b);
}

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Query required' });

  const key = query.toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.t < SEARCH_TTL) {
    return res.json(cached.data);
  }

  try {
    let raw;
    try {
      raw = await searchInnertube(query, 15);
    } catch (e) {
      const YouTube = require('youtube-sr').default || require('youtube-sr');
      const results = await YouTube.search(query, { limit: 15, type: 'video' });
      raw = results.filter(v => v.type === 'video' && v.id)
        .map(v => ({ videoId: v.id, title: v.title, channel: v.channel?.name || v.channel?.title || 'Unknown', durationText: v.duration_formatted || v.durationFormatted || '', thumbnail: v.thumbnail?.url || '' }));
    }
    const videos = raw.map(v => ({
      id: uuidv4(),
      videoId: v.videoId,
      title: v.title,
      channel: v.channel || 'Unknown',
      duration: v.durationText || formatDuration(v.duration),
      thumbnail: lightThumb({ id: v.videoId, thumbnail: { url: v.thumbnail } }),
      lengthSeconds: parseDurationText(v.durationText || v.duration)
    }));
    searchCache.set(key, { t: Date.now(), data: videos });
    if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value);
    res.json(videos);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Use light mqdefault thumbnails (320px) instead of heavy hq720 for fast loading
function lightThumb(v) {
  if (v.thumbnail?.url) {
    return v.thumbnail.url
      .replace(/hq720/, 'mqdefault')
      .replace(/hqdefault/, 'mqdefault')
      .replace(/maxresdefault/, 'mqdefault');
  }
  return `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`;
}

function formatDuration(dur) {
  if (!dur) return '0:00';
  const s = typeof dur === 'number' ? dur : dur.seconds || 0;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ===== Playlist Import (Spotify, SoundCloud, YouTube, Lyra) =====
function detectPlatform(url) {
  const host = new URL(url).hostname;
  if (/spotify\.com$|spotify\.link$/i.test(host)) return 'spotify';
  if (/soundcloud\.com$/i.test(host)) return 'soundcloud';
  if (/youtube\.com$|youtu\.be$/i.test(host)) return 'youtube';
  if (/lyramusic\.app$|lyra\.app$|lyra-player|feelthemusi/i.test(host)) return 'lyra';
  return null;
}

async function fetchSpotify(url) {
  const m = url.match(/playlist[\/]([A-Za-z0-9]+)/i)
        || url.match(/(?:spotify:playlist:)([A-Za-z0-9]+)/i);
  if (!m) throw new Error('Could not find Spotify playlist ID in link');
  const id = m[1];
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error('Spotify returned ' + res.status);
  const html = await res.text();
  const m2 = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m2) throw new Error('Could not read Spotify playlist data');
  let data;
  try { data = JSON.parse(m2[1]); } catch (e) { throw new Error('Could not parse Spotify playlist data'); }
  let entity;
  try { entity = data.props.pageProps.state.data.entity; } catch (e) { throw new Error('Unexpected Spotify response'); }
  const list = (entity.trackList || []).filter(t => t && t.title);
  const name = entity.name || entity.title || 'Spotify Playlist';
  const tracks = list.map(t => ({
    title: typeof t.title === 'string' ? t.title : (t.title.name || ''),
    artist: typeof t.subtitle === 'string' ? t.subtitle : (t.subtitle?.name || '')
  }));
  return { name, tracks };
}

async function fetchSoundCloud(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('SoundCloud returned ' + res.status);
  const html = await res.text();
  const m = html.match(/window\.__sc_hydration\s*=\s*(\[.*?\]);?<\/script>/s);
  if (!m) throw new Error('Could not read SoundCloud page');
  let json;
  try { json = JSON.parse(m[1]); } catch (e) { throw new Error('Could not parse SoundCloud data'); }
  let playlist = null;
  for (const item of json) {
    if (item.data && (item.data.tracks || item.data.playlists)) {
      if (item.data.type === 'playlist' || item.data.tracks) playlist = item.data;
    }
  }
  if (!playlist) throw new Error('No playlist data found on SoundCloud page');
  const name = playlist.title || playlist.name || 'SoundCloud Playlist';
  const tracks = (playlist.tracks || []).filter(t => t).map(t => ({
    title: t.title || '',
    artist: (t.user && t.user.username) || ''
  })).filter(t => t.title);
  return { name, tracks };
}

async function fetchYouTubePlaylist(url) {
  const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/) || url.match(/(?:playlist\?list=)([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('Could not find YouTube playlist ID in link');
  const id = m[1];
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${id}`);
  if (!res.ok) throw new Error('YouTube returned ' + res.status);
  const xml = await res.text();
  const entries = xml.split('</entry>');
  if (entries.length < 2) throw new Error('Playlist is empty or private');
  const tracks = entries.map(entry => {
    const t = entry.match(/<title>(.*?)<\/title>/s);
    return t ? { title: t[1].trim(), artist: '' } : null;
  }).filter(t => t && t.title && !t.title.toLowerCase().includes('playlist stats'));
  return { name: tracks.length + ' song playlist (YouTube)', tracks };
}

async function fetchLyra(url) {
  // Lyra playlists are shareable via listen.lyramusic.app/playlist/<code>
  // (also lyra:// deep links). The code is base62, e.g. "5uZluf36Fe3ejE4iairwRt".
  let id = null;
  const m = url.match(/playlist[\/:]([A-Za-z0-9_-]+)/i);
  if (m) {
    id = m[1].replace(/\.playlist$/i, '');
  } else {
    const last = String(url.split('/').pop() || '').replace(/\.playlist$/i, '');
    if (/^[A-Za-z0-9_-]+$/.test(last)) id = last;
  }
  if (!id) throw new Error('Could not find Lyra playlist code in link');

  const res = await fetch(`https://feelthemusi.com/api/v4/playlists/fetch/${id}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Origin': 'https://listen.lyramusic.app'
    }
  });
  if (!res.ok) throw new Error('Lyra returned ' + res.status);
  const r = await res.json();
  if (r && r.error) throw new Error(
    `Lyra: ${r.error} (code "${id}"). Native Lyra playlists need a signed-in Lyra account to expose their track list, so automatic import isn't possible from a share link alone.`
  );
  const s = r && r.success;
  if (!s || typeof s !== 'object') throw new Error('Playlist not found in Lyra response');
  let parsed;
  try { parsed = JSON.parse(s.data); } catch (e) { throw new Error('Could not read Lyra playlist data'); }
  const list = (parsed.data || []).filter(t => t && t.video_id && t.video_name);
  if (!list.length) throw new Error('No songs found in that Lyra playlist');
  const name = parsed.title || s.title || 'Lyra Playlist';
  const tracks = list.map(t => ({
    title: t.video_name,
    artist: t.video_creator || '',
    videoId: t.video_id,
    duration: String(t.video_duration || '')
  }));
  return { name, tracks };
}

// --- Resolve each track to a YouTube video (cached + concurrent) ---
const resolveCache = new Map();
const RESOLVE_TTL = 60 * 60 * 1000;

async function resolveSongToYouTube(track) {
  const q = `${track.artist} ${track.title}`.replace(/\s+/g, ' ').trim();
  const key = q.toLowerCase();
  const cached = resolveCache.get(key);
  if (cached && Date.now() - cached.t < RESOLVE_TTL) return cached.song;

  try {
    let res;
    try {
      res = await searchInnertube(q, 1);
    } catch (e) {
      const YouTube = require('youtube-sr').default || require('youtube-sr');
      const r2 = await YouTube.search(q, { limit: 1, type: 'video' });
      res = (r2[0] && r2[0].id) ? [{ videoId: r2[0].id, title: r2[0].title,
        channel: r2[0].channel?.name || track.artist || 'Unknown',
        durationText: r2[0].duration_formatted || '', thumbnail: lightThumb(r2[0]) }] : [];
    }
    const v = res && res[0];
    if (!v || !v.videoId) return null;
    const song = {
      id: uuidv4(),
      videoId: v.videoId,
      title: track.title || v.title,
      artist: track.artist || v.channel || 'Unknown',
      channel: v.channel || track.artist || 'Unknown',
      duration: v.durationText || formatDuration(parseDurationText(v.durationText)),
      thumbnail: lightThumb({ id: v.videoId, thumbnail: { url: v.thumbnail } }),
      lengthSeconds: parseDurationText(v.durationText)
    };
    resolveCache.set(key, { t: Date.now(), song });
    return song;
  } catch (e) {
    return null;
  }
}

async function resolveTrackList(tracks) {
  const songs = new Array(tracks.length).fill(null);
  const queue = tracks.map((t, i) => ({ t, i }));
  const workers = Array(Math.min(6, Math.max(1, queue.length))).fill().map(async () => {
    while (queue.length) {
      const { t, i } = queue.shift();
      if (t.videoId) {
        // Already has a native YouTube ID (e.g. Lyra) - no search needed
        songs[i] = {
          id: uuidv4(),
          videoId: t.videoId,
          title: t.title,
          artist: t.artist || 'Unknown',
          channel: t.artist || 'Unknown',
          duration: t.duration || '',
          thumbnail: `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`,
          lengthSeconds: parseDurationText(t.duration)
        };
      } else {
        songs[i] = await resolveSongToYouTube(t);
      }
    }
  });
  await Promise.all(workers);
  return songs.filter(Boolean);
}

app.post('/api/playlist/import', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'That does not look like a link. Paste a Spotify, SoundCloud, YouTube or Lyra playlist link.' });

  try {
    const platform = detectPlatform(url);
    if (!platform) return res.status(400).json({ error: 'Unsupported link. Use Spotify, SoundCloud, YouTube or Lyra.' });

    let name, tracks;
    if (platform === 'spotify')      ({ name, tracks } = await fetchSpotify(url));
    else if (platform === 'soundcloud') ({ name, tracks } = await fetchSoundCloud(url));
    else if (platform === 'youtube') ({ name, tracks } = await fetchYouTubePlaylist(url));
    else if (platform === 'lyra')    ({ name, tracks } = await fetchLyra(url));

    if (!tracks || !tracks.length) throw new Error('No tracks found in that playlist');

    const songs = await resolveTrackList(tracks);
    res.json({ platform, name, total: tracks.length, found: songs.length, tracks: songs });
  } catch (e) {
    console.error('Import error:', e.message);
    res.status(500).json({ error: e.message || 'Import failed' });
  }
});

function parseTextToTracks(text) {
  const seen = new Set();
  const tracks = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/^\s*(?:[•▪*#.\-"])\s*/, '').replace(/\s*[—-]"?\s*$/, '').trim();
    line = line.replace(/^\d+[.)]\s*/, '');
    if (!line) continue;
    let title = line;
    let artist = '';
    const by = line.match(/^(.+?)\s+by\s+(.+)$/i);
    const dash = line.match(/^(.+?)\s*[-–—|]\s*(.+)$/);
    if (by) { title = by[1].trim(); artist = by[2].trim(); }
    else if (dash) { artist = dash[1].trim(); title = dash[2].trim(); }
    if (!title) continue;
    const key = (title + '|' + artist).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ title, artist });
  }
  return tracks;
}

app.post('/api/playlist/import-text', async (req, res) => {
  let text = (req.body.text || '').trim();
  const name = (req.body.name || '').trim();
  if (!text) return res.status(400).json({ error: 'Paste a track list first (one song per line).' });
  if (text.length > 20000) { text = text.slice(0, 20000); }

  let tracks = parseTextToTracks(text);
  if (!tracks.length) return res.status(400).json({ error: 'Nothing readable in that text. Use one song per line, e.g. "Artist - Title".' });
  if (tracks.length > 200) tracks = tracks.slice(0, 200);

  try {
    const songs = await resolveTrackList(tracks);
    if (!songs.length) return res.status(404).json({ error: 'Could not match any of those songs on YouTube. Check the format: one song per line like "Artist - Title".' });
    res.json({ name: name || 'Paste-in Playlist', total: tracks.length, found: songs.length, tracks: songs });
  } catch (e) {
    console.error('Text import error:', e.message);
    res.status(500).json({ error: e.message || 'Import failed' });
  }
});

// --- Stream audio via proxy (yt-dlp) ---
const { execFile, spawn } = require('child_process');
const YTDLP_BIN = path.join(__dirname, 'bin', 'yt-dlp');

app.get('/api/stream/:videoId', (req, res) => {
  const { videoId } = req.params;

  res.set({
    'Content-Type': 'audio/webm',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });

  const ytdlp = spawn(YTDLP_BIN, [
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'opus',
    '--audio-quality', '0',
    '-o', '-',
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', (d) => {
    if (process.env.DEBUG) console.log('[yt-dlp]', d.toString().trim());
  });
  ytdlp.on('error', (err) => {
    console.error('Stream spawn error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    else res.end();
  });

  req.on('close', () => {
    if (!res.writableEnded) ytdlp.kill();
  });
});

// --- Queue ---
app.get('/api/queue', (req, res) => res.json(musicQueue));

app.post('/api/queue', (req, res) => {
  const song = { ...req.body, id: req.body.id || uuidv4() };
  musicQueue.push(song);
  res.json(song);
});

app.post('/api/queue/reorder', (req, res) => {
  const { from, to } = req.body;
  if (from === undefined || to === undefined) return res.status(400).json({ error: 'from/to required' });
  const [item] = musicQueue.splice(from, 1);
  musicQueue.splice(to, 0, item);
  res.json(musicQueue);
});

app.delete('/api/queue/:id', (req, res) => {
  musicQueue = musicQueue.filter(s => s.id !== req.params.id);
  res.json({ ok: true });
});

app.delete('/api/queue', (req, res) => {
  musicQueue = [];
  res.json({ ok: true });
});

// --- Favorites ---
app.get('/api/favorites', (req, res) => res.json(favorites));

app.post('/api/favorites', (req, res) => {
  const song = { ...req.body, id: req.body.id || uuidv4() };
  if (!favorites.find(f => f.videoId === song.videoId)) {
    favorites.push(song);
  }
  res.json(favorites);
});

app.delete('/api/favorites/:videoId', (req, res) => {
  favorites = favorites.filter(f => f.videoId !== req.params.videoId);
  res.json({ ok: true });
});

// --- Playlists ---
app.get('/api/playlists', (req, res) => res.json(playlists));

app.post('/api/playlists', (req, res) => {
  const pl = { id: uuidv4(), name: req.body.name || 'New Playlist', songs: [] };
  playlists.push(pl);
  res.json(pl);
});

app.post('/api/playlists/:id/songs', (req, res) => {
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const song = { ...req.body, id: req.body.id || uuidv4() };
  if (!pl.songs.find(s => s.videoId === song.videoId)) {
    pl.songs.push(song);
  }
  res.json(pl);
});

app.delete('/api/playlists/:id/songs/:videoId', (req, res) => {
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  pl.songs = pl.songs.filter(s => s.videoId !== req.params.videoId);
  res.json(pl);
});

// --- SPA fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n========================================');
  console.log('   🎵 Music Server is running!');
  console.log('========================================');
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${ip}:${PORT}`);
  console.log('');
  console.log('   Open on your phone:');
  console.log(`   http://${ip}:${PORT}`);
  console.log('========================================\n');
});
