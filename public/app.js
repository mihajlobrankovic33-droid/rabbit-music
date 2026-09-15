// ====== IndexedDB for offline caching ======
const DB_NAME = 'MusicServerDB';
const DB_VERSION = 4;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('songs')) {
        d.createObjectStore('songs', { keyPath: 'videoId' });
      }
      if (!d.objectStoreNames.contains('audioBlobs')) {
        d.createObjectStore('audioBlobs', { keyPath: 'videoId' });
      }
      if (!d.objectStoreNames.contains('appCache')) {
        d.createObjectStore('appCache', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('favorites')) {
        d.createObjectStore('favorites', { keyPath: 'videoId' });
      }
      if (!d.objectStoreNames.contains('playlists')) {
        d.createObjectStore('playlists', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbPut(store, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function dbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ====== State ======
let currentPlaylist = null;
let currentQueue = [];
let currentIndex = -1;
let isPlaying = false;
let favorites = new Set();
let cachedSongs = new Set();
let localPlaylists = [];
let deferredInstallPrompt = null;
let currentAppVersion = null;

const audio = document.getElementById('audioPlayer');
const playerBar = document.getElementById('playerBar');
const playPauseBtn = document.getElementById('playPauseBtn');
const progressFill = document.getElementById('progressFill');
const volumeSlider = document.getElementById('volumeSlider');
const offlineIndicator = document.getElementById('offlineIndicator');
const installBtn = document.getElementById('installBtn');
const versionBadge = document.getElementById('versionBadge');

// ====== Init ======
async function init() {
  await openDB();

  // Load cached songs list
  const allCached = await dbGetAll('songs');
  allCached.forEach(s => cachedSongs.add(s.videoId));

  // Favorites live on the phone (IndexedDB) so the app works alone
  const localFavs = await dbGetAll('favorites');
  localFavs.forEach(f => favorites.add(f.videoId));

  // Playlists live on the phone too
  localPlaylists = await dbGetAll('playlists');

  // Queue resumes from the phone
  try {
    const savedQueue = localStorage.getItem('queue');
    if (savedQueue) currentQueue = JSON.parse(savedQueue);
  } catch (e) {}

  // If online, migrate whatever the server still has into the phone (best effort)
  try {
    const res = await fetch('/api/favorites');
    const favs = await res.json();
    if (Array.isArray(favs)) {
      const known = new Set((await dbGetAll('favorites')).map(f => f.videoId));
      for (const f of favs) {
        if (!known.has(f.videoId)) { await dbPut('favorites', f); favorites.add(f.videoId); }
      }
    }
  } catch (e) {}
  try {
    const res = await fetch('/api/playlists');
    const pls = await res.json();
    if (Array.isArray(pls)) {
      const known = new Set(localPlaylists.map(p => p.id));
      for (const p of pls) {
        if (!known.has(p.id)) { localPlaylists.push(p); await dbPut('playlists', p); }
      }
    }
  } catch (e) {}
  try {
    const res = await fetch('/api/queue');
    const q = await res.json();
    if (Array.isArray(q) && q.length) currentQueue = q;
  } catch (e) {}
  saveQueueLocal();

  // Load volume
  const savedVol = localStorage.getItem('volume');
  if (savedVol) {
    volumeSlider.value = savedVol;
    audio.volume = savedVol / 100;
  }

  // Event listeners
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('ended', nextTrack);
  audio.addEventListener('play', () => { isPlaying = true; updatePlayPause(); });
  audio.addEventListener('pause', () => { isPlaying = false; updatePlayPause(); });

  document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch();
  });

  // Search as you type (debounced for speed)
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) return;
    searchTimer = setTimeout(() => performSearch(true), 300);
  });

  document.querySelector('.player-progress').addEventListener('click', seekAudio);

  // Online/offline detection
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.classList.remove('hidden');
  });

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Check for SW updates periodically (detect new deploys)
      setInterval(() => reg.update().catch(() => {}), 60 * 1000);
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'UPDATE_AVAILABLE') showUpdateBanner();
      });
    }).catch(() => {});
  }

  // Auto-detect new server versions and offer to refresh
  checkForServerUpdate();
  setInterval(checkForServerUpdate, 20000);
}

async function checkForServerUpdate() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    const data = await res.json();
    if (!data.version) return;

    if (currentAppVersion === null) {
      currentAppVersion = data.version;
      if (versionBadge) versionBadge.textContent = 'v' + String(data.version).slice(-5);
      return;
    }
    if (data.version !== currentAppVersion) {
      currentAppVersion = data.version;
      if (versionBadge) versionBadge.textContent = 'v' + String(data.version).slice(-5);
      showUpdateBanner();
    }
  } catch (e) {}
}

function showUpdateBanner() {
  const existing = document.getElementById('updateBanner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.className = 'update-banner';
  banner.innerHTML = 'Update available <button onclick="refreshApp()">Refresh now</button>';
  document.body.appendChild(banner);
}

// ====== Online/Offline ======
function updateOnlineStatus() {
  if (navigator.onLine) {
    offlineIndicator.classList.add('hidden');
  } else {
    offlineIndicator.classList.remove('hidden');
  }
}

// ====== PWA Install ======
async function installPWA() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    installBtn.classList.add('hidden');
    showToast('App installed!');
  }
  deferredInstallPrompt = null;
}

// ====== Refresh app (get updates) ======
async function refreshApp() {
  showToast('Refreshing...');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
    }
  } catch (e) {}
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) {}
  // Navigate to a brand-new URL (never cached) to force a full network load.
  // A plain reload() on iOS can re-serve cached files instead of reaching the server.
  const fresh = location.origin + '/?fresh=' + Date.now();
  window.location.href = fresh;
}

// ====== Tabs ======
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');

  if (name === 'queue') renderQueue();
  if (name === 'favorites') renderFavorites();
  if (name === 'playlists') renderPlaylists();
  if (name === 'cached') renderCached();
}

// ====== Search ======
let searchTimer = null;
let activeSearch = null;

async function performSearch(silent) {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;

  const results = document.getElementById('searchResults');
  const loading = document.getElementById('searchLoading');

  if (activeSearch) activeSearch.abort();
  const ac = new AbortController();
  activeSearch = ac;

  if (!silent) {
    loading.classList.remove('hidden');
    results.innerHTML = '';
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ac.signal });
    const data = await res.json();

    if (ac.signal.aborted) return;

    loading.classList.add('hidden');

    if (!Array.isArray(data) || data.length === 0) {
      results.innerHTML = '<div class="empty-state">No results found</div>';
      return;
    }

    results.innerHTML = '';
    data.forEach(song => {
      results.appendChild(createSongItem(song, 'search'));
    });
  } catch (e) {
    if (e.name === 'AbortError' || ac.signal.aborted) return;
    loading.classList.add('hidden');
    // Try offline cache search
    if (!navigator.onLine) {
      const pool = {};
      (await dbGetAll('songs')).forEach(s => { pool[s.videoId] = s; });
      (await dbGetAll('favorites')).forEach(s => { pool[s.videoId] = s; });
      (await dbGetAll('playlists')).forEach(p => (p.songs || []).forEach(s => { pool[s.videoId] = s; }));
      const q2 = q.toLowerCase();
      const filtered = Object.values(pool).filter(s =>
        (s.title || '').toLowerCase().includes(q2) || (s.channel || '').toLowerCase().includes(q2)
      );
      if (filtered.length > 0) {
        filtered.forEach(song => {
          results.appendChild(createSongItem(song, 'search'));
        });
      } else {
        results.innerHTML = '<div class="empty-state">No saved songs for this query</div>';
      }
    } else {
      results.innerHTML = '<div class="empty-state">Search failed. Try again.</div>';
    }
  }
}

// ====== Song Item ======
function createSongItem(song, context) {
  const div = document.createElement('div');
  div.className = 'song-item';
  div.dataset.videoId = song.videoId;
  div.dataset.context = context;

  if (currentQueue[currentIndex]?.videoId === song.videoId) {
    div.classList.add('playing');
  }

  const isFav = favorites.has(song.videoId);
  const isCached = cachedSongs.has(song.videoId);
  const caching = div.dataset.caching === 'true';

  div.innerHTML = `
    <img class="song-thumb" src="${song.thumbnail || ''}" alt="" loading="lazy"
         onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22><rect fill=%22%231a2236%22 width=%2248%22 height=%2248%22/><text x=%2224%22 y=%2230%22 text-anchor=%22middle%22 fill=%22%2364748b%22 font-size=%2220%22>&#9835;</text></svg>'">
    <div class="song-info">
      <div class="song-title">${escHtml(song.title)}</div>
      <div class="song-meta">${escHtml(song.channel || '')} ${song.duration ? '&middot; ' + song.duration : ''}</div>
    </div>
    <div class="song-actions">
      <button class="action-btn ${isFav ? 'favorited' : ''}" onclick="event.stopPropagation(); toggleFavorite(this, ${JSON.stringify(song).replace(/"/g, '&quot;')})" title="Favorite">
        ${isFav ? '&#9829;' : '&#9825;'}
      </button>
      <button class="action-btn ${isCached ? 'cached' : ''}" onclick="event.stopPropagation(); toggleCache(this, ${JSON.stringify(song).replace(/"/g, '&quot;')})" title="Cache for offline">
        ${isCached ? '&#10003;' : '&#8615;'}
      </button>
      <button class="action-btn" onclick="event.stopPropagation(); addToQueue(${JSON.stringify(song).replace(/"/g, '&quot;')})" title="Add to queue">+</button>
    </div>
  `;

  div.addEventListener('click', () => playSong(song, context));
  return div;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ====== Play ======
function playSong(song, context) {
  if (context === 'search' || context === 'favorites' || context === 'playlist' || context === 'cached') {
    // Build queue from visible songs
    const listEl = document.querySelector(`#tab-${context === 'playlist' ? 'playlists' : context} .song-list`) ||
                   document.getElementById('searchResults');
    if (listEl && context !== 'cached') {
      const songs = Array.from(listEl.querySelectorAll('.song-item')).map(el => ({
        videoId: el.dataset.videoId,
        title: el.querySelector('.song-title').textContent,
        channel: el.querySelector('.song-meta').textContent.split('·')[0].trim(),
        thumbnail: el.querySelector('.song-thumb').src
      }));
      const idx = songs.findIndex(s => s.videoId === song.videoId);
      if (idx >= 0) {
        currentQueue = songs;
        currentIndex = idx;
      } else {
        currentQueue = [song];
        currentIndex = 0;
      }
    } else {
      currentQueue = [song];
      currentIndex = 0;
    }
  } else if (context === 'queue') {
    currentIndex = currentQueue.findIndex(s => s.videoId === song.videoId);
  }

  loadAndPlay(currentQueue[currentIndex]);
}

async function loadAndPlay(song) {
  playerBar.classList.remove('hidden');

  document.getElementById('playerTitle').textContent = song.title;
  document.getElementById('playerChannel').textContent = song.channel || '';
  document.getElementById('playerThumb').src = song.thumbnail || '';

  // Check if cached in IndexedDB
  const cachedAudio = await dbGet('audioBlobs', song.videoId);
  if (cachedAudio) {
    const blob = new Blob([cachedAudio.data], { type: 'audio/webm' });
    const blobUrl = URL.createObjectURL(blob);
    audio.src = blobUrl;
    audio.play().catch(() => {});
    showToast('Playing from cache');
  } else if (navigator.onLine) {
    audio.src = `/api/stream/${song.videoId}`;
    audio.play().catch(() => {});
  } else {
    showToast('Song not cached. Connect to internet.');
    return;
  }

  // Update playing state on all song items
  document.querySelectorAll('.song-item').forEach(el => {
    el.classList.toggle('playing', el.dataset.videoId === song.videoId);
  });

  // Update queue on server
  syncQueue();
}

// ====== Player Controls ======
function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

function updatePlayPause() {
  playPauseBtn.innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9654;';
}

function nextTrack() {
  if (currentQueue.length === 0) return;
  currentIndex = (currentIndex + 1) % currentQueue.length;
  loadAndPlay(currentQueue[currentIndex]);
}

function prevTrack() {
  if (currentQueue.length === 0) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  currentIndex = (currentIndex - 1 + currentQueue.length) % currentQueue.length;
  loadAndPlay(currentQueue[currentIndex]);
}

function updateProgress() {
  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = pct + '%';
  }
}

function seekAudio(e) {
  if (!audio.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  audio.currentTime = pct * audio.duration;
}

function setVolume(val) {
  audio.volume = val / 100;
  localStorage.setItem('volume', val);
  updateMuteIcon(val);
}

function toggleMute() {
  if (audio.volume > 0) {
    audio.dataset.prevVol = audio.volume;
    audio.volume = 0;
    volumeSlider.value = 0;
    updateMuteIcon(0);
  } else {
    const prev = parseFloat(audio.dataset.prevVol) || 0.8;
    audio.volume = prev;
    volumeSlider.value = prev * 100;
    updateMuteIcon(prev * 100);
  }
}

function updateMuteIcon(vol) {
  const btn = document.getElementById('muteBtn');
  if (vol == 0) btn.innerHTML = '&#128263;';
  else if (vol < 50) btn.innerHTML = '&#128265;';
  else btn.innerHTML = '&#128266;';
}

// ====== Queue ======
function addToQueue(song) {
  currentQueue.push(song);
  showToast('Added to queue');
  syncQueue();
}

function clearQueue() {
  currentQueue = [];
  currentIndex = -1;
  audio.pause();
  audio.src = '';
  playerBar.classList.add('hidden');
  renderQueue();
  saveQueueLocal();
  fetch('/api/queue', { method: 'DELETE' }).catch(() => {});
}

function removeFromQueue(videoId) {
  const idx = currentQueue.findIndex(s => s.videoId === videoId);
  currentQueue.splice(idx, 1);
  if (idx < currentIndex) currentIndex--;
  if (idx === currentIndex && currentQueue.length > 0) {
    currentIndex = Math.min(currentIndex, currentQueue.length - 1);
    loadAndPlay(currentQueue[currentIndex]);
  }
  renderQueue();
  syncQueue();
}

function renderQueue() {
  const list = document.getElementById('queueList');
  const empty = document.getElementById('queueEmpty');

  if (currentQueue.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = '';
  currentQueue.forEach((song, i) => {
    const div = createSongItem(song, 'queue');
    if (i === currentIndex) div.classList.add('playing');
    // Add remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'action-btn';
    removeBtn.innerHTML = '&#10005;';
    removeBtn.title = 'Remove';
    removeBtn.onclick = (e) => { e.stopPropagation(); removeFromQueue(song.videoId); };
    div.querySelector('.song-actions').prepend(removeBtn);
    list.appendChild(div);
  });
}

function saveQueueLocal() {
  try { localStorage.setItem('queue', JSON.stringify(currentQueue)); } catch (e) {}
}

async function syncQueue() {
  saveQueueLocal();
  try {
    await fetch('/api/queue', { method: 'DELETE' });
    for (const song of currentQueue) {
      await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(song)
      });
    }
  } catch (e) {}
}

// ====== Favorites ======
async function toggleFavorite(btn, song) {
  if (favorites.has(song.videoId)) {
    favorites.delete(song.videoId);
    btn.classList.remove('favorited');
    btn.innerHTML = '&#9825;';
    await dbDelete('favorites', song.videoId).catch(() => {});
    fetch(`/api/favorites/${song.videoId}`, { method: 'DELETE' }).catch(() => {});
    showToast('Removed from favorites');
    if (document.getElementById('tab-favorites').classList.contains('active')) renderFavorites();
  } else {
    favorites.add(song.videoId);
    btn.classList.add('favorited');
    btn.innerHTML = '&#9829;';
    await dbPut('favorites', song).catch(() => {});
    fetch('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(song)
    }).catch(() => {});
    showToast('Added to favorites');
    if (document.getElementById('tab-favorites').classList.contains('active')) renderFavorites();
  }
}

async function renderFavorites() {
  const list = document.getElementById('favoritesList');
  const empty = document.getElementById('favoritesEmpty');

  const favs = await dbGetAll('favorites');

  if (favs.length === 0) {
    list.innerHTML = '';
    empty.textContent = 'No favorites yet. Tap ♡ on any song.';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = '';
  favs.forEach(song => {
    const div = createSongItem(song, 'favorites');
    div.querySelector('.action-btn').classList.add('favorited');
    div.querySelector('.action-btn').innerHTML = '&#9829;';
    list.appendChild(div);
  });
}

// ====== Cache for offline ======
async function cacheSongToIndexedDB(song) {
  // Store metadata
  await dbPut('songs', {
    videoId: song.videoId,
    title: song.title,
    channel: song.channel,
    thumbnail: song.thumbnail,
    duration: song.duration,
    cachedAt: Date.now()
  });

  // Fetch audio as ArrayBuffer (more reliable than blob for IndexedDB)
  const response = await fetch(`/api/stream/${song.videoId}`);
  if (!response.ok) throw new Error('Stream failed: ' + response.status);

  const buffer = await response.arrayBuffer();

  // Store audio as ArrayBuffer
  await dbPut('audioBlobs', {
    videoId: song.videoId,
    data: buffer,
    size: buffer.byteLength
  });
  cachedSongs.add(song.videoId);
}

async function toggleCache(btn, song) {
  if (cachedSongs.has(song.videoId)) {
    // Uncache
    await dbDelete('songs', song.videoId);
    await dbDelete('audioBlobs', song.videoId);
    cachedSongs.delete(song.videoId);
    btn.classList.remove('cached');
    btn.innerHTML = '&#8615;';
    showToast('Removed from cache');
    return;
  }

  // Start caching
  if (!navigator.onLine) {
    showToast('Cannot cache while offline');
    return;
  }

  btn.classList.add('caching');
  btn.innerHTML = '&#8987;';
  showToast('Caching song...');

  try {
    await cacheSongToIndexedDB(song);
    btn.classList.remove('caching');
    btn.classList.add('cached');
    btn.innerHTML = '&#10003;';
    showToast('Song cached for offline!');
  } catch (e) {
    console.error('Cache error:', e);
    btn.classList.remove('caching');
    btn.innerHTML = '&#8615;';
    showToast('Cache failed: ' + (e.message || e));
  }
}

async function renderCached() {
  const list = document.getElementById('cachedList');
  const empty = document.getElementById('cachedEmpty');
  const stats = document.getElementById('cacheStats');

  const allCached = await dbGetAll('songs');

  if (allCached.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    stats.innerHTML = '';
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = '';

  let totalSize = 0;
  const audioBlobs = await dbGetAll('audioBlobs');
  audioBlobs.forEach(a => {
    if (a.data) totalSize += a.data.byteLength || a.data.size || 0;
  });

  allCached.sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0)).forEach(song => {
    const div = createSongItem(song, 'cached');
    // Update cache button state
    const cacheBtn = div.querySelector('.action-btn:nth-child(2)');
    cacheBtn.classList.add('cached');
    cacheBtn.innerHTML = '&#10003;';
    list.appendChild(div);
  });

  const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
  stats.innerHTML = `${allCached.length} song${allCached.length !== 1 ? 's' : ''} cached &middot; ${sizeMB} MB used`;
}

async function clearAllCached() {
  if (!confirm('Remove all cached songs?')) return;
  await dbClear('songs');
  await dbClear('audioBlobs');
  cachedSongs.clear();
  renderCached();
  showToast('All cached songs removed');
}

// ====== Playlists (stored on the phone — work without the server) ======
async function saveLocalPlaylists() {
  await dbClear('playlists');
  for (const pl of localPlaylists) await dbPut('playlists', pl);
}

async function renderPlaylists() {
  const detail = document.getElementById('playlistDetail');
  detail.classList.add('hidden');
  const list = document.getElementById('playlistsList');

  localPlaylists = await dbGetAll('playlists');
  list.innerHTML = '';

  if (localPlaylists.length === 0) {
    list.innerHTML = '<div class="empty-state">No playlists yet</div>';
    return;
  }

  localPlaylists.forEach(pl => {
    const div = document.createElement('div');
    div.className = 'playlist-item';
    div.innerHTML = `
      <div class="playlist-item-info">
        <h3>${escHtml(pl.name)}</h3>
        <span>${pl.songs.length} song${pl.songs.length !== 1 ? 's' : ''}</span>
      </div>
      <button class="btn-small btn-danger" onclick="event.stopPropagation(); deletePlaylist('${pl.id}')">Delete</button>
    `;
    div.addEventListener('click', () => openPlaylist(pl.id));
    list.appendChild(div);
  });
}

async function createPlaylist() {
  const name = prompt('Playlist name:');
  if (!name) return;
  const pl = { id: 'p' + Date.now().toString(36), name, songs: [] };
  localPlaylists.push(pl);
  await saveLocalPlaylists();
  renderPlaylists();
  showToast('Playlist created');
}

async function deletePlaylist(id) {
  if (!confirm('Delete this playlist?')) return;
  localPlaylists = localPlaylists.filter(p => p.id !== id);
  await saveLocalPlaylists();
  renderPlaylists();
  showToast('Playlist deleted');
}

async function openPlaylist(id) {
  localPlaylists = await dbGetAll('playlists');
  const pl = localPlaylists.find(p => p.id === id);
  if (!pl) return;

  currentPlaylist = pl;

  document.getElementById('playlistsList').innerHTML = '';
  const detail = document.getElementById('playlistDetail');
  detail.classList.remove('hidden');
  document.getElementById('playlistTitle').textContent = pl.name;

  const songList = document.getElementById('playlistSongs');
  songList.innerHTML = '';

  if (pl.songs.length === 0) {
    songList.innerHTML = '<div class="empty-state">No songs in this playlist. Add from search!</div>';
    return;
  }

  pl.songs.forEach(song => {
    const div = createSongItem(song, 'playlist');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'action-btn';
    removeBtn.innerHTML = '&#10005;';
    removeBtn.title = 'Remove from playlist';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      removeFromPlaylist(pl.id, song.videoId);
    };
    div.querySelector('.song-actions').prepend(removeBtn);
    songList.appendChild(div);
  });
}

function showPlaylistsList() {
  renderPlaylists();
}

async function removeFromPlaylist(playlistId, videoId) {
  const pl = localPlaylists.find(p => p.id === playlistId);
  if (pl) {
    pl.songs = pl.songs.filter(s => s.videoId !== videoId);
    await saveLocalPlaylists();
  }
  openPlaylist(playlistId);
  showToast('Removed from playlist');
}

// ====== Import playlist by link ======
let importedSongs = [];
let importedPlaylistName = '';

async function importPlaylist() {
  const url = document.getElementById('importUrl').value.trim();
  if (!url) return showToast('Paste a playlist link first');

  if (!/^https?:\/\//i.test(url)) {
    // Plain text dropped in the link box -> treat as a track list
    document.getElementById('importUrl').value = '';
    document.getElementById('importText').value = url;
    toggleImportMode(true);
    return importTextList();
  }

  const results = document.getElementById('importResults');
  results.innerHTML = '<div class="loading"><div class="spinner"></div><span>Reading playlist &amp; finding songs...</span></div>';

  try {
    const res = await fetch('/api/playlist/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      results.innerHTML = `<div class="import-error">${escHtml(data.error || 'Import failed')}</div>`;
      return;
    }

    importedSongs = data.tracks || [];
    importedPlaylistName = data.name || 'Imported Playlist';

    if (!importedSongs.length) {
      results.innerHTML = '<div class="import-error">No songs could be found in that playlist.</div>';
      return;
    }

    renderImportResults();
  } catch (e) {
    results.innerHTML = '<div class="import-error">Import failed. Is the server online?</div>';
  }
}

function toggleImportMode(forceOn) {
  const wrap = document.getElementById('textImportWrap');
  const linkSel = document.getElementById('importToggleLink');
  const show = forceOn === undefined ? wrap.classList.contains('hidden') : forceOn;
  wrap.classList.toggle('hidden', !show);
  linkSel.classList.toggle('hidden', show);
  if (show) document.getElementById('importText').focus();
}

async function importTextList() {
  const text = document.getElementById('importText').value.trim();
  const name = document.getElementById('importTextName').value.trim();
  if (!text) return showToast('Paste a track list first');

  const results = document.getElementById('importResults');
  results.innerHTML = '<div class="loading"><div class="spinner"></div><span>Finding songs on YouTube...</span></div>';

  try {
    const res = await fetch('/api/playlist/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, name })
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      results.innerHTML = `<div class="import-error">${escHtml(data.error || 'Import failed')}</div>`;
      return;
    }

    importedSongs = data.tracks || [];
    importedPlaylistName = data.name || 'Paste-in Playlist';

    if (!importedSongs.length) {
      results.innerHTML = '<div class="import-error">Could not match any of those songs on YouTube.</div>';
      return;
    }

    renderImportResults();
  } catch (e) {
    results.innerHTML = '<div class="import-error">Import failed. Is the server online?</div>';
  }
}

function renderImportResults() {
  const results = document.getElementById('importResults');
  const rows = importedSongs.map(s =>
    `<div class="import-song-row">
       <span class="import-song-idx">&#9835;</span>
       <span class="import-song-name">${escHtml(s.title)}</span>
       <span class="import-song-artist">${escHtml(s.artist || s.channel || '')}</span>
       <span class="import-song-status"></span>
     </div>`
  ).join('');

  results.innerHTML = `
    <div class="import-ok">
      <span><strong>${escHtml(importedPlaylistName)}</strong> · ${importedSongs.length} songs found</span>
    </div>
    <div class="import-actions">
      <button class="btn-small" onclick="saveImportedPlaylist()">Save to playlists</button>
      <button class="btn-small" onclick="cacheImportedSongs()">Cache all offline</button>
    </div>
    <div class="import-progress-wrap hidden" id="importProgressWrap">
      <div class="import-progress-bar"><div class="import-progress-fill" id="importProgressFill"></div></div>
      <div class="import-progress-text"><span id="importProgressLabel">0/0</span><span id="importProgressPercent"></span></div>
    </div>
    <div class="import-songs">${rows}</div>
  `;
}

async function saveImportedPlaylist() {
  if (!importedSongs.length) return;
  const pl = { id: 'p' + Date.now().toString(36), name: importedPlaylistName, songs: importedSongs };
  localPlaylists.push(pl);
  await saveLocalPlaylists();
  renderPlaylists();
  showToast(`Saved "${importedPlaylistName}"`);
}

async function cacheImportedSongs() {
  if (!navigator.onLine) return showToast('Cannot cache while offline');
  if (!importedSongs.length) return;

  const wrap = document.getElementById('importProgressWrap');
  const fill = document.getElementById('importProgressFill');
  const label = document.getElementById('importProgressLabel');
  const percent = document.getElementById('importProgressPercent');
  const rows = document.querySelectorAll('.import-song-row .import-song-status');
  wrap.classList.remove('hidden');

  let ok = 0;
  for (let i = 0; i < importedSongs.length; i++) {
    const song = importedSongs[i];
    const statusEl = rows[i];
    if (cachedSongs.has(song.videoId)) {
      ok++;
      statusEl.textContent = 'cached';
      statusEl.className = 'import-song-status ok';
    } else {
      try {
        statusEl.textContent = 'caching...';
        await cacheSongToIndexedDB(song);
        ok++;
        statusEl.textContent = 'cached';
        statusEl.className = 'import-song-status ok';
      } catch (e) {
        statusEl.textContent = 'failed';
        statusEl.className = 'import-song-status fail';
      }
    }
    const pct = Math.round((i + 1) / importedSongs.length * 100);
    fill.style.width = pct + '%';
    label.textContent = `${i + 1}/${importedSongs.length}`;
    percent.textContent = pct + '%';
  }

  showToast(`${ok} of ${importedSongs.length} songs cached for offline!`);
  renderCached();
}

// ====== Toast ======
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ====== Init ======
init();
