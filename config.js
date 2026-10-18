/**
 * App config — the n8n webhook base URL is the ONLY backend this tool talks to.
 *
 * This URL is public (not a secret). All membership verification, feedback and
 * data-deletion run server-side inside n8n, which holds every backend
 * credential. No database URL, key, or table name ever reaches the browser —
 * the tool ships zero backend infrastructure information.
 */
window.APP_CONFIG = {
  n8nWebhookBase: 'https://n8n.srv1268751.hstgr.cloud/webhook',

  // Optional anti-oracle CAPTCHA on the membership gate (COR-021). Leave empty to
  // disable — server-side rate limiting in n8n is the floor either way. When set
  // to a Cloudflare Turnstile site key, add the Turnstile <div class="cf-turnstile">
  // widget + script to the gate form (see backend-membership-verification.md);
  // membership-gate.js auto-attaches the token and n8n verifies it before the
  // comunidade_purchases lookup. This key is public (a site key), not a secret.
  captchaSiteKey: ''
};
