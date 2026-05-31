# JKaraoke

JKaraoke is a React + Node.js app for videoke reservations:

- `Singer Request` view (`/singer`): users save their name in browser session, search songs from YouTube, and reserve songs.
- `Host Control` view (`/host`): host (iPad/TV) starts the next reserved song and shows the now-playing video.

## Run locally

1. Install dependencies:

```bash
npm install
```

1. Start frontend + API server:

```bash
npm run dev
```

1. Open:

- `http://localhost:5173/singer` for singer users
- `http://localhost:5173/host` for iPad/TV host view

## Use on different devices

- Make sure your phone and iPad are on the same Wi-Fi as your computer.
- Find your computer LAN IP (example `192.168.1.15`).
- Open:
  - `http://<LAN-IP>:5173/singer`
  - `http://<LAN-IP>:5173/host`

Queue and current song state are saved locally to `server/data/state.json`.
