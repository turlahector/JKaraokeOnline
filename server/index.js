/* global process */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { MongoClient } from 'mongodb'
import nodemailer from 'nodemailer'
import ytsr from 'ytsr'

const app = express()
const port = Number(process.env.PORT) || 3001
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim()
const MONGODB_DB_NAME = String(process.env.MONGODB_DB_NAME || 'jkaraoke').trim()
const MONGODB_COLLECTION_NAME = String(process.env.MONGODB_COLLECTION_NAME || 'rooms').trim()
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').trim()
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim()
const SMTP_PORT = Number(process.env.SMTP_PORT || 587)
const SMTP_USER = String(process.env.SMTP_USER || '').trim()
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim()
const SMTP_FROM = String(process.env.SMTP_FROM || '').trim()
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').trim() === 'true'
const REQUIRE_EMAIL_VERIFICATION = String(process.env.REQUIRE_EMAIL_VERIFICATION || 'false').trim() === 'true'
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000
const hostTokens = new Set()
const hostSessions = new Map()
const singerSessions = new Map()
const hostTokenToUser = new Map()
let mongoClient = null
let mongoRoomsCollection = null
let mongoUsersCollection = null
let mongoEmailVerificationsCollection = null
let mongoPasswordResetsCollection = null
let mailTransporter = null

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

const sanitizeRoom = (room) => ({
  currentSong: room?.currentSong ?? null,
  queue: Array.isArray(room?.queue) ? room.queue : [],
})

const normalizeHostUsername = (username) => String(username || '').trim().toLowerCase()
const normalizeEmail = (email) => String(email || '').trim().toLowerCase()
const isValidEmailFormat = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
const hashToken = (value) => createHash('sha256').update(String(value)).digest('hex')
const createPlainToken = () => randomBytes(32).toString('hex')

const resolveAppBaseUrl = (req) => {
  if (APP_BASE_URL) return APP_BASE_URL
  const host = String(req.get('host') || '').trim()
  if (!host) return ''
  return `${req.protocol}://${host}`
}

const ensureEmailDeliveryReady = () => Boolean(mailTransporter && SMTP_FROM)

const sendHostEmailVerification = async ({ email, username, token, req }) => {
  const baseUrl = resolveAppBaseUrl(req)
  if (!baseUrl || !ensureEmailDeliveryReady()) {
    throw new Error('Email delivery is not configured.')
  }

  const verifyUrl = `${baseUrl}/host?verify=${encodeURIComponent(token)}`
  await mailTransporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: 'Verify your JKaraoke host account',
    text: `Hi ${username},\n\nPlease verify your host account by opening this link:\n${verifyUrl}\n\nThis link expires in 24 hours.\n`,
    html: `<p>Hi ${username},</p><p>Please verify your host account by opening this link:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`,
  })
}

const sendHostPasswordResetEmail = async ({ email, username, token, req }) => {
  const baseUrl = resolveAppBaseUrl(req)
  if (!baseUrl || !ensureEmailDeliveryReady()) {
    throw new Error('Email delivery is not configured.')
  }

  const resetUrl = `${baseUrl}/host?reset=${encodeURIComponent(token)}`
  await mailTransporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: 'Reset your JKaraoke host password',
    text: `Hi ${username},\n\nReset your password using this link:\n${resetUrl}\n\nThis link expires in 1 hour.\nIf you did not request this, you can ignore this email.\n`,
    html: `<p>Hi ${username},</p><p>Reset your password using this link:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p><p>If you did not request this, you can ignore this email.</p>`,
  })
}

const loadStateFromMongo = async () => {
  if (!mongoRoomsCollection) return false

  const docs = await mongoRoomsCollection.find({}, { projection: { _id: 0 } }).toArray()
  state.rooms = {}

  for (const doc of docs) {
    const accessToken = String(doc?.accessToken || '').trim()
    if (!accessToken) continue
    state.rooms[accessToken] = sanitizeRoom(doc)
  }

  return docs.length > 0
}

const persistStateToMongo = async () => {
  if (!mongoRoomsCollection) return false

  const entries = Object.entries(state.rooms)
  if (entries.length === 0) {
    await mongoRoomsCollection.deleteMany({})
    return true
  }

  await mongoRoomsCollection.bulkWrite(
    entries.map(([accessToken, room]) => ({
      replaceOne: {
        filter: { accessToken },
        replacement: {
          accessToken,
          ...sanitizeRoom(room),
        },
        upsert: true,
      },
    })),
    { ordered: false },
  )

  const activeTokens = entries.map(([accessToken]) => accessToken)
  await mongoRoomsCollection.deleteMany({ accessToken: { $nin: activeTokens } })
  return true
}

const initializeMongoStorage = async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI is not set. State will be in-memory only.')
    return false
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI)
    await mongoClient.connect()
    const db = mongoClient.db(MONGODB_DB_NAME)
    mongoRoomsCollection = db.collection(MONGODB_COLLECTION_NAME)
    mongoUsersCollection = db.collection('host_users')
    mongoEmailVerificationsCollection = db.collection('host_email_verifications')
    mongoPasswordResetsCollection = db.collection('host_password_resets')
    await mongoRoomsCollection.createIndex({ accessToken: 1 }, { unique: true })
    await mongoUsersCollection.createIndex({ usernameLower: 1 }, { unique: true })
    await mongoUsersCollection.createIndex(
      { emailLower: 1 },
      {
        unique: true,
        partialFilterExpression: {
          emailLower: { $type: 'string' },
        },
      },
    )
    await mongoEmailVerificationsCollection.createIndex({ tokenHash: 1 }, { unique: true })
    await mongoEmailVerificationsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    await mongoPasswordResetsCollection.createIndex({ tokenHash: 1 }, { unique: true })
    await mongoPasswordResetsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })

    if (SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM) {
      try {
        mailTransporter = nodemailer.createTransport({
          host: SMTP_HOST,
          port: SMTP_PORT,
          secure: SMTP_SECURE,
          auth: {
            user: SMTP_USER,
            pass: SMTP_PASS,
          },
        })
        await mailTransporter.verify()
      } catch (smtpError) {
        mailTransporter = null
        console.error('SMTP login failed. Email features are disabled until SMTP settings are fixed:', smtpError)
      }
    } else {
      mailTransporter = null
      console.warn('SMTP settings are incomplete. Verification and password reset emails are disabled.')
    }
    console.log(`MongoDB connected (${MONGODB_DB_NAME}.${MONGODB_COLLECTION_NAME})`)
    return true
  } catch (error) {
    console.error('MongoDB connection failed. State will be in-memory only:', error)
    mongoClient = null
    mongoRoomsCollection = null
    mongoUsersCollection = null
    mongoEmailVerificationsCollection = null
    mongoPasswordResetsCollection = null
    mailTransporter = null
    return false
  }
}

const loadState = async () => {
  const mongoEnabled = await initializeMongoStorage()
  if (!mongoEnabled) {
    return
  }

  try {
    await loadStateFromMongo()
  } catch (error) {
    console.error('Failed to load state from MongoDB:', error)
  }
}

const persistState = async () => {
  if (!mongoRoomsCollection) {
    return
  }

  try {
    await persistStateToMongo()
  } catch (error) {
    console.error('Failed to persist state to MongoDB:', error)
  }
}

const parseDurationToSeconds = (durationText) => {
  if (!durationText) return 0
  const parts = durationText.split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

const EMBED_CHECK_TIMEOUT_MS = 2500
const SEARCH_CANDIDATE_LIMIT = 18
const SEARCH_RESULT_LIMIT = 10

const buildKaraokeSearchQuery = (rawQuery) => {
  const trimmed = String(rawQuery || '').trim()
  if (!trimmed) return ''

  const normalized = trimmed.toLowerCase()
  if (normalized.includes('karaoke')) {
    return trimmed
  }

  return `${trimmed} karaoke`
}

const mapVideoSearchResult = (video) => ({
  videoId: video.id,
  title: video.title,
  channel: video.author?.name || 'Unknown channel',
  duration: video.duration || 'N/A',
  durationSeconds: parseDurationToSeconds(video.duration),
  thumbnail: video.bestThumbnail?.url || '',
  url: `https://www.youtube.com/watch?v=${video.id}`,
})

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), EMBED_CHECK_TIMEOUT_MS)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

const checkEmbeddableViaEmbedPage = async (videoId) => {
  const embedUrl = `https://www.youtube.com/embed/${videoId}`
  const response = await fetchWithTimeout(embedUrl, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'text/html',
    },
  })

  if (!response.ok) {
    return 'unknown'
  }

  const html = await response.text()
  const normalized = html.toLowerCase()

  if (normalized.includes('"playableinembed":false')) {
    return 'likely_blocked'
  }
  if (normalized.includes('"playableinembed":true')) {
    return 'likely_embeddable'
  }
  if (normalized.includes('playback on other websites has been disabled by the video owner')) {
    return 'likely_blocked'
  }

  return 'unknown'
}

const checkVideoEmbeddable = async (videoId) => {
  if (!videoId) return 'unknown'

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`
    const oembedResponse = await fetchWithTimeout(oembedUrl, { method: 'GET' })

    // If oEmbed already says no, treat as blocked immediately.
    if (!oembedResponse.ok) {
      return 'likely_blocked'
    }

    // oEmbed can still be true for some videos that fail inside iframe.
    const embedPageStatus = await checkEmbeddableViaEmbedPage(videoId)
    if (embedPageStatus !== 'unknown') {
      return embedPageStatus
    }

    return 'likely_embeddable'
  } catch {
    return 'unknown'
  }
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

app.get('/api/host/check-username', async (req, res) => {
  if (!mongoUsersCollection) {
    return res.status(503).json({ error: 'Username check is unavailable. MongoDB connection is required.' })
  }

  const username = String(req.query?.username || '').trim()
  const usernameLower = normalizeHostUsername(username)

  if (!usernameLower || username.length < 3) {
    return res.status(400).json({
      available: false,
      message: 'Username must be at least 3 characters.',
    })
  }

  try {
    const existingUser = await mongoUsersCollection.findOne({ usernameLower }, { projection: { _id: 1 } })
    if (existingUser) {
      return res.json({
        available: false,
        message: 'Username already exists. Please choose another one.',
      })
    }

    return res.json({
      available: true,
      message: 'Username is available.',
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to validate username. Please try again.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/host/check-email', async (req, res) => {
  if (!mongoUsersCollection) {
    return res.status(503).json({ error: 'Email check is unavailable. MongoDB connection is required.' })
  }

  const email = String(req.query?.email || '').trim()
  const emailLower = normalizeEmail(email)

  if (!emailLower || !isValidEmailFormat(emailLower)) {
    return res.status(400).json({
      available: false,
      message: 'Please enter a valid email address.',
    })
  }

  try {
    const existingUser = await mongoUsersCollection.findOne({ emailLower }, { projection: { _id: 1 } })
    if (existingUser) {
      return res.json({
        available: false,
        message: 'Email is already taken. Please login or use another email.',
      })
    }

    return res.json({
      available: true,
      message: 'Email is available.',
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to validate email. Please try again.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/host/signup', async (req, res) => {
  if (!mongoUsersCollection || !mongoEmailVerificationsCollection) {
    return res.status(503).json({ error: 'Signup is unavailable. MongoDB connection is required.' })
  }

  const username = String(req.body?.username || '').trim()
  const email = String(req.body?.email || '').trim()
  const password = String(req.body?.password || '')
  const usernameLower = normalizeHostUsername(username)
  const emailLower = normalizeEmail(email)

  if (!usernameLower) {
    return res.status(400).json({ error: 'Username is required.' })
  }
  if (!emailLower) {
    return res.status(400).json({ error: 'Email is required.' })
  }
  if (!isValidEmailFormat(emailLower)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' })
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' })
  }

  try {
    const existingUsername = await mongoUsersCollection.findOne({ usernameLower }, { projection: { _id: 1 } })
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already exists. Please choose another one.' })
    }
    const existingEmail = await mongoUsersCollection.findOne({ emailLower }, { projection: { _id: 1 } })
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already exists. Please login or use another email.' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const createdAt = new Date().toISOString()
    const shouldRequireVerification = REQUIRE_EMAIL_VERIFICATION && ensureEmailDeliveryReady()
    const insertedUser = await mongoUsersCollection.insertOne({
      username,
      usernameLower,
      email,
      emailLower,
      passwordHash,
      emailVerified: !shouldRequireVerification,
      createdAt,
    })

    if (shouldRequireVerification) {
      const plainToken = createPlainToken()
      const tokenHash = hashToken(plainToken)
      const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS)
      await mongoEmailVerificationsCollection.deleteMany({ userId: insertedUser.insertedId })
      await mongoEmailVerificationsCollection.insertOne({
        userId: insertedUser.insertedId,
        tokenHash,
        createdAt,
        expiresAt,
      })

      try {
        await sendHostEmailVerification({ email, username, token: plainToken, req })
      } catch (mailError) {
        await mongoEmailVerificationsCollection.deleteMany({ userId: insertedUser.insertedId })
        await mongoUsersCollection.deleteOne({ _id: insertedUser.insertedId })
        throw mailError
      }

      return res.status(201).json({
        ok: true,
        message: 'Host account created. Please check your email and verify your account before login.',
      })
    }

    return res.status(201).json({
      ok: true,
      message: 'Host account created successfully. You can now login.',
    })
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'Username or email already exists.' })
    }

    return res.status(500).json({
      error: 'Failed to create account. Please try again.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/host/login', async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const requestedSingerAccessToken = String(req.body?.singerAccessToken || '').trim()
  const reuseSingerAccessToken = req.body?.reuseSingerAccessToken !== false
  const usernameLower = normalizeHostUsername(username)

  if (!usernameLower || !password) {
    return res.status(400).json({ error: 'Username and password are required.' })
  }

  if (!mongoUsersCollection) {
    return res.status(503).json({ error: 'Login is unavailable. MongoDB connection is required.' })
  }

  const user = await mongoUsersCollection.findOne({ usernameLower })
  const isPasswordValid = user?.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false
  if (!user || !isPasswordValid) {
    return res.status(401).json({ error: 'Invalid username or password.' })
  }
  if (REQUIRE_EMAIL_VERIFICATION && !user.emailVerified) {
    return res.status(403).json({
      error: 'Please verify your email before logging in.',
      code: 'EMAIL_NOT_VERIFIED',
    })
  }

  const token = crypto.randomUUID()
  const singerAccessToken =
    reuseSingerAccessToken && requestedSingerAccessToken ? requestedSingerAccessToken : crypto.randomUUID()
  hostTokens.add(token)
  hostTokenToUser.set(token, user.username)
  hostSessions.set(token, singerAccessToken)
  getRoomByToken(singerAccessToken)
  await persistState()
  return res.json({ token, singerAccessToken, username: user.username })
})

app.get('/api/host/verify-email', async (req, res) => {
  if (!mongoUsersCollection || !mongoEmailVerificationsCollection) {
    return res.status(503).json({ error: 'Email verification is unavailable right now.' })
  }

  const token = String(req.query?.token || '').trim()
  if (!token) {
    return res.status(400).json({ error: 'Verification token is required.' })
  }

  const tokenHash = hashToken(token)
  const verification = await mongoEmailVerificationsCollection.findOne({ tokenHash })
  if (!verification || new Date(verification.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Verification link is invalid or expired.' })
  }

  await mongoUsersCollection.updateOne(
    { _id: verification.userId },
    {
      $set: {
        emailVerified: true,
        emailVerifiedAt: new Date().toISOString(),
      },
    },
  )
  await mongoEmailVerificationsCollection.deleteMany({ userId: verification.userId })
  return res.json({ ok: true, message: 'Email verified successfully. You can now login.' })
})

app.post('/api/host/password/forgot', async (req, res) => {
  if (!mongoUsersCollection || !mongoPasswordResetsCollection) {
    return res.status(503).json({ error: 'Password reset is unavailable right now.' })
  }
  if (!ensureEmailDeliveryReady()) {
    return res.status(503).json({ error: 'Password reset email service is not configured.' })
  }

  const email = String(req.body?.email || '').trim()
  const emailLower = normalizeEmail(email)
  if (!emailLower || !isValidEmailFormat(emailLower)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' })
  }

  const user = await mongoUsersCollection.findOne({ emailLower })
  if (user) {
    const plainToken = createPlainToken()
    const tokenHash = hashToken(plainToken)
    const nowIso = new Date().toISOString()
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS)

    await mongoPasswordResetsCollection.deleteMany({ userId: user._id })
    await mongoPasswordResetsCollection.insertOne({
      userId: user._id,
      tokenHash,
      createdAt: nowIso,
      expiresAt,
    })
    await sendHostPasswordResetEmail({
      email: user.email || email,
      username: user.username || 'Host',
      token: plainToken,
      req,
    })
  }

  return res.json({
    ok: true,
    message: 'If that email exists, a password reset link has been sent.',
  })
})

app.post('/api/host/password/reset', async (req, res) => {
  if (!mongoUsersCollection || !mongoPasswordResetsCollection) {
    return res.status(503).json({ error: 'Password reset is unavailable right now.' })
  }

  const token = String(req.body?.token || '').trim()
  const newPassword = String(req.body?.newPassword || '')
  if (!token) {
    return res.status(400).json({ error: 'Reset token is required.' })
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' })
  }

  const tokenHash = hashToken(token)
  const resetToken = await mongoPasswordResetsCollection.findOne({ tokenHash })
  if (!resetToken || new Date(resetToken.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Reset link is invalid or expired.' })
  }

  const passwordHash = await bcrypt.hash(newPassword, 12)
  await mongoUsersCollection.updateOne(
    { _id: resetToken.userId },
    {
      $set: {
        passwordHash,
        updatedAt: new Date().toISOString(),
      },
    },
  )
  await mongoPasswordResetsCollection.deleteMany({ userId: resetToken.userId })
  return res.json({ ok: true, message: 'Password reset successful. You can now login.' })
})

app.get('/api/host/verify', (req, res) => {
  const token = getHostTokenFromRequest(req)
  if (!isValidHostToken(token)) {
    return res.status(401).json({ ok: false })
  }

  return res.json({
    ok: true,
    singerAccessToken: getSingerAccessTokenForHost(token),
    username: hostTokenToUser.get(token) || '',
  })
})

app.post('/api/host/logout', (req, res) => {
  const token = getHostTokenFromRequest(req)
  if (token) {
    hostTokens.delete(token)
    hostSessions.delete(token)
    hostTokenToUser.delete(token)
  }

  return res.status(204).send()
})

app.post('/api/host/token/rotate', requireHostAuth, (req, res) => {
  const oldToken = getHostTokenFromRequest(req)
  const newToken = crypto.randomUUID()
  const singerAccessToken = getSingerAccessTokenForHost(oldToken)
  const existingUsername = hostTokenToUser.get(oldToken)

  if (oldToken) {
    hostTokens.delete(oldToken)
    hostSessions.delete(oldToken)
    hostTokenToUser.delete(oldToken)
  }

  hostTokens.add(newToken)
  if (existingUsername) {
    hostTokenToUser.set(newToken, existingUsername)
  }
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
  await persistState()
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
    const candidates = results.items
      .filter((item) => item.type === 'video')
      .slice(0, SEARCH_CANDIDATE_LIMIT)

    const prechecked = await Promise.all(
      candidates.map(async (video) => {
        const embeddableStatus = await checkVideoEmbeddable(video.id)
        return {
          ...mapVideoSearchResult(video),
          embeddableStatus,
          isLikelyEmbeddable: embeddableStatus === 'likely_embeddable',
        }
      }),
    )

    const priority = {
      likely_embeddable: 0,
      unknown: 1,
      likely_blocked: 2,
    }

    const sortedVideos = prechecked.sort(
      (a, b) => priority[a.embeddableStatus] - priority[b.embeddableStatus],
    )

    const filteredVideos = sortedVideos.filter((video) => video.embeddableStatus !== 'likely_blocked')
    const selectedVideos = (filteredVideos.length > 0 ? filteredVideos : sortedVideos).slice(
      0,
      SEARCH_RESULT_LIMIT,
    )

    return res.json({ items: selectedVideos })
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

  const embeddableStatus = await checkVideoEmbeddable(song.videoId)
  if (embeddableStatus === 'likely_blocked') {
    return res.status(422).json({
      error: 'This song is likely blocked for embedded playback. Please choose another video.',
      code: 'VIDEO_NOT_EMBEDDABLE',
      embeddableStatus,
    })
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
      embeddableStatus,
    },
    createdAt: new Date().toISOString(),
  }

  const room = getRoomByToken(accessToken)
  room.queue.push(reservation)
  await persistState()
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
    await persistState()
    return res.status(200).json(getRoomStateResponse(accessToken))
  }

  const nextReservation = room.queue.shift()
  room.currentSong = nextReservation
  await persistState()
  return res.json(getRoomStateResponse(accessToken))
})

app.post('/api/current/clear', requireHostAuth, async (req, res) => {
  const hostToken = getHostTokenFromRequest(req)
  const accessToken = getAccessTokenFromRequest(req) || getSingerAccessTokenForHost(hostToken)
  const room = getRoomByToken(accessToken)
  if (room) {
    room.currentSong = null
  }
  await persistState()
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

  await persistState()
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

  await persistState()
  return res.json(getRoomStateResponse(accessToken))
})

loadState()
  .finally(() => {
    app.listen(port, () => {
      console.log(`Videoke API server listening on http://localhost:${port}`)
    })
  })
