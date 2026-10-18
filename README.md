# Despesas IA

Leitor de recibos e notas em lote: fotos e PDFs viram planilha, resumo e relatório de despesas.

## Stack

- **Hosting**: Netlify (pure static site — no serverless functions)
- **Backend**: n8n webhooks (the ONLY backend the browser talks to). All
  membership verification, feedback, and deletion run server-side in n8n, which
  holds every credential. Supabase sits behind n8n; the browser ships zero
  Supabase URL/key/table-name.
- **AI**: BYOK (Bring Your Own Key) — users provide their own API keys
- **Community**: Maestros da IA (Circle)

## Access

This tool is exclusive to paying members of Maestros da IA. Users must verify their membership with the email and WhatsApp number used at purchase.

## BYOK (Bring Your Own Key)

This tool uses AI services powered by YOUR API key. Your key is stored only in your browser's localStorage and is never sent to our servers. You can clear your keys at any time from the settings menu.

## Local Development

```bash
npx serve .
```

Open `http://localhost:3000` in your browser.

## Security

- No Supabase client, key, URL, or table name in the browser — all DB access is
  behind n8n (which uses the service_role key server-side); Supabase RLS stays on
  as defence-in-depth
- No server-side storage of user API keys
- CORS handled by the n8n webhooks; CSP `connect-src` limited to the n8n host and
  the BYOK AI providers
- CSP + security headers configured in `netlify.toml`
- LGPD compliant

## Built by

APP-BUILDER-01 — Autonomous Solution Builder for Maestros da IA
