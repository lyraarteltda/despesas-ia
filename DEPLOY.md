# Deployment Guide

## Standard Deploy (CLI — recommended)

Deploy from the project directory using the Netlify CLI:

```bash
npx netlify-cli deploy --prod --dir . --site "$SITE_ID" --auth "$NETLIFY_AUTH_TOKEN"
```

To get your `SITE_ID`, check the Netlify dashboard or run:
```bash
curl -s -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" \
  "https://api.netlify.com/api/v1/sites?filter=all&name=<site-name>" | \
  python3 -c "import sys,json; [print(s['id'], s['name']) for s in json.load(sys.stdin)]"
```

## Preview Deploys

Deploy a preview (non-production) to test before going live:

```bash
npx netlify-cli deploy --dir . --site "$SITE_ID" --auth "$NETLIFY_AUTH_TOKEN"
```

This returns a draft URL you can test. When satisfied, re-deploy with `--prod`.

## Optional: GitHub Auto-Deploy

⚠️ **Caveat**: GitHub integration may fail with SSH host key verification errors. CLI deploy is more reliable.

If configured, pushing to `main` triggers a Netlify auto-deploy. To enable:
1. Netlify dashboard > Site > Configuration > Build & deploy > Link repository
2. Or use the API with the `repo` field (see project-scaffold skill)

### Branch Deploys (requires GitHub integration)

1. Push a feature branch to GitHub
2. Netlify auto-creates a preview at: `https://feature-branch--<site-name>.netlify.app`
3. Enable in Netlify: Site > Configuration > Build & deploy > Branch deploys > "All"

## Rollback

### Via CLI
```bash
# List recent deploys
curl -s "https://api.netlify.com/api/v1/sites/<SITE_ID>/deploys?per_page=10" \
  -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" | \
  python3 -c "import sys,json; [print(f'{d[\"id\"]} | {d[\"created_at\"]} | {d[\"state\"]}') for d in json.load(sys.stdin)]"

# Rollback to a specific deploy
curl -s -X POST "https://api.netlify.com/api/v1/sites/<SITE_ID>/deploys/<DEPLOY_ID>/restore" \
  -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN"
```

### Via Dashboard
1. Go to Netlify > Site > Deploys
2. Find the last known-good deploy
3. Click "Publish deploy"

## Environment Variables

Set via Netlify dashboard (Site > Configuration > Environment variables), NOT in code:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (for Netlify functions only)
- `SUPABASE_ANON_KEY`
- `ZAPI_INSTANCE`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`
- `ARTHUR_WHATSAPP`

## Pre-Deploy Checklist

1. Run security check: `bash templates/security-check.sh <project-dir>`
2. Test locally: `npx serve .`
3. Verify membership gate works
4. Check no secrets in frontend bundle
5. Confirm RLS enabled on all Supabase tables
