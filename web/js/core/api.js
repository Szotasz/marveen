// === api.js: Dashboard auth bootstrap ===
// Intercepts window.fetch to inject the Bearer token for /api/* calls.
// Also handles the PWA standalone token paste overlay on 401.

// === Dashboard auth bootstrap ===
// The server prints an URL like http://127.0.0.1:3420/?token=XXX on startup.
// On first visit we pluck the token out of the URL, store it in localStorage,
// strip it from the visible URL, and then inject it into every /api/* fetch
// as a Bearer header so the server lets us through.

// The main (channels) agent's real id. The backend /api/marveen route returns
// the configured MAIN_AGENT_ID (NOT the literal "marveen") in window._marveen;
// use this everywhere an agent id is sent to /api/agents/... or compared to a
// fleet name, so the dashboard works on non-"marveen" installs. Falls back to
// "marveen" only before /api/marveen has resolved (or on a legacy backend).
export function mainAgentId() {
  return window._marveen?.agentId || 'marveen'
}

(() => {
  const TOKEN_KEY = 'marveen-dashboard-token'
  const urlParams = new URLSearchParams(window.location.search)
  const urlToken = urlParams.get('token')
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken)
    urlParams.delete('token')
    const clean = window.location.pathname + (urlParams.toString() ? '?' + urlParams : '') + window.location.hash
    window.history.replaceState({}, '', clean)
  }

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input))
    // Only attach the token to same-origin API calls. Relative paths always
    // resolve to same-origin; absolute URLs must match the current origin.
    const isSameOriginApi =
      url.startsWith('/api/') ||
      (url.startsWith(window.location.origin + '/api/'))
    if (isSameOriginApi) {
      const token = localStorage.getItem(TOKEN_KEY)
      if (token) {
        init = init || {}
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
        headers.set('Authorization', 'Bearer ' + token)
        init.headers = headers
      }
    }
    const res = await originalFetch(input, init)
    if (res.status === 401 && isSameOriginApi) {
      // Token missing, wrong, or revoked. Wipe and prompt once per page load.
      localStorage.removeItem(TOKEN_KEY)
      if (!window.__marveenAuthPrompted) {
        window.__marveenAuthPrompted = true
        // An installed (home-screen) PWA has its own localStorage, separate from
        // Safari's, and the manifest start_url has no ?token=, so the very first
        // standalone launch is token-less and 401s. There is no address bar to
        // paste a ?token= URL into either. Offer an in-app paste field that
        // writes the token to the app's own storage, then reload.
        const isStandalone = window.navigator.standalone === true ||
          (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        if (isStandalone) {
          showStandaloneTokenPrompt(TOKEN_KEY)
        } else {
          alert(
            'Dashboard authentication failed. Check the server log for the access URL ' +
            '(look for "Dashboard access URL" with ?token=...), then reopen it in your browser.'
          )
        }
      }
    }
    return res
  }

  // Full-screen, one-time token paste for installed PWAs (see the 401 handler).
  // The user pastes the access token (the value after ?token= in the server's
  // startup URL, or from the dashboard Settings / mobile-login QR); it is saved
  // to this app instance's localStorage and the page reloads authenticated.
  function showStandaloneTokenPrompt(tokenKey) {
    if (document.getElementById('mv-token-overlay')) return
    // Lang files are not yet loaded here; use a local inline lookup so EN mode works.
    const _lang = localStorage.getItem('marveen.lang') || 'hu'
    const _pwa = {
      hu: {
        title: 'Hozzáférés szükséges',
        desc: 'A home-screen app saját tárhelye még üres. Illeszd be a dashboard access tokent (a szerver indítási URL-jében a ?token= utáni rész, vagy a Beállítások / mobil-login QR), és elmentődik ehhez az apphoz.',
        btn: 'Mentés és újratöltés',
        empty_token: 'Üres token.'
      },
      en: {
        title: 'Access Required',
        desc: "The home-screen app's own storage is empty. Paste the dashboard access token (the part after ?token= in the server startup URL, or from Settings / mobile-login QR), and it will be saved for this app.",
        btn: 'Save & Reload',
        empty_token: 'Empty token.'
      }
    }
    const _p = _pwa[_lang] || _pwa.hu
    const overlay = document.createElement('div')
    overlay.id = 'mv-token-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1a1917;color:#faf9f5;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'font-family:system-ui,-apple-system,sans-serif'
    overlay.innerHTML =
      '<div style="max-width:420px;width:100%;display:flex;flex-direction:column;gap:14px">' +
        '<h2 style="margin:0;font-size:18px;text-align:center">' + _p.title + '</h2>' +
        '<p style="margin:0;font-size:14px;opacity:0.8;line-height:1.5;text-align:center">' +
          _p.desc + '</p>' +
        '<textarea id="mv-token-input" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
          'style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #555;' +
          'background:#0f0e0d;color:#faf9f5;font-size:14px;font-family:monospace" placeholder="token..."></textarea>' +
        '<button id="mv-token-save" style="padding:12px;border:0;border-radius:8px;background:#10b981;' +
          'color:#fff;font-size:15px;font-weight:600">' + _p.btn + '</button>' +
        '<div id="mv-token-err" style="color:#f87171;font-size:13px;min-height:16px;text-align:center"></div>' +
      '</div>'
    document.body.appendChild(overlay)
    const input = overlay.querySelector('#mv-token-input')
    const errEl = overlay.querySelector('#mv-token-err')
    const submit = () => {
      const raw = (input.value || '').trim()
      if (!raw) { errEl.textContent = _p.empty_token; return }
      // Accept either a bare token or the whole startup URL (the user often
      // pastes the full https://host/?token=... link). Pull just the token out.
      let token = raw
      if (raw.includes('token=')) {
        let extracted = null
        try { extracted = new URL(raw).searchParams.get('token') } catch { /* not a full URL */ }
        if (!extracted) {
          // covers ?token=, &token=, and the hash form (/#...?token=...)
          const m = raw.match(/[?&#]token=([^&#\s]+)/)
          if (m) extracted = m[1]
        }
        if (extracted) { try { token = decodeURIComponent(extracted) } catch { token = extracted } }
      }
      token = token.trim()
      if (!token) { errEl.textContent = _p.empty_token; return }
      localStorage.setItem(tokenKey, token)
      window.location.reload()
    }
    overlay.querySelector('#mv-token-save').addEventListener('click', submit)
    setTimeout(() => input.focus(), 50)
  }
})()
