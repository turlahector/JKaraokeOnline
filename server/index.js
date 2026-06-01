/* global process */
import cors from 'cors'
import express from 'express'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ytsr from 'ytsr'

const app = express()
const port = Number(process.env.PORT) || 3001
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDirectory = path.join(__dirname, 'data')
const stateFilePath = path.join(dataDirectory, 'state.json')
const HOST_USERNAME = 'Jay'
const HOST_PASSWORD = '23161707'
const hostTokens = new Set()
const hostSessions = new Map()
const singerSessions = new Map()

app.use(cors())
app.use(express.json())

const createEmptyRoom = () => ({
  currentSong: null,
  queue: [],
})

const state = {
  rooms: {},
}

const getRoomByToken = (accessToken) => {
  if (!accessToken) return null
  if (!state.rooms[accessToken]) {
    state.rooms[accessToken] = createEmptyRoom()
  }
  return state.rooms[accessToken]
}

const getAccessTokenFromRequest = (req) =>
  String(req.query?.accessToken || req.body?.accessToken || req.header('x-singer-access-token') || '').trim()

const getRoomStateResponse = (accessToken) => {
  if (!accessToken) {
    return {
      accessToken: '',
      currentSong: null,
      queue: [],
    }
  }
  const room = getRoomByToken(accessToken)
  return {
    accessToken,
    currentSong: room?.currentSong ?? null,
    queue: room?.queue ?? [],
  }
}

const loadStateFromDisk = async () => {
  try {
    await mkdir(dataDirectory, { recursive: true })
    const raw = await readFile(stateFilePath, 'utf8')
    const parsed = JSON.parse(raw)

    if (parsed?.rooms && typeof parsed.rooms === 'object') {
      state.rooms = parsed.rooms
      return
    }

    // Migration from old single-queue state format.
    const legacyToken = parsed?.singerAccessToken || crypto.randomUUID()
    state.rooms[legacyToken] = {
      currentSong: parsed?.currentSong ?? null,
      queue: Array.isArray(parsed?.queue) ? parsed.queue : [],
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Failed to load saved queue state:', error)
    }
  }
}

const persistStateToDisk = async () => {
  await mkdir(dataDirectory, { recursive: true })
  await writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf8')
}

const parseDurationToSeconds = (durationText) => {
  if (!durationText) return 0
  const parts = durationText.split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

const buildKaraokeSearchQuery = (rawQuery) => {
  const trimmed = String(rawQuery || '').trim()
  if (!trimmed) return ''

  const normalized = trimmed.toLowerCase()
  if (normalized.includes('karaoke')) {
    return trimmed
  }

  return `${trimmed} karaoke`
}

const isValidHostToken = (token) => Boolean(token && hostTokens.has(token))
const isValidSingerToken = (token) => Boolean(token && singerSessions.has(token))

const getHostTokenFromRequest = (req) => String(req.header('x-host-token') || '').trim()
const getSingerAccessTokenForHost = (hostToken) => String(hostSessions.get(hostToken) || '').trim()

const requireHostAuth = (req, res, next) => {
  const token = getHostTokenFromRequest(req)
  if (!isValidHostToken(token)) {
    return res.status(401).json({ error: 'Host authentication required.' })
  }

  return next()
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/host/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const requestedSingerAccessToken = String(req.body?.singerAccessToken || '').trim()
  const reuseSingerAccessToken = req.body?.reuseSingerAccessToken !== false

  if (username !== HOST_USERNAME || password !== HOST_PASSWORD) {
    return res.status(401).json({ error: 'Invalid username or password.' })
  }

  const token = crypto.randomUUID()
  const singerAccessToken =
    reuseSingerAccessToken && requestedSingerAccessToken ? requestedSingerAccessToken : crypto.randomUUID()
  hostTokens.add(token)
  hostSessions.set(token, singerAccessToken)
  getRoomByToken(singerAccessToken)
  return res.json({ token, singerAccessToken })
})

app.get('/api/host/verify', (req, res) => {
  const token = getHostTokenFromRequest(req)
  if (!isValidHostToken(token)) {
    return res.status(401).json({ ok: false })
  }

  return res.json({ ok: true, singerAccessToken: getSingerAccessTokenForHost(token) })
})

app.post('/api/host/logout', (req, res) => {
  const token = getHostTokenFromRequest(req)
  if (token) {
    hostTokens.delete(token)
    hostSessions.delete(token)
  }

  return res.status(204).send()
})

app.post('/api/host/token/rotate', requireHostAuth, (req, res) => {
  const oldToken = getHostTokenFromRequest(req)
  const newToken = crypto.randomUUID()
  const singerAccessToken = getSingerAccessTokenForHost(oldToken)

  if (oldToken) {
    hostTokens.delete(oldToken)
    hostSessions.delete(oldToken)
  }

  hostTokens.add(newToken)
  if (singerAccessToken) {
    hostSessions.set(newToken, singerAccessToken)
  }
  return res.json({ token: newToken, singerAccessToken })
})

app.get('/api/singer/access-token', requireHostAuth, (req, res) => {
  const hostToken = getHostTokenFromRequest(req)
  const singerAccessToken = getSingerAccessTokenForHost(hostToken)
  if (!singerAccessToken) {
    return res.status(404).json({ error: 'Singer access token not found for this host session.' })
  }

  getRoomByToken(singerAccessToken)
  return res.json({ singerAccessToken })
})

app.post('/api/singer/access-token/rotate', requireHostAuth, async (req, res) => {
  const hostToken = getHostTokenFromRequest(req)
  const singerAccessToken = crypto.randomUUID()
  hostSessions.set(hostToken, singerAccessToken)
  getRoomByToken(singerAccessToken)
  await persistStateToDisk()
  return res.json({ singerAccessToken })
})

app.post('/api/singer/session', (req, res) => {
  const singerName = String(req.body?.singerName || '').trim()
  const accessToken = String(req.body?.accessToken || '').trim()
  if (!singerName) {
    return res.status(400).json({ error: 'Singer name is required.' })
  }

  if (!accessToken || !state.rooms[accessToken]) {
    return res.status(403).json({ error: 'Invalid singer access link. Ask host for a new URL.' })
  }

  const singerToken = crypto.randomUUID()
  const singerSessionId = crypto.randomUUID().split('-')[0].toUpperCase()

  singerSessions.set(singerToken, {
    singerName,
    singerSessionId,
    accessToken,
    createdAt: new Date().toISOString(),
  })

  return res.json({ singerName, singerToken, singerSessionId })
})

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) {
    return res.status(400).json({ error: 'Search query is required.' })
  }

  try {
    const karaokeQuery = buildKaraokeSearchQuery(q)
    const results = await ytsr(karaokeQuery, { limit: 20 })
    const videos = results.items
      .filter((item) => item.type === 'video')
      .slice(0, 10)
      .map((video) => ({
        videoId: video.id,
        title: video.title,
        channel: video.author?.name || 'Unknown channel',
        duration: video.duration || 'N/A',
        durationSeconds: parseDurationToSeconds(video.duration),
        thumbnail: video.bestThumbnail?.url || '',
        url: `https://www.youtube.com/watch?v=${video.id}`,
      }))

    return res.json({ items: videos })
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to search YouTube. Please try again.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/state', (req, res) => {
  const hostToken = getHostTokenFromRequest(req)
  const accessToken = getAccessTokenFromRequest(req) || getSingerAccessTokenForHost(hostToken)
  return res.json(getRoomStateResponse(accessToken))
})

app.post('/api/reservations', async (req, res) => {
  const singerName = String(req.body?.singerName || '').trim()
  const singerToken = String(req.body?.singerToken || '').trim()
  const singerSessionId = String(req.body?.singerSessionId || '').trim()
  const accessToken = String(req.body?.accessToken || '').trim()
  const song = req.body?.song

  if (!singerName) {
    return res.status(400).json({ error: 'Singer name is required.' })
  }

  if (!isValidSingerToken(singerToken)) {
    return res.status(401).json({ error: 'Singer session expired. Please login again.' })
  }

  const singerSession = singerSessions.get(singerToken)
  if (!singerSession || singerSession.singerName !== singerName) {
    return res.status(403).json({ error: 'Singer session mismatch. Please login again.' })
  }
  if (!accessToken || singerSession.accessToken !== accessToken) {
    return res.status(403).json({ error: 'Singer session is not valid for this URL token.' })
  }

  if (!song?.videoId || !song?.title) {
    return res.status(400).json({ error: 'Song is invalid.' })
  }

  const reservation = {
    id: crypto.randomUUID(),
    singerName,
    singerToken,
    singerSessionId: singerSessionId || singerSession.singerSessionId,
    song: {
      videoId: song.videoId,
      title: song.title,
      channel: song.channel || 'Unknown channel',
      duration: song.duration || 'N/A',
      durationSeconds: Number(song.durationSeconds) || 0,
      thumbnail: song.thumbnail || '',
      url: `https://www.youtube.com/watch?v=${song.videoId}`,
    },
    createdAt: new Date().toISOString(),
  }

  const room = getRoomByToken(accessToken)
  room.queue.push(reservation)
  await persistStateToDisk()
  return res.status(201).json({ reservation, state: getRoomStateResponse(accessToken) })
})

app.post('/api/current/next', requireHostAuth, async (req, res) => {
  const hostToken = getHostTokenFromRequest(req)
  const accessToken = getAccessTokenFromRequest(req) || getSingerAccessTokenForHost(hostToken)
  const room = getRoomByToken(accessToken)

  if (!room || room.queue.length === 0) {
    if (room) {
      room.currentSong = null
    }
    await persistStateToDisk()
    return res.status(200).json(getRoomStateResponse(accessToken))
  }

  const nextReservation = room.queue.shift()
  room.currentSong = nextReservation
  await persistStateToDisk()
  return res.json(getRoomStateResponse(accessToken))
})

app.post('/api/current/clear', requireHostAuth, async (req, res) => {
  const hostToken = getHostTokenFromRequest(req)
  const accessToken = getAccessTokenFromRequest(req) || getSingerAccessTokenForHost(hostToken)
  const room = getRoomByToken(accessToken)
  if (room) {
    room.currentSong = null
  }
  await persistStateToDisk()
  return res.json(getRoomStateResponse(accessToken))
})

app.delete('/api/reservations/:id', async (req, res) => {
  const { id } = req.params
  const singerToken = String(req.body?.singerToken || '').trim()
  const hostToken = getHostTokenFromRequest(req)
  const accessToken = getAccessTokenFromRequest(req) || getSingerAccessTokenForHost(hostToken)
  const room = getRoomByToken(accessToken)
  const targetReservation = room?.queue.find((item) => item.id === id)

  if (!targetReservation) {
    return res.status(404).json({ error: 'Reservation not found.' })
  }

  const token = getHostTokenFromRequest(req)
  const isHost = isValidHostToken(token)
  const isOwner = Boolean(singerToken) && singerToken === targetReservation.singerToken

  if (!isHost && !isOwner) {
    return res.status(403).json({ error: 'Not allowed to remove this reservation.' })
  }

  room.queue = room.queue.filter((item) => item.id !== id)

  await persistStateToDisk()
  return res.status(204).send()
})

app.post('/api/reservations/:id/move', requireHostAuth, async (req, res) => {
  const { id } = req.params
  const direction = String(req.body?.direction || '').toLowerCase()
  const hostToken = getHostTokenFromRequest(req)
  const accessToken = getAccessTokenFromRequest(req) || getSingerAccessTokenForHost(hostToken)
  const room = getRoomByToken(accessToken)
  const currentIndex = room?.queue.findIndex((item) => item.id === id) ?? -1

  if (currentIndex === -1) {
    return res.status(404).json({ error: 'Reservation not found.' })
  }

  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'Direction must be "up" or "down".' })
  }

  if (direction === 'up' && currentIndex === 0) {
    return res.json(getRoomStateResponse(accessToken))
  }

  if (direction === 'down' && currentIndex === room.queue.length - 1) {
    return res.json(getRoomStateResponse(accessToken))
  }

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  const temp = room.queue[targetIndex]
  room.queue[targetIndex] = room.queue[currentIndex]
  room.queue[currentIndex] = temp

  await persistStateToDisk()
  return res.json(getRoomStateResponse(accessToken))
})

loadStateFromDisk()
  .finally(() => {
    app.listen(port, () => {
      console.log(`Videoke API server listening on http://localhost:${port}`)
    })
  })
