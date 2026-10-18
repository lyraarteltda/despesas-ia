/**
 * Rate Limiter — client-side UX guard (localStorage). Caps: 60 req/min,
 * 500 req/hour per endpoint. This is a courtesy throttle only; the real,
 * tamper-proof enforcement lives server-side in the n8n webhooks. No Supabase
 * in the browser. Same public API as before so callers are unchanged.
 */
const RateLimiter = (function() {
  const LIMITS = {
    minute: { max: 60, windowMs: 60 * 1000 },
    hour:   { max: 500, windowMs: 60 * 60 * 1000 }
  };
  const STORE_KEY = 'maestria_rate_counts';

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
    catch { return {}; }
  }

  function save(obj) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); } catch {}
  }

  function windowStart(windowMs) {
    const now = Date.now();
    return now - (now % windowMs);
  }

  // Drop counter buckets whose window has fully elapsed, keeping storage small.
  function prune(store) {
    const now = Date.now();
    const maxWindow = Math.max.apply(null, Object.values(LIMITS).map(function(c) { return c.windowMs; }));
    const kept = {};
    Object.keys(store).forEach(function(k) {
      const ws = parseInt(k.split('|')[2], 10);
      if (!isNaN(ws) && now - ws < maxWindow) kept[k] = store[k];
    });
    return kept;
  }

  function checkLimit(endpoint) {
    const store = load();
    for (const [period, config] of Object.entries(LIMITS)) {
      const ws = windowStart(config.windowMs);
      const key = endpoint + '|' + period + '|' + ws;
      if ((store[key] || 0) >= config.max) {
        return {
          allowed: false,
          message: 'Limite de requisições atingido (' + config.max + '/' +
            (period === 'minute' ? 'minuto' : 'hora') + '). Aguarde um momento e tente novamente.',
          retryAfterMs: config.windowMs
        };
      }
    }
    return { allowed: true };
  }

  function recordRequest(endpoint) {
    let store = prune(load());
    for (const [period, config] of Object.entries(LIMITS)) {
      const ws = windowStart(config.windowMs);
      const key = endpoint + '|' + period + '|' + ws;
      store[key] = (store[key] || 0) + 1;
    }
    save(store);
  }

  async function executeWithLimit(endpoint, fn) {
    const check = checkLimit(endpoint);
    if (!check.allowed) {
      showRateLimitMessage(check.message);
      return null;
    }
    recordRequest(endpoint);
    return fn();
  }

  function showRateLimitMessage(message) {
    let el = document.getElementById('rate-limit-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rate-limit-toast';
      el.className = 'toast';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    setTimeout(function() { el.classList.remove('show'); }, 5000);
  }

  return {
    checkLimit: checkLimit,
    recordRequest: recordRequest,
    executeWithLimit: executeWithLimit,
    LIMITS: LIMITS
  };
})();

window.RateLimiter = RateLimiter;
