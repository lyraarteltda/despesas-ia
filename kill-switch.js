/**
 * Kill Switch — reads the tools_enabled flag from the n8n verify-membership
 * webhook (which the backend returns on every call). If disabled, shows a
 * branded maintenance message and blocks the app. Load BEFORE membership-gate.js.
 *
 * The flag lives server-side; only n8n ever reads it — the browser sees only
 * the webhook response.
 */
const KillSwitch = (function() {
  const CHECK_INTERVAL = 5 * 60 * 1000; // re-check every 5 minutes
  let _isEnabled = true;
  let _checkTimer = null;

  async function checkStatus() {
    try {
      const base = (window.APP_CONFIG && window.APP_CONFIG.n8nWebhookBase) || '';
      const resp = await fetch(base + '/verify-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await resp.json();

      _isEnabled = data.tools_enabled !== false;

      if (!_isEnabled) {
        showMaintenancePage();
      }

      return _isEnabled;
    } catch {
      return true;
    }
  }

  function showMaintenancePage() {
    document.querySelectorAll('.screen').forEach(function(s) {
      s.classList.remove('active');
      s.style.display = 'none';
    });

    let overlay = document.getElementById('killswitch-overlay');
    if (overlay) {
      overlay.hidden = false;
      return;
    }

    // Bobina Térmica: o caixa fechado para manutenção.
    overlay = document.createElement('div');
    overlay.id = 'killswitch-overlay';
    overlay.className = 'killswitch';
    overlay.setAttribute('role', 'alert');

    const card = document.createElement('div');
    card.className = 'killswitch-card';

    const tape = document.createElement('p');
    tape.className = 'stamp-label';
    tape.textContent = 'Caixa fechado';

    const title = document.createElement('h1');
    title.className = 'killswitch-title';
    title.textContent = 'Em manutenção';

    const text = document.createElement('p');
    text.textContent = 'Estamos ajustando esta ferramenta. Ela volta em breve — seus lotes de despesas continuam salvos no seu navegador.';

    const brand = document.createElement('p');
    brand.className = 'killswitch-brand';
    brand.textContent = 'Maestros da IA';

    card.appendChild(tape);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(brand);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function startPeriodicCheck() {
    if (_checkTimer) clearInterval(_checkTimer);
    _checkTimer = setInterval(checkStatus, CHECK_INTERVAL);
  }

  async function init() {
    const enabled = await checkStatus();
    if (enabled) {
      startPeriodicCheck();
    }
    return enabled;
  }

  return {
    init: init,
    checkStatus: checkStatus,
    isEnabled: function() { return _isEnabled; }
  };
})();

window.KillSwitch = KillSwitch;
