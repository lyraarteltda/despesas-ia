/**
 * Despesas IA — Main Application Logic
 *
 * This is the scaffold for the tool's core functionality.
 * Replace the contents below with the actual feature implementation.
 *
 * Available globals:
 *   - window.ApiKeyManager.getActiveKey() — returns { service, key, config } or null
 *   - window.ApiKeyManager.getKey('openai') — get key for a specific service
 *   - MembershipGate.getSession() — returns { email, name, phone, timestamp }
 *   - window.APP_CONFIG.n8nWebhookBase — the only backend endpoint (n8n)
 *
 * There is NO Supabase client in the browser. All server-side work (membership,
 * feedback, deletion) goes through the n8n webhooks. Tools that persist data
 * should do it via a dedicated n8n webhook, never directly from the browser.
 */

const App = (function() {
  function init() {
    console.log('Despesas IA initialized');

    // Get the current member session
    const session = MembershipGate.getSession();
    if (session) {
      const nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }

    // ========================================
    // YOUR APPLICATION LOGIC GOES HERE
    // ========================================

    // Example: Making an AI call with the user's key
    // const activeKey = ApiKeyManager.getActiveKey();
    // if (activeKey) {
    //   console.log('Using ' + activeKey.config.name + ' API');
    //   // Make API call with activeKey.key
    // }

    // Example: persisting data — POST to a dedicated n8n webhook (server-side),
    // never to Supabase from the browser.
    // const base = window.APP_CONFIG.n8nWebhookBase;
    // await fetch(base + '/your-webhook', { method:'POST',
    //   headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ... }) });

    // ========================================
  }

  return { init: init };
})();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = MembershipGate.getSession();
    if (session) {
      _appInitialized = true;
      App.init();
    }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(tryAppInit, 150);
  });
})();
