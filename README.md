# 🎵 Rabbit Music

A local music server for Linux that turns your laptop into a personal music streamer with full offline support on your phone.

## Features

- **YouTube search & streaming** — search any song and play it instantly
- **Import playlists by link** — paste a **Spotify**, **SoundCloud**, **YouTube** or **Lyra** playlist link, the app finds every song on YouTube, lets you save it as a playlist and **cache all songs offline**
- **Offline caching** — download songs to your phone's storage (IndexedDB)
- **PWA (Progressive Web App)** — install it like a native app on your phone
- **Service Worker** — the whole app caches itself so it works even when your laptop is off
- **Play queue, favorites & playlists**
- **Dark blue/black clean UI**
- **Works on any device on your Wi-Fi network**
- **Runs as a permanent systemd service** (auto-start on boot, auto-restart on crash)

## Requirements

- Linux with Node.js 16+
- `ffmpeg` (required for audio extraction) — `sudo apt install ffmpeg`
- `yt-dlp` is bundled auto-downloaded into `bin/` by `start.sh`

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. (Optional) Add a YouTube API key

Search works without a key, but opening the `.env` file and adding a key makes search more reliable:

```
PORT=3000
YOUTUBE_API_KEY=your_actual_key_here
```

> Get a free key at https://console.cloud.google.com/apis/library/youtube.googleapis.com

### 3. Install ffmpeg (required)

```bash
sudo apt install ffmpeg
```

### 4. Start the server

```bash
./start.sh
```

Or manually: `npm start`

> `start.sh` will auto-download the latest `yt-dlp` binary into `bin/` on first run, so streaming always works.

You'll see output like:
```
🎵 Music Server is running!
Local:   http://localhost:3000
Network: http://192.168.0.18:3000
```

## Using on your phone

### On the same Wi-Fi (no setup needed)
1. Make sure your phone is on the **same Wi-Fi network** as the laptop
2. Open your phone browser and go to the **Network URL** shown (e.g. `http://192.168.0.18:3000`)
3. **"Add to Home Screen"** (iOS Safari: share button → Add to Home Screen, Android Chrome: menu → Install app)
4. The app now works like a native music app

### Anywhere (mobile data / any network) — Tailscale (recommended, permanent)

[Tailscale](https://tailscale.com) is a free private VPN that gives you a **permanent address** that never changes and works on any network:

1. On the **laptop**: `sudo ./install-tailscale.sh` (installs Tailscale and signs in)
2. On the **phone**: install the free Tailscale app and sign in with the **same account**
3. Open the permanent address on your phone:
   `https://<your-laptop-name>.tail<your-tailnet>.ts.net:8443/`
   (e.g. `https://mihe-hp-probook-6450b.tail1bc6e6.ts.net:8443/`)
4. Install the PWA from that address — it stays installed forever.

> Port 8443 is used because this laptop's Pi-hole occupies port 443. Run `tailscale serve status` to see the current address.
> The **laptop must be turned on** (with the Rabbit Music service running) for the app to work — but cached/offline songs play regardless.

### Anywhere (mobile data) — optional Cloudflare quick tunnel (backup)

The server also starts a free **cloudflared** tunnel automatically (`bin/cloudflared`). Find the current URL in `tunnel_url.log` (starts with `https://...trycloudflare.com`). This needs no accounts, but the URL **changes on every restart** and is less reliable, so Tailscale is the recommended option.

## Importing a playlist

1. Open the **Playlists** tab
2. Paste a link from **Spotify / SoundCloud / YouTube** (share button → copy link)
3. Tap **Import** — it reads every track and matches each one to a YouTube video
4. **Save to playlists** adds it to your playlist list, **Cache all offline** downloads every song to your phone

> **Lyra** links are usually not readable (the track list needs a signed-in Lyra account) — instead use the **"or paste a track list"** toggle: paste one song per line (`Artist - Title`, `Title by Artist`, or a bare title) and it imports those as a playlist.

## Using offline

- While online, tap the **download icon ⬇** on any song to cache it
- Cached songs play **even when your laptop is off** (stored in your phone's browser storage)
- The **Cached** tab shows all your offline songs and storage usage
- When offline, cached songs play normally — the in-app search works on your cached library too

## Firewall note

If your phone can't reach the server, allow port `3000` through the firewall:
```bash
sudo ufw allow 3000
```

## Project structure

```
├── server.js           # Express server + YouTube API + stream proxy
├── start.sh            # One-command launcher
├── create-icons.js     # Generates PWA app icons
├── package.json
└── public/
    ├── index.html      # UI
    ├── style.css       # Dark blue/black theme
    ├── app.js          # App logic + IndexedDB caching
    ├── sw.js           # Service Worker (offline app cache)
    ├── manifest.json   # PWA manifest
    └── icons/          # App icons
```

## Troubleshooting

- **Phone can't connect** → same Wi-Fi? Firewall blocking port 3000?
- **Song won't play** → install ffmpeg, make sure internet is on
- **Search is slow** → add a YouTube API key in `.env` and restart
