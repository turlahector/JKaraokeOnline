import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import './App.css'

const POLL_INTERVAL_MS = 3000
const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api'
let youtubeApiPromise

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT)
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise
  }

  youtubeApiPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${YOUTUBE_IFRAME_API_URL}"]`)
    const previousHandler = window.onYouTubeIframeAPIReady

    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousHandler === 'function') {
        previousHandler()
      }
      resolve(window.YT)
    }

    if (!existingScript) {
      const script = document.createElement('script')
      script.src = YOUTUBE_IFRAME_API_URL
      script.async = true
      script.onerror = () => reject(new Error('Failed to load YouTube player API.'))
      document.body.appendChild(script)
    }
  })

  return youtubeApiPromise
}

function formatTime(isoDate) {
  if (!isoDate) return '-'
  return new Date(isoDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function YouTubePlayer({ videoId, title, onEnded }) {
  const containerRef = useRef(null)
  const playerRef = useRef(null)
  const onEndedRef = useRef(onEnded)

  useEffect(() => {
    onEndedRef.current = onEnded
  }, [onEnded])

  useEffect(() => {
    let isUnmounted = false

    loadYouTubeApi()
      .then((YT) => {
        if (isUnmounted || !containerRef.current) return

        if (playerRef.current) {
          playerRef.current.destroy()
          playerRef.current = null
        }

        playerRef.current = new YT.Player(containerRef.current, {
          videoId,
          playerVars: {
            autoplay: 1,
            rel: 0,
            playsinline: 1,
          },
          events: {
            onStateChange: (event) => {
              if (event.data === YT.PlayerState.ENDED) {
                onEndedRef.current?.()
              }
            },
          },
        })
      })
      .catch(() => {})

    return () => {
      isUnmounted = true
      if (playerRef.current) {
        playerRef.current.destroy()
        playerRef.current = null
      }
    }
  }, [videoId])

  return (
    <div className="player-wrapper">
      <div ref={containerRef} className="youtube-player" title={title} />
    </div>
  )
}

function PhoneView({
  singerName,
  singerToken,
  singerSessionId,
  singerAccessTokenFromUrl,
  singerDraft,
  onSingerDraftChange,
  onSaveSinger,
  searchTerm,
  onSearchTermChange,
  onSearchSubmit,
  searchResults,
  queue,
  isSearching,
  isReserving,
  error,
  toastMessage,
  onReserveSong,
  onRemoveReservation,
}) {
  return (
    <main className="layout phone">
      <header className="card">
        <h1>JKaraoke - Singer Request</h1>
        <p>Search a YouTube song and reserve your turn.</p>
      </header>

      {!singerName || !singerToken ? (
        <section className="card">
          <h2>Enter singer name first</h2>
          {!singerAccessTokenFromUrl ? (
            <p className="error">Missing singer access token. Please use the Singer URL from the host screen.</p>
          ) : null}
          <form className="row" onSubmit={onSaveSinger}>
            <input
              value={singerDraft}
              onChange={(event) => onSingerDraftChange(event.target.value)}
              placeholder="Your name"
              required
            />
            <button type="submit" disabled={!singerAccessTokenFromUrl}>
              Save
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Hello, {singerName}!</h2>
            {singerSessionId ? (
              <p className="muted singer-session">Session ID: {singerSessionId}</p>
            ) : null}
            <form className="row" onSubmit={onSearchSubmit}>
              <input
                value={searchTerm}
                onChange={(event) => onSearchTermChange(event.target.value)}
                placeholder="Search YouTube song title"
                required
              />
              <button type="submit" disabled={isSearching}>
                {isSearching ? 'Searching...' : 'Search'}
              </button>
            </form>
          </section>

          <section className="card">
            <h2>Results</h2>
            {searchResults.length === 0 ? (
              <p className="muted">No results yet. Try searching a song title.</p>
            ) : (
              <ul className="list">
                {searchResults.map((item) => (
                  <li key={item.videoId} className="song-item">
                    {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <div className="thumb-placeholder" />}
                    <div>
                      <p className="song-title">{item.title}</p>
                      <p className="muted">
                        {item.channel} - {item.duration}
                      </p>
                    </div>
                    <button type="button" disabled={isReserving} onClick={() => onReserveSong(item)}>
                      Reserve
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="card">
        <h2>Queue</h2>
        {queue.length === 0 ? (
          <p className="muted">No reservations yet.</p>
        ) : (
          <ul className="list">
            {queue.map((reservation, index) => (
              <li key={reservation.id} className="queue-item">
                <div>
                  <p className="song-title">
                    {index + 1}. {reservation.song.title}
                  </p>
                  <p className="muted">
                    Singer: {reservation.singerName} | Reserved at {formatTime(reservation.createdAt)}
                  </p>
                </div>
                {reservation.singerToken === singerToken && (
                  <button type="button" className="danger" onClick={() => onRemoveReservation(reservation.id)}>
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error ? <p className="error">{error}</p> : null}
      {toastMessage ? (
        <div className="toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      ) : null}
    </main>
  )
}

function ScreenView({
  currentSong,
  queue,
  singerAccessToken,
  singerShareUrl,
  singerLinkMessage,
  onStartNext,
  onClearCurrent,
  onMoveReservation,
  onRemoveReservation,
  onSongEnded,
  onCopySingerUrl,
  onHostLogout,
  isLoading,
  error,
}) {
  const nowPlayingRef = useRef(null)
  const [isNowPlayingFullscreen, setIsNowPlayingFullscreen] = useState(false)

  useEffect(() => {
    const syncFullscreenState = () => {
      const fullscreenElement =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement

      setIsNowPlayingFullscreen(fullscreenElement === nowPlayingRef.current)
    }

    document.addEventListener('fullscreenchange', syncFullscreenState)
    document.addEventListener('webkitfullscreenchange', syncFullscreenState)
    syncFullscreenState()

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState)
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState)
    }
  }, [])

  const toggleNowPlayingFullscreen = async () => {
    const target = nowPlayingRef.current
    if (!target) return

    try {
      const fullscreenElement =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement

      if (fullscreenElement === target) {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen()
        }
        return
      }

      if (target.requestFullscreen) {
        await target.requestFullscreen()
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen()
      }
    } catch {
      // Ignore fullscreen errors; some browsers restrict this API.
    }
  }

  return (
    <main className="layout screen">
      <header className="card host-header-card">
        <h1>JKaraoke - Host Control Panel</h1>
        <p>Open this screen on iPad/TV and control the queue here.</p>
      </header>

      <div className="screen-grid">
        <section ref={nowPlayingRef} className="card player-card screen-left-panel">
          <div className="now-playing-header">
            <h2>Now Playing</h2>
            <div className="now-playing-tools">
              <button type="button" className="secondary fullscreen-btn" onClick={toggleNowPlayingFullscreen}>
                {isNowPlayingFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              </button>
            </div>
          </div>
          <section className="reservation-strip-section">
            <div className="reservation-strip-header">
              <h3 className="queue-title">Reserved Songs</h3>
              {isNowPlayingFullscreen && singerShareUrl ? (
                <div className="fullscreen-qr-wrapper" aria-label="Singer QR code">
                  <QRCodeSVG value={singerShareUrl} size={92} bgColor="#ffffff" fgColor="#0f172a" includeMargin />
                </div>
              ) : null}
            </div>
            {queue.length === 0 ? (
              <p className="muted">No reserved songs yet.</p>
            ) : (
              <>
                <div className="reservation-strip" role="list" aria-label="Reserved songs queue">
                  {queue.map((reservation, index) => (
                    <article key={reservation.id} className="reservation-card" role="listitem">
                      <p className="reservation-order">#{index + 1}</p>
                      <p className="reservation-song" title={reservation.song.title}>
                        {reservation.song.title}
                      </p>
                      <p className="reservation-requester" title={reservation.singerName}>
                        Requested by: {reservation.singerName}
                      </p>
                    </article>
                  ))}
                </div>
                <p className="muted strip-hint">Scroll right to view more reserved songs.</p>
              </>
            )}
          </section>

          {currentSong ? (
            <>
              <div className="now-playing-meta">
                <p className="song-title">{currentSong.song.title}</p>
                <p className="muted">Singer: {currentSong.singerName}</p>
              </div>
              <YouTubePlayer
                videoId={currentSong.song.videoId}
                title={currentSong.song.title}
                onEnded={onSongEnded}
              />
            </>
          ) : (
            <p className="muted">No active song. Tap "Start Next Song".</p>
          )}
        </section>

        <aside className="card screen-right-panel">
          <h2>Queue & Controls</h2>
          <section className="host-token-panel">
            <p className="share-title">Share this Singer URL</p>
            <p className="muted token-label">Send this link to singers so they join this exact queue.</p>
            {singerShareUrl ? (
              <div className="qr-wrapper">
                <QRCodeSVG
                  value={singerShareUrl}
                  size={160}
                  bgColor="#ffffff"
                  fgColor="#0f172a"
                  includeMargin
                />
              </div>
            ) : null}
            <code className="token-value">{singerShareUrl || '-'}</code>
            <p className="muted token-hint">Token: {singerAccessToken || '-'}</p>
            <div className="row actions">
              <button type="button" className="copy-url-btn" onClick={onCopySingerUrl} disabled={!singerAccessToken}>
                Copy Singer URL
              </button>
            </div>
            {singerLinkMessage ? <p className="muted token-message">{singerLinkMessage}</p> : null}
          </section>
          <div className="row actions">
            <button type="button" onClick={onStartNext} disabled={isLoading}>
              Next
            </button>
            <button type="button" className="secondary" onClick={onClearCurrent} disabled={isLoading}>
              Clear
            </button>
            <button type="button" className="secondary" onClick={onHostLogout} disabled={isLoading}>
              Logout
            </button>
          </div>
          <p className="muted panel-info">
            {currentSong
              ? `Now singing: ${currentSong.singerName}`
              : 'No active song yet. Tap "Next" to begin.'}
          </p>

          <section className="queue-section">
            <h3 className="queue-title">Upcoming Queue</h3>
            {queue.length === 0 ? (
              <p className="muted">Queue is empty.</p>
            ) : (
              <ul className="list compact-list">
                {queue.map((reservation, index) => (
                  <li key={reservation.id} className="queue-item compact-queue-item">
                    <div>
                      <p className="song-title">
                        {index + 1}. {reservation.song.title}
                      </p>
                      <p className="muted">Singer: {reservation.singerName}</p>
                    </div>
                    <div className="queue-controls vertical-controls">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => onMoveReservation(reservation.id, 'up')}
                        disabled={index === 0 || isLoading}
                        aria-label="Move song up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => onMoveReservation(reservation.id, 'down')}
                        disabled={index === queue.length - 1 || isLoading}
                        aria-label="Move song down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => onRemoveReservation(reservation.id)}
                        disabled={isLoading}
                      >
                        Del
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </main>
  )
}

function ScreenLoginView({
  usernameInput,
  passwordInput,
  onUsernameInputChange,
  onPasswordInputChange,
  onLogin,
  loginError,
}) {
  return (
    <main className="layout screen">
      <header className="card">
        <h1>Host Login</h1>
        <p>Sign in to manage queue and playback controls.</p>
      </header>
      <section className="card">
        <form className="row login-form" onSubmit={onLogin}>
          <input
            value={usernameInput}
            onChange={(event) => onUsernameInputChange(event.target.value)}
            placeholder="Username"
            autoComplete="username"
            required
          />
          <input
            type="password"
            value={passwordInput}
            onChange={(event) => onPasswordInputChange(event.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            required
          />
          <button type="submit">Login</button>
        </form>
        {loginError ? <p className="error">{loginError}</p> : null}
      </section>
    </main>
  )
}

function App() {
  const [currentPath] = useState(() => {
    const { pathname } = window.location
    if (pathname === '/') {
      window.history.replaceState({}, '', '/host')
      return '/host'
    }
    return pathname
  })

  const [singerName, setSingerName] = useState(() => sessionStorage.getItem('videoke_singer_name') || '')
  const [singerToken, setSingerToken] = useState(() => sessionStorage.getItem('videoke_singer_token') || '')
  const [singerSessionId, setSingerSessionId] = useState(
    () => sessionStorage.getItem('videoke_singer_session_id') || '',
  )
  const [singerAccessTokenFromUrl] = useState(() => new URLSearchParams(window.location.search).get('token') || '')
  const [singerDraft, setSingerDraft] = useState(() => sessionStorage.getItem('videoke_singer_name') || '')
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [queue, setQueue] = useState([])
  const [currentSong, setCurrentSong] = useState(null)
  const [isSearching, setIsSearching] = useState(false)
  const [isReserving, setIsReserving] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [toastMessage, setToastMessage] = useState('')
  const [hostToken, setHostToken] = useState(() => sessionStorage.getItem('videoke_host_token') || '')
  const [isHostAuthenticated, setIsHostAuthenticated] = useState(false)
  const [isCheckingHostAuth, setIsCheckingHostAuth] = useState(false)
  const [usernameInput, setUsernameInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [loginError, setLoginError] = useState('')
  const [singerAccessToken, setSingerAccessToken] = useState('')
  const [singerLinkMessage, setSingerLinkMessage] = useState('')

  const isScreenView = useMemo(() => currentPath === '/host' || currentPath === '/screen', [currentPath])
  const singerShareUrl = singerAccessToken
    ? `${window.location.origin}/singer?token=${encodeURIComponent(singerAccessToken)}`
    : ''

  const fetchSingerAccessToken = async (token) => {
    const response = await fetch('/api/singer/access-token', {
      headers: {
        'x-host-token': token,
      },
    })

    if (!response.ok) {
      throw new Error('Failed to load singer URL token.')
    }

    const data = await response.json()
    setSingerAccessToken(data.singerAccessToken || '')
  }

  const refreshState = async (accessToken) => {
    try {
      const query = accessToken ? `?accessToken=${encodeURIComponent(accessToken)}` : ''
      const response = await fetch(`/api/state${query}`)
      const data = await response.json()
      setQueue(data.queue ?? [])
      setCurrentSong(data.currentSong ?? null)
      setError('')
    } catch {
      setError('Cannot connect to API server. Make sure npm run dev is running.')
    }
  }

  const activeQueueAccessToken = isScreenView ? singerAccessToken : singerAccessTokenFromUrl

  useEffect(() => {
    if (!activeQueueAccessToken) {
      return undefined
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshState(activeQueueAccessToken)
    const interval = setInterval(() => {
      refreshState(activeQueueAccessToken)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [activeQueueAccessToken])

  useEffect(() => {
    if (!toastMessage) return undefined

    const timeoutId = setTimeout(() => {
      setToastMessage('')
    }, 2500)

    return () => clearTimeout(timeoutId)
  }, [toastMessage])

  useEffect(() => {
    if (!isScreenView) return

    if (!hostToken) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsHostAuthenticated(false)
      return
    }

    setIsCheckingHostAuth(true)
    fetch('/api/host/verify', {
      headers: {
        'x-host-token': hostToken,
      },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Unauthorized')
        }
        setIsHostAuthenticated(true)
        setLoginError('')
        return fetchSingerAccessToken(hostToken)
      })
      .catch(() => {
        sessionStorage.removeItem('videoke_host_token')
        setHostToken('')
        setIsHostAuthenticated(false)
        setLoginError('Please login again.')
        setSingerAccessToken('')
      })
      .finally(() => {
        setIsCheckingHostAuth(false)
      })
  }, [hostToken, isScreenView])

  const clearSingerSession = () => {
    sessionStorage.removeItem('videoke_singer_name')
    sessionStorage.removeItem('videoke_singer_token')
    sessionStorage.removeItem('videoke_singer_session_id')
    setSingerName('')
    setSingerToken('')
    setSingerSessionId('')
  }

  const handleSaveSinger = async (event) => {
    event.preventDefault()
    const cleanName = singerDraft.trim()
    if (!cleanName) return
    if (!singerAccessTokenFromUrl) {
      setError('Missing singer access token. Please use the Singer URL from host.')
      return
    }

    setError('')
    try {
      const response = await fetch('/api/singer/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ singerName: cleanName, accessToken: singerAccessTokenFromUrl }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to start singer session.')
      }

      sessionStorage.setItem('videoke_singer_name', data.singerName)
      sessionStorage.setItem('videoke_singer_token', data.singerToken)
      sessionStorage.setItem('videoke_singer_session_id', data.singerSessionId)
      setSingerName(data.singerName)
      setSingerToken(data.singerToken)
      setSingerSessionId(data.singerSessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start singer session.')
    }
  }

  const handleSearch = async (event) => {
    event.preventDefault()
    const query = searchTerm.trim()
    if (!query) return

    setIsSearching(true)
    setError('')
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to search songs.')
      }

      setSearchResults(data.items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.')
    } finally {
      setIsSearching(false)
    }
  }

  const handleReserveSong = async (song) => {
    if (!singerName || !singerToken || !singerAccessTokenFromUrl) {
      setError('Please login with your singer name first.')
      return
    }

    setIsReserving(true)
    setError('')
    try {
      const response = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          singerName,
          singerToken,
          singerSessionId,
          accessToken: singerAccessTokenFromUrl,
          song,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        if (response.status === 401) {
          clearSingerSession()
        }
        throw new Error(data.error || 'Reservation failed.')
      }

      setQueue(data.state?.queue ?? [])
      setToastMessage('Successfully added to reservation list.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reservation failed.')
    } finally {
      setIsReserving(false)
    }
  }

  const handleRemoveReservation = async (reservationId) => {
    try {
      const response = await fetch(`/api/reservations/${reservationId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ singerToken, accessToken: singerAccessTokenFromUrl }),
      })
      if (!response.ok && response.status !== 204) {
        const data = await response.json()
        if (response.status === 401) {
          clearSingerSession()
        }
        throw new Error(data.error || 'Failed to remove reservation.')
      }
      refreshState(singerAccessTokenFromUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove reservation.')
    }
  }

  const handleHostAuthExpired = () => {
    sessionStorage.removeItem('videoke_host_token')
    setHostToken('')
    setIsHostAuthenticated(false)
    setLoginError('Host session expired. Please login again.')
    setError('Host session expired. Please login again.')
    setSingerLinkMessage('')
    setSingerAccessToken('')
  }

  const handleHostRemoveReservation = async (reservationId) => {
    if (!hostToken || !singerAccessToken) {
      setError('Host login required.')
      return
    }

    setIsLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/reservations/${reservationId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-host-token': hostToken,
        },
        body: JSON.stringify({ accessToken: singerAccessToken }),
      })
      if (response.status === 401) {
        handleHostAuthExpired()
        return
      }
      if (!response.ok && response.status !== 204) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to remove reservation.')
      }
      await refreshState(singerAccessToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove reservation.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleMoveReservation = async (reservationId, direction) => {
    if (!hostToken || !singerAccessToken) {
      setError('Host login required.')
      return
    }

    setIsLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/reservations/${reservationId}/move`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-host-token': hostToken,
        },
        body: JSON.stringify({ direction, accessToken: singerAccessToken }),
      })
      if (response.status === 401) {
        handleHostAuthExpired()
        return
      }
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to reorder reservation.')
      }

      setQueue(data.queue ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder reservation.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleStartNext = async () => {
    if (!hostToken || !singerAccessToken) {
      setError('Host login required.')
      return
    }

    setIsLoading(true)
    setError('')
    try {
      const response = await fetch('/api/current/next', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-host-token': hostToken,
        },
        body: JSON.stringify({ accessToken: singerAccessToken }),
      })
      if (response.status === 401) {
        handleHostAuthExpired()
        return
      }
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to start next song.')
      }

      setCurrentSong(data.currentSong ?? null)
      setQueue(data.queue ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start next song.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleClearCurrent = async () => {
    if (!hostToken || !singerAccessToken) {
      setError('Host login required.')
      return
    }

    setIsLoading(true)
    setError('')
    try {
      const response = await fetch('/api/current/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-host-token': hostToken,
        },
        body: JSON.stringify({ accessToken: singerAccessToken }),
      })
      if (response.status === 401) {
        handleHostAuthExpired()
        return
      }
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to clear current song.')
      }

      setCurrentSong(data.currentSong ?? null)
      setQueue(data.queue ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear current song.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleHostLogin = async (event) => {
    event.preventDefault()
    setLoginError('')

    try {
      const response = await fetch('/api/host/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameInput,
          password: passwordInput,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.token) {
        throw new Error(data.error || 'Invalid username or password.')
      }

      sessionStorage.setItem('videoke_host_token', data.token)
      setHostToken(data.token)
      setIsHostAuthenticated(true)
      setUsernameInput('')
      setPasswordInput('')
      setSingerLinkMessage('')
      await fetchSingerAccessToken(data.token)
      return
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Invalid username or password.')
    }
  }

  const handleHostLogout = async () => {
    if (hostToken) {
      try {
        await fetch('/api/host/logout', {
          method: 'POST',
          headers: {
            'x-host-token': hostToken,
          },
        })
      } catch {
        // Ignore logout network errors and clear local auth anyway.
      }
    }

    sessionStorage.removeItem('videoke_host_token')
    setHostToken('')
    setIsHostAuthenticated(false)
    setSingerLinkMessage('')
    setSingerAccessToken('')
  }

  const handleCopySingerUrl = async () => {
    if (!singerAccessToken) return

    try {
      await navigator.clipboard.writeText(singerShareUrl)
      setSingerLinkMessage('Singer URL copied to clipboard.')
    } catch {
      setSingerLinkMessage('Failed to copy singer URL. Please copy manually.')
    }
  }

  return (
    <>
      {isScreenView ? (
        isCheckingHostAuth ? (
          <main className="layout screen">
            <section className="card">
              <p className="muted">Checking host access...</p>
            </section>
          </main>
        ) : isHostAuthenticated ? (
          <ScreenView
            currentSong={currentSong}
            queue={queue}
            singerAccessToken={singerAccessToken}
            singerShareUrl={singerShareUrl}
            singerLinkMessage={singerLinkMessage}
            onStartNext={handleStartNext}
            onClearCurrent={handleClearCurrent}
            onMoveReservation={handleMoveReservation}
            onRemoveReservation={handleHostRemoveReservation}
            onSongEnded={handleStartNext}
            onCopySingerUrl={handleCopySingerUrl}
            onHostLogout={handleHostLogout}
            isLoading={isLoading}
            error={error}
          />
        ) : (
          <ScreenLoginView
            usernameInput={usernameInput}
            passwordInput={passwordInput}
            onUsernameInputChange={setUsernameInput}
            onPasswordInputChange={setPasswordInput}
            onLogin={handleHostLogin}
            loginError={loginError}
          />
        )
      ) : (
        <PhoneView
          singerName={singerName}
          singerToken={singerToken}
          singerSessionId={singerSessionId}
          singerAccessTokenFromUrl={singerAccessTokenFromUrl}
          singerDraft={singerDraft}
          onSingerDraftChange={setSingerDraft}
          onSaveSinger={handleSaveSinger}
          searchTerm={searchTerm}
          onSearchTermChange={setSearchTerm}
          onSearchSubmit={handleSearch}
          searchResults={searchResults}
          queue={queue}
          isSearching={isSearching}
          isReserving={isReserving}
          error={error}
          toastMessage={toastMessage}
          onReserveSong={handleReserveSong}
          onRemoveReservation={handleRemoveReservation}
        />
      )}
    </>
  )
}

export default App
