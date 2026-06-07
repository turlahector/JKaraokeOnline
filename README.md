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

## MongoDB Atlas persistence

If you want persistent cloud storage, set these backend env vars:

- `MONGODB_URI` (required for persistence)
- `MONGODB_DB_NAME` (optional, default: `jkaraoke`)
- `MONGODB_COLLECTION_NAME` (optional, default: `rooms`)

Example:

```bash
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster-url>/?retryWrites=true&w=majority
MONGODB_DB_NAME=jkaraoke
MONGODB_COLLECTION_NAME=rooms
```

When `MONGODB_URI` is present, the API reads/writes room state in MongoDB.
If it is missing, room state is kept in memory only (resets on server restart).

## Host account authentication

- Hardcoded host credentials were removed.
- Use the `/host` page to create a host account (`Sign Up`) and then login.
- Host accounts are stored in MongoDB (`host_users` collection) with hashed passwords.
- Email is required for signup.
- Host login is allowed only after email verification.
- Forgot/reset password is supported through email links.

### Email delivery env vars (required for signup verification and reset password)

- `APP_BASE_URL` (frontend base URL used in email links, e.g. `https://your-frontend.vercel.app`)
- `SMTP_HOST`
- `SMTP_PORT` (e.g. `587`)
- `SMTP_SECURE` (`true` for SSL port 465, otherwise `false`)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` (sender email, e.g. `JKaraoke <no-reply@yourdomain.com>`)
- `REQUIRE_EMAIL_VERIFICATION` (`true` or `false`, default: `false`)

If `REQUIRE_EMAIL_VERIFICATION=false`, signup still collects and validates email but allows login immediately (no verification email required).
