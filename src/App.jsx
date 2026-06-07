import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import './App.css'

const POLL_INTERVAL_MS = 3000
const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api'
const LAST_SINGER_ACCESS_TOKEN_KEY = 'videoke_last_singer_access_token'
const REUSE_SINGER_URL_ON_LOGIN_KEY = 'videoke_reuse_singer_url_on_login'
const SINGER_SESSION_ACCESS_TOKEN_KEY = 'videoke_singer_access_token'
let youtubeApiPromise
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

function YouTubePlayer({ videoId, title, onEnded, onPlaybackBlocked }) {
  const containerRef = useRef(null)
  const playerRef = useRef(null)
  const onEndedRef = useRef(onEnded)
  const onPlaybackBlockedRef = useRef(onPlaybackBlocked)

  useEffect(() => {
    onEndedRef.current = onEnded
  }, [onEnded])

  useEffect(() => {
    onPlaybackBlockedRef.current = onPlaybackBlocked
  }, [onPlaybackBlocked])

  useEffect(() => {
    let isUnmounted = false
    let hasHandledPlaybackError = false
    let hasStartedPlayback = false
    const retryTimeouts = []

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
            fs: 0,
          },
          events: {
            onReady: (event) => {
              // Some browsers occasionally ignore autoplay in iframe params.
              // Explicitly request playback and retry briefly if needed.
              const attemptAutoPlay = () => {
                try {
                  event.target.playVideo()
                } catch {
                  // Ignore player API readiness timing issues.
                }

                // Mobile/TV browsers may allow autoplay only after muted start.
                try {
                  const state = event.target.getPlayerState?.()
                  if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
                    const wasMuted = event.target.isMuted?.()
                    event.target.mute?.()
                    event.target.playVideo()
                    const unmuteTimeout = setTimeout(() => {
                      if (isUnmounted || !playerRef.current) return
                      if (!wasMuted) {
                        try {
                          event.target.unMute?.()
                        } catch {
                          // Ignore unmute failures.
                        }
                      }
                    }, 450)
                    retryTimeouts.push(unmuteTimeout)
                  }
                } catch {
                  // Ignore transient state/read issues from iframe API.
                }
              }

              attemptAutoPlay()

              ;[400, 1000, 1800, 3000].forEach((delayMs) => {
                const timeoutId = setTimeout(() => {
                  if (isUnmounted || !playerRef.current) return

                  try {
                    const state = playerRef.current.getPlayerState()
                    if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
                      attemptAutoPlay()
                    }
                  } catch {
                    // Ignore transient state/read issues from iframe API.
                  }
                }, delayMs)

                retryTimeouts.push(timeoutId)
              })
            },
            onStateChange: (event) => {
              if (event.data === YT.PlayerState.PLAYING) {
                hasStartedPlayback = true
              }

              if (event.data === YT.PlayerState.ENDED) {
                onEndedRef.current?.()
              }

              if (event.data === YT.PlayerState.CUED || event.data === YT.PlayerState.UNSTARTED) {
                try {
                  event.target.playVideo()
                } catch {
                  // Ignore autoplay restrictions; host can still tap play manually.
                }
              }

              if (event.data === YT.PlayerState.PAUSED && !hasStartedPlayback) {
                try {
                  event.target.playVideo()
                } catch {
                  // Ignore autoplay restrictions; fallback retries are already scheduled.
                }
              }
            },
            onError: (event) => {
              const errorCode = Number(event?.data)
              const shouldSkip = errorCode === 5 || errorCode === 100 || errorCode === 101 || errorCode === 150
              if (!shouldSkip || hasHandledPlaybackError) return

              hasHandledPlaybackError = true
              onPlaybackBlockedRef.current?.(errorCode)
            },
          },
        })
      })
      .catch(() => {})

    return () => {
      isUnmounted = true
      retryTimeouts.forEach((timeoutId) => clearTimeout(timeoutId))
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
  singerNameInputRef,
  singerSessionNeedsRefresh,
  onSingerDraftChange,
  onSaveSinger,
  onRefreshSingerSession,
  searchTerm,
  onSearchTermChange,
  onSearchSubmit,
  searchResults,
  queue,
  isSearching,
  reservingVideoId,
  error,
  toastMessage,
  onReserveSong,
  onRemoveReservation,
}) {
  const reservedSongVideoIds = useMemo(
    () =>
      new Set(
        queue
          .filter((reservation) => reservation.singerToken === singerToken)
          .map((reservation) => reservation.song?.videoId)
          .filter(Boolean),
      ),
    [queue, singerToken],
  )

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
          {singerSessionNeedsRefresh && singerAccessTokenFromUrl ? (
            <div className="session-refresh-panel">
              <p className="muted">Your singer session needs to be refreshed for this updated URL token.</p>
              <button type="button" className="secondary session-refresh-btn" onClick={onRefreshSingerSession}>
                Refresh My Session
              </button>
            </div>
          ) : null}
          <form className="row" onSubmit={onSaveSinger}>
            <input
              ref={singerNameInputRef}
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

          <section className="card singer-queue-section">
            <div className="queue-strip-header">
              <h2>Queue</h2>
              <span className="queue-count-badge">{queue.length} queued</span>
            </div>
            {queue.length === 0 ? (
              <p className="muted">No reservations yet.</p>
            ) : (
              <ul className="singer-queue-strip">
                {queue.map((reservation, index) => (
                  <li key={reservation.id} className="singer-queue-chip">
                    <div>
                      <p className="song-title">
                        {index + 1}. {reservation.song.title}
                      </p>
                      <p className="muted">by {reservation.singerName}</p>
                    </div>
                    {reservation.singerToken === singerToken ? (
                      <button
                        type="button"
                        className="danger singer-queue-cancel"
                        onClick={() => onRemoveReservation(reservation.id)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
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
                    {(() => {
                      const isReservingThis = reservingVideoId === item.videoId
                      const isAlreadyReserved = reservedSongVideoIds.has(item.videoId)
                      const isLikelyBlocked = item.embeddableStatus === 'likely_blocked'
                      const isDisabled = isReservingThis || isAlreadyReserved || isLikelyBlocked

                      return (
                        <>
                          <button type="button" disabled={isDisabled} onClick={() => onReserveSong(item)}>
                            {isReservingThis ? (
                              <span className="loading-button-content">
                                <span className="button-spinner" aria-hidden="true" />
                                Reserving...
                              </span>
                            ) : isAlreadyReserved ? (
                              'Reserved'
                            ) : isLikelyBlocked ? (
                              'Blocked'
                            ) : (
                              'Reserve'
                            )}
                          </button>
                          {isLikelyBlocked ? (
                            <p className="muted">Blocked by YouTube embed policy</p>
                          ) : null}
                        </>
                      )
                    })()}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

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
  hostUsername,
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
  onPlaybackBlocked,
  onCopySingerUrl,
  onHostLogout,
  isLoading,
  error,
}) {
  const nowPlayingRef = useRef(null)
  const [isNowPlayingFullscreen, setIsNowPlayingFullscreen] = useState(false)
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false)
  const [preferFullscreen, setPreferFullscreen] = useState(false)
  const isPanelFullscreen = isNowPlayingFullscreen || isFallbackFullscreen

  useEffect(() => {
    const syncFullscreenState = () => {
      const fullscreenElement =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement

      const isNativeFullscreenOnPanel = fullscreenElement === nowPlayingRef.current
      setIsNowPlayingFullscreen(isNativeFullscreenOnPanel)

      if (!isNativeFullscreenOnPanel && preferFullscreen && !isFallbackFullscreen) {
        // If browser drops native fullscreen unexpectedly (common on some mobile/TV flows),
        // keep the immersive layout through our CSS fallback mode.
        setIsFallbackFullscreen(true)
      }
    }

    document.addEventListener('fullscreenchange', syncFullscreenState)
    document.addEventListener('webkitfullscreenchange', syncFullscreenState)
    syncFullscreenState()

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState)
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState)
    }
  }, [isFallbackFullscreen, preferFullscreen])

  useEffect(() => {
    if (!preferFullscreen) return
    if (isPanelFullscreen) return

    // Some browsers exit native fullscreen when the iframe source changes.
    // Keep the immersive experience by re-entering fallback fullscreen.
    const timeoutId = setTimeout(() => {
      setIsFallbackFullscreen(true)
    }, 120)

    return () => clearTimeout(timeoutId)
  }, [preferFullscreen, isPanelFullscreen, currentSong?.id])

  useEffect(() => {
    if (!isFallbackFullscreen) {
      document.body.style.overflow = ''
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isFallbackFullscreen])

  const toggleNowPlayingFullscreen = async () => {
    const target = nowPlayingRef.current
    if (!target) return

    if (isFallbackFullscreen) {
      setIsFallbackFullscreen(false)
      setPreferFullscreen(false)

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
      }
      return
    }

    // Use stable app-level fullscreen first to avoid browser-native fullscreen drops
    // when YouTube iframe changes video state.
    setPreferFullscreen(true)
    setIsFallbackFullscreen(true)
  }

  const keepFullscreenBeforeTransition = () => {
    if (preferFullscreen && !isFallbackFullscreen) {
      setIsFallbackFullscreen(true)
    }
  }

  const handleStartNextFromView = () => {
    keepFullscreenBeforeTransition()
    onStartNext?.()
  }

  const handleSongEndedFromView = () => {
    keepFullscreenBeforeTransition()
    onSongEnded?.()
  }

  return (
    <main className={`layout screen ${isFallbackFullscreen ? 'mobile-fullscreen-root' : ''}`}>
      <header className="card host-header-card">
        <h1>JKaraoke - Host Control Panel</h1>
        <p>Open this screen on iPad/TV and control the queue here.</p>
      </header>

      <div className="screen-grid">
        <section
          ref={nowPlayingRef}
          className={`card player-card screen-left-panel ${isFallbackFullscreen ? 'player-card-mobile-fullscreen' : ''}`}
        >
          <div className="now-playing-header">
            <h2>Now Playing</h2>
            <div className="now-playing-tools">
              <button type="button" className="secondary fullscreen-btn" onClick={toggleNowPlayingFullscreen}>
                {isPanelFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              </button>
            </div>
          </div>
          <section className="reservation-strip-section">
            <div className="reservation-strip-header">
              <h3 className="queue-title">
                Reserved Songs
                <span className="queue-count-badge">
                  {queue.length} remaining{queue.length === 1 ? '' : 's'}
                </span>
              </h3>
              {isPanelFullscreen && singerShareUrl ? (
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
                      <p className="reservation-song" title={`${index + 1}. ${reservation.song.title}`}>
                        <span className="reservation-order">#{index + 1}</span> {reservation.song.title}
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
                onEnded={handleSongEndedFromView}
                onPlaybackBlocked={onPlaybackBlocked}
              />
            </>
          ) : (
            <section className="now-playing-empty" role="status" aria-live="polite">
              <p className="empty-badge">Waiting for playback</p>
              <h3>No song is currently playing</h3>
              <p className="empty-primary">Tap <strong>Next</strong> to start the next reserved song.</p>
              <button
                type="button"
                className="empty-play-btn"
                onClick={handleStartNextFromView}
                disabled={isLoading || queue.length === 0}
              >
                {isLoading ? 'Starting...' : 'Play Next Song'}
              </button>
              <p className="empty-secondary">
                {queue.length > 0
                  ? `${queue.length} reservation${queue.length > 1 ? 's are' : ' is'} ready in queue.`
                  : 'Queue is empty. Ask singers to reserve songs first.'}
              </p>
            </section>
          )}
        </section>

        <aside className="card screen-right-panel">
          <div className="host-user-row">
            <p className="muted">Hello, {hostUsername || 'Host'}!</p>
            <button type="button" className="secondary" onClick={onHostLogout} disabled={isLoading}>
              Logout
            </button>
          </div>
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
            <button type="button" onClick={handleStartNextFromView} disabled={isLoading}>
              Next
            </button>
            <button type="button" className="secondary" onClick={onClearCurrent} disabled={isLoading}>
              Clear
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
  authMode,
  usernameInput,
  emailInput,
  passwordInput,
  confirmPasswordInput,
  reuseSingerUrlOnLogin,
  isLoggingIn,
  isCheckingUsername,
  isCheckingEmail,
  usernameValidationMessage,
  emailValidationMessage,
  isUsernameAvailable,
  isEmailAvailable,
  onUsernameInputChange,
  onUsernameInputBlur,
  onEmailInputChange,
  onEmailInputBlur,
  onPasswordInputChange,
  onConfirmPasswordInputChange,
  onAuthModeChange,
  onReuseSingerUrlOnLoginChange,
  onSubmit,
  authMessage,
  loginError,
}) {
  const isSignupMode = authMode === 'signup'
  const isForgotMode = authMode === 'forgot'
  const isResetMode = authMode === 'reset'
  const isLoginMode = authMode === 'login'

  return (
    <main className="layout screen login-screen">
      <section className="card login-shell">
        <header className="login-shell-header">
          <p className="login-branding" aria-label="JKaraoke brand">
            <span className="brand-dot" aria-hidden="true" />
            JKaraoke
          </p>
          <h1>
            {isSignupMode
              ? 'Create Host Account'
              : isForgotMode
                ? 'Forgot Password'
                : isResetMode
                  ? 'Reset Password'
                  : 'Host Login'}
          </h1>
          <p>
            {isSignupMode
              ? 'Create your host account to manage queue and playback controls.'
              : isForgotMode
                ? 'Request a password reset link via email.'
                : isResetMode
                  ? 'Set your new password to continue.'
              : 'Sign in to manage queue and playback controls.'}
          </p>
        </header>
        <section className="login-app-info">
          <p className="login-app-summary">
            JKaraoke lets singers join from their phones, reserve YouTube songs, and queue them live on your host
            screen.
          </p>
          <ul className="login-feature-list">
            <li>Share one singer URL/QR with your guests.</li>
            <li>Control queue order and start the next song instantly.</li>
            <li>Use fullscreen mode for TV-style playback.</li>
          </ul>
        </section>
        <form className="row login-form" onSubmit={onSubmit}>
          {!isForgotMode && !isResetMode ? (
            <input
              value={usernameInput}
              onChange={(event) => onUsernameInputChange(event.target.value)}
              onBlur={onUsernameInputBlur}
              placeholder="Username"
              autoComplete="username"
              disabled={isLoggingIn}
              required
            />
          ) : null}
          {isSignupMode ? (
            <p className={isUsernameAvailable === false ? 'error' : 'muted'}>
              {isCheckingUsername ? 'Checking username...' : usernameValidationMessage || ' '}
            </p>
          ) : null}
          {(isSignupMode || isForgotMode) && (
            <>
              <input
                type="email"
                value={emailInput}
                onChange={(event) => onEmailInputChange(event.target.value)}
                onBlur={onEmailInputBlur}
                placeholder="Email address"
                autoComplete="email"
                disabled={isLoggingIn}
                required
              />
              {isSignupMode ? (
                <p className={isEmailAvailable === false ? 'error' : 'muted'}>
                  {isCheckingEmail ? 'Checking email...' : emailValidationMessage || ' '}
                </p>
              ) : null}
            </>
          )}
          {!isForgotMode ? (
            <input
              type="password"
              value={passwordInput}
              onChange={(event) => onPasswordInputChange(event.target.value)}
              placeholder={isResetMode ? 'New password' : 'Password'}
              autoComplete={isSignupMode || isResetMode ? 'new-password' : 'current-password'}
              disabled={isLoggingIn}
              required
            />
          ) : null}
          {isSignupMode ? (
            <input
              type="password"
              value={confirmPasswordInput}
              onChange={(event) => onConfirmPasswordInputChange(event.target.value)}
              placeholder="Confirm password"
              autoComplete="new-password"
              disabled={isLoggingIn}
              required
            />
          ) : null}
          {isLoginMode ? (
            <label className="login-option">
              <input
                type="checkbox"
                checked={reuseSingerUrlOnLogin}
                onChange={(event) => onReuseSingerUrlOnLoginChange(event.target.checked)}
                disabled={isLoggingIn}
              />
              <span className="login-option-label">
                Reuse previous singer URL token
                <small>Keeps the singer link unchanged after login.</small>
              </span>
            </label>
          ) : null}
          <button type="submit" className={isLoggingIn ? 'loading-button' : ''} disabled={isLoggingIn}>
            {isLoggingIn ? (
              <span className="loading-button-content">
                <span className="button-spinner" aria-hidden="true" />
                {isSignupMode
                  ? 'Creating account... Please wait'
                  : isForgotMode
                    ? 'Sending reset link...'
                    : isResetMode
                      ? 'Resetting password...'
                      : 'Logging in... Please wait'}
              </span>
            ) : (
              isSignupMode
                ? 'Create Account'
                : isForgotMode
                  ? 'Send Reset Link'
                  : isResetMode
                    ? 'Reset Password'
                    : 'Login'
            )}
          </button>
          <p className="auth-switch-text">
            {isLoginMode ? (
              <>
                No account yet?{' '}
                <button
                  type="button"
                  className="auth-switch-link"
                  onClick={() => onAuthModeChange('signup')}
                  disabled={isLoggingIn}
                >
                  Sign up now
                </button>{' '}
                |{' '}
                <button
                  type="button"
                  className="auth-switch-link"
                  onClick={() => onAuthModeChange('forgot')}
                  disabled={isLoggingIn}
                >
                  Forgot password?
                </button>
              </>
            ) : (
              <>
                Back to{' '}
                <button
                  type="button"
                  className="auth-switch-link"
                  onClick={() => onAuthModeChange('login')}
                  disabled={isLoggingIn}
                >
                  Login
                </button>
              </>
            )}
          </p>
        </form>
        {authMessage ? <p className="muted">{authMessage}</p> : null}
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

  const initialSingerAccessTokenFromUrl = new URLSearchParams(window.location.search).get('token') || ''
  const initialHostVerifyToken = new URLSearchParams(window.location.search).get('verify') || ''
  const initialHostResetToken = new URLSearchParams(window.location.search).get('reset') || ''
  const initialStoredSingerAccessToken = sessionStorage.getItem(SINGER_SESSION_ACCESS_TOKEN_KEY) || ''
  const shouldResetSingerSessionOnLoad = Boolean(
    initialSingerAccessTokenFromUrl &&
      initialStoredSingerAccessToken &&
      initialSingerAccessTokenFromUrl !== initialStoredSingerAccessToken,
  )

  if (shouldResetSingerSessionOnLoad) {
    sessionStorage.removeItem('videoke_singer_name')
    sessionStorage.removeItem('videoke_singer_token')
    sessionStorage.removeItem('videoke_singer_session_id')
    sessionStorage.removeItem(SINGER_SESSION_ACCESS_TOKEN_KEY)
  }

  const [singerName, setSingerName] = useState(() => sessionStorage.getItem('videoke_singer_name') || '')
  const [singerToken, setSingerToken] = useState(() => sessionStorage.getItem('videoke_singer_token') || '')
  const [singerSessionId, setSingerSessionId] = useState(
    () => sessionStorage.getItem('videoke_singer_session_id') || '',
  )
  const [singerAccessTokenFromUrl] = useState(() => initialSingerAccessTokenFromUrl)
  const [singerDraft, setSingerDraft] = useState(() => sessionStorage.getItem('videoke_singer_name') || '')
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [queue, setQueue] = useState([])
  const [currentSong, setCurrentSong] = useState(null)
  const [isSearching, setIsSearching] = useState(false)
  const [reservingVideoId, setReservingVideoId] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(() =>
    shouldResetSingerSessionOnLoad
      ? 'Singer URL was updated. Please confirm your singer name again to refresh your session.'
      : '',
  )
  const [toastMessage, setToastMessage] = useState('')
  const [hostToken, setHostToken] = useState(() => sessionStorage.getItem('videoke_host_token') || '')
  const [isHostAuthenticated, setIsHostAuthenticated] = useState(false)
  const [isCheckingHostAuth, setIsCheckingHostAuth] = useState(false)
  const [hostAuthMode, setHostAuthMode] = useState(() => (initialHostResetToken ? 'reset' : 'login'))
  const [hostVerifyToken, setHostVerifyToken] = useState(initialHostVerifyToken)
  const [hostResetToken, setHostResetToken] = useState(initialHostResetToken)
  const [usernameInput, setUsernameInput] = useState('')
  const [hostUsername, setHostUsername] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('')
  const [isCheckingUsername, setIsCheckingUsername] = useState(false)
  const [isCheckingEmail, setIsCheckingEmail] = useState(false)
  const [usernameValidationMessage, setUsernameValidationMessage] = useState('')
  const [emailValidationMessage, setEmailValidationMessage] = useState('')
  const [isUsernameAvailable, setIsUsernameAvailable] = useState(null)
  const [isEmailAvailable, setIsEmailAvailable] = useState(null)
  const [loginError, setLoginError] = useState('')
  const [hostAuthMessage, setHostAuthMessage] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [singerAccessToken, setSingerAccessToken] = useState('')
  const [singerLinkMessage, setSingerLinkMessage] = useState('')
  const [reuseSingerUrlOnLogin, setReuseSingerUrlOnLogin] = useState(() => {
    const saved = localStorage.getItem(REUSE_SINGER_URL_ON_LOGIN_KEY)
    return saved === null ? true : saved === 'true'
  })
  const [singerSessionNeedsRefresh, setSingerSessionNeedsRefresh] = useState(shouldResetSingerSessionOnLoad)
  const singerNameInputRef = useRef(null)

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
    localStorage.setItem(REUSE_SINGER_URL_ON_LOGIN_KEY, String(reuseSingerUrlOnLogin))
  }, [reuseSingerUrlOnLogin])

  useEffect(() => {
    if (!singerAccessToken) return
    localStorage.setItem(LAST_SINGER_ACCESS_TOKEN_KEY, singerAccessToken)
  }, [singerAccessToken])

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
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Unauthorized')
        }
        const data = await response.json()
        setIsHostAuthenticated(true)
        setHostUsername(data.username || '')
        setLoginError('')
        return fetchSingerAccessToken(hostToken)
      })
      .catch(() => {
        sessionStorage.removeItem('videoke_host_token')
        setHostToken('')
        setIsHostAuthenticated(false)
        setHostUsername('')
        setLoginError('Please login again.')
        setSingerAccessToken('')
      })
      .finally(() => {
        setIsCheckingHostAuth(false)
      })
  }, [hostToken, isScreenView])

  useEffect(() => {
    if (!isScreenView || !hostVerifyToken) return

    const params = new URLSearchParams(window.location.search)
    params.delete('verify')
    const nextQuery = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`)

    fetch(`/api/host/verify-email?token=${encodeURIComponent(hostVerifyToken)}`)
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || 'Email verification failed.')
        }
        setHostAuthMessage(data.message || 'Email verified. You can now login.')
        setHostAuthMode('login')
      })
      .catch((err) => {
        setLoginError(err instanceof Error ? err.message : 'Email verification failed.')
      })
      .finally(() => {
        setHostVerifyToken('')
      })
  }, [isScreenView, hostVerifyToken])

  const clearSingerSession = () => {
    sessionStorage.removeItem('videoke_singer_name')
    sessionStorage.removeItem('videoke_singer_token')
    sessionStorage.removeItem('videoke_singer_session_id')
    sessionStorage.removeItem(SINGER_SESSION_ACCESS_TOKEN_KEY)
    setSingerName('')
    setSingerToken('')
    setSingerSessionId('')
  }

  const handleSingerTokenChanged = () => {
    clearSingerSession()
    setSearchResults([])
    setSingerSessionNeedsRefresh(true)
    setError('Singer URL was updated. Please confirm your singer name again to refresh your session.')
  }

  useEffect(() => {
    if (isScreenView || !singerSessionNeedsRefresh) return
    singerNameInputRef.current?.focus()
    singerNameInputRef.current?.select()
  }, [isScreenView, singerSessionNeedsRefresh, singerAccessTokenFromUrl])

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
      sessionStorage.setItem(SINGER_SESSION_ACCESS_TOKEN_KEY, singerAccessTokenFromUrl)
      setSingerName(data.singerName)
      setSingerToken(data.singerToken)
      setSingerSessionId(data.singerSessionId)
      setSingerSessionNeedsRefresh(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start singer session.')
    }
  }

  const handleRefreshSingerSession = () => {
    clearSingerSession()
    setSingerSessionNeedsRefresh(true)
    setError('Please confirm your singer name again to refresh your session.')
    singerNameInputRef.current?.focus()
    singerNameInputRef.current?.select()
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

    setReservingVideoId(song.videoId)
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
        if (
          response.status === 401 ||
          (response.status === 403 && String(data.error || '').toLowerCase().includes('url token'))
        ) {
          handleSingerTokenChanged()
        }
        throw new Error(data.error || 'Reservation failed.')
      }

      setQueue(data.state?.queue ?? [])
      setToastMessage('Successfully added to reservation list.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reservation failed.')
    } finally {
      setReservingVideoId('')
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
        if (
          response.status === 401 ||
          (response.status === 403 && String(data.error || '').toLowerCase().includes('url token'))
        ) {
          handleSingerTokenChanged()
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
    setHostUsername('')
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

  const handlePlaybackBlocked = (errorCode) => {
    setToastMessage(`This video can't play in embedded mode (code ${errorCode}). Skipping to next song...`)
    void handleStartNext()
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
    setHostAuthMessage('')
    setIsLoggingIn(true)

    try {
      const previousSingerAccessToken = localStorage.getItem(LAST_SINGER_ACCESS_TOKEN_KEY) || ''
      const response = await fetch('/api/host/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameInput,
          password: passwordInput,
          reuseSingerAccessToken: reuseSingerUrlOnLogin,
          singerAccessToken: reuseSingerUrlOnLogin ? previousSingerAccessToken : '',
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.token) {
        throw new Error(data.error || 'Invalid username or password.')
      }

      sessionStorage.setItem('videoke_host_token', data.token)
      setHostToken(data.token)
      setIsHostAuthenticated(true)
      setHostUsername(data.username || usernameInput.trim())
      setUsernameInput('')
      setPasswordInput('')
      setSingerLinkMessage('')
      if (data.singerAccessToken) {
        setSingerAccessToken(data.singerAccessToken)
      } else {
        await fetchSingerAccessToken(data.token)
      }
      return
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Invalid username or password.')
    } finally {
      setIsLoggingIn(false)
    }
  }

  const handleHostSignup = async (event) => {
    event.preventDefault()
    setLoginError('')
    setHostAuthMessage('')
    setIsLoggingIn(true)

    try {
      if (passwordInput !== confirmPasswordInput) {
        throw new Error('Password and confirm password do not match.')
      }

      const usernameCheck = await checkSignupUsernameAvailability(usernameInput)
      if (!usernameCheck.available) {
        throw new Error('Username already exists. Please choose another one.')
      }
      const emailCheck = await checkSignupEmailAvailability(emailInput)
      if (!emailCheck.available) {
        throw new Error('Email is already taken. Please login or use another email.')
      }

      const response = await fetch('/api/host/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameInput,
          email: emailInput,
          password: passwordInput,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create account.')
      }

      setHostAuthMode('login')
      setPasswordInput('')
      setConfirmPasswordInput('')
      setEmailInput('')
      setIsUsernameAvailable(null)
      setIsEmailAvailable(null)
      setUsernameValidationMessage('')
      setEmailValidationMessage('')
      setHostAuthMessage(data.message || 'Account created. Please verify your email, then login.')
      return
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Failed to create account.')
    } finally {
      setIsLoggingIn(false)
    }
  }

  const handleForgotPassword = async (event) => {
    event.preventDefault()
    setLoginError('')
    setHostAuthMessage('')
    setIsLoggingIn(true)

    try {
      const response = await fetch('/api/host/password/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send reset link.')
      }
      setHostAuthMessage(data.message || 'If that email exists, a reset link has been sent.')
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Failed to send reset link.')
    } finally {
      setIsLoggingIn(false)
    }
  }

  const handleResetPassword = async (event) => {
    event.preventDefault()
    setLoginError('')
    setHostAuthMessage('')
    setIsLoggingIn(true)

    try {
      const response = await fetch('/api/host/password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: hostResetToken,
          newPassword: passwordInput,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to reset password.')
      }

      const params = new URLSearchParams(window.location.search)
      params.delete('reset')
      const nextQuery = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`)
      setHostResetToken('')
      setPasswordInput('')
      setHostAuthMode('login')
      setHostAuthMessage(data.message || 'Password reset successful. You can now login.')
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Failed to reset password.')
    } finally {
      setIsLoggingIn(false)
    }
  }

  const checkSignupUsernameAvailability = async (rawUsername) => {
    const username = rawUsername.trim()
    if (hostAuthMode !== 'signup') {
      return { available: null }
    }
    if (username.length < 3) {
      setIsUsernameAvailable(false)
      setUsernameValidationMessage('Username must be at least 3 characters.')
      return { available: false }
    }

    setIsCheckingUsername(true)
    try {
      const response = await fetch(`/api/host/check-username?username=${encodeURIComponent(username)}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || data.message || 'Failed to validate username.')
      }

      setIsUsernameAvailable(Boolean(data.available))
      setUsernameValidationMessage(
        data.message || (data.available ? 'Username is available.' : 'Username already exists.'),
      )
      return { available: Boolean(data.available) }
    } catch (err) {
      setIsUsernameAvailable(null)
      setUsernameValidationMessage('')
      throw err
    } finally {
      setIsCheckingUsername(false)
    }
  }

  const checkSignupEmailAvailability = async (rawEmail) => {
    const email = rawEmail.trim()
    if (hostAuthMode !== 'signup') {
      return { available: null }
    }
    if (!EMAIL_PATTERN.test(email)) {
      setIsEmailAvailable(false)
      setEmailValidationMessage('Please enter a valid email address.')
      return { available: false }
    }

    setIsCheckingEmail(true)
    try {
      const response = await fetch(`/api/host/check-email?email=${encodeURIComponent(email)}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || data.message || 'Failed to validate email.')
      }

      setIsEmailAvailable(Boolean(data.available))
      setEmailValidationMessage(data.message || (data.available ? 'Email is available.' : 'Email is already taken.'))
      return { available: Boolean(data.available) }
    } catch (err) {
      setIsEmailAvailable(null)
      setEmailValidationMessage('')
      throw err
    } finally {
      setIsCheckingEmail(false)
    }
  }

  const handleUsernameInputChange = (value) => {
    setUsernameInput(value)
    if (hostAuthMode === 'signup') {
      setIsUsernameAvailable(null)
      setUsernameValidationMessage('')
    }
  }

  const handleEmailInputChange = (value) => {
    setEmailInput(value)
    if (hostAuthMode === 'signup') {
      setIsEmailAvailable(null)
      setEmailValidationMessage('')
    }
  }

  const handleUsernameInputBlur = async () => {
    if (hostAuthMode !== 'signup') return
    try {
      await checkSignupUsernameAvailability(usernameInput)
    } catch {
      // Keep blur validation non-blocking; submit handler still validates.
    }
  }

  const handleEmailInputBlur = async () => {
    if (hostAuthMode !== 'signup') return
    try {
      await checkSignupEmailAvailability(emailInput)
    } catch {
      // Keep blur validation non-blocking; submit handler still validates.
    }
  }

  const handleHostAuthModeChange = (nextMode) => {
    setHostAuthMode(nextMode)
    setLoginError('')
    setHostAuthMessage('')
    setIsCheckingUsername(false)
    setIsCheckingEmail(false)
    setIsUsernameAvailable(null)
    setIsEmailAvailable(null)
    setUsernameValidationMessage('')
    setEmailValidationMessage('')
    if (nextMode !== 'reset') {
      setPasswordInput('')
    }
    setConfirmPasswordInput('')
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
    setHostUsername('')
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
            hostUsername={hostUsername}
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
            onPlaybackBlocked={handlePlaybackBlocked}
            onCopySingerUrl={handleCopySingerUrl}
            onHostLogout={handleHostLogout}
            isLoading={isLoading}
            error={error}
          />
        ) : (
          <ScreenLoginView
            authMode={hostAuthMode}
            usernameInput={usernameInput}
            emailInput={emailInput}
            passwordInput={passwordInput}
            confirmPasswordInput={confirmPasswordInput}
            reuseSingerUrlOnLogin={reuseSingerUrlOnLogin}
            isLoggingIn={isLoggingIn}
            isCheckingUsername={isCheckingUsername}
            isCheckingEmail={isCheckingEmail}
            usernameValidationMessage={usernameValidationMessage}
            emailValidationMessage={emailValidationMessage}
            isUsernameAvailable={isUsernameAvailable}
            isEmailAvailable={isEmailAvailable}
            onUsernameInputChange={handleUsernameInputChange}
            onUsernameInputBlur={handleUsernameInputBlur}
            onEmailInputChange={handleEmailInputChange}
            onEmailInputBlur={handleEmailInputBlur}
            onPasswordInputChange={setPasswordInput}
            onConfirmPasswordInputChange={setConfirmPasswordInput}
            onAuthModeChange={handleHostAuthModeChange}
            onReuseSingerUrlOnLoginChange={setReuseSingerUrlOnLogin}
            onSubmit={
              hostAuthMode === 'signup'
                ? handleHostSignup
                : hostAuthMode === 'forgot'
                  ? handleForgotPassword
                  : hostAuthMode === 'reset'
                    ? handleResetPassword
                    : handleHostLogin
            }
            authMessage={hostAuthMessage}
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
          singerNameInputRef={singerNameInputRef}
          singerSessionNeedsRefresh={singerSessionNeedsRefresh}
          onSingerDraftChange={setSingerDraft}
          onSaveSinger={handleSaveSinger}
          onRefreshSingerSession={handleRefreshSingerSession}
          searchTerm={searchTerm}
          onSearchTermChange={setSearchTerm}
          onSearchSubmit={handleSearch}
          searchResults={searchResults}
          queue={queue}
          isSearching={isSearching}
          reservingVideoId={reservingVideoId}
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
