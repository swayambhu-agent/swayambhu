# Google Docs Service Account

## Purpose

Replace Gmail OAuth in `tools/google_docs.js` with a Google Service
Account using JWT auth. Service accounts generate tokens on demand
(no refresh tokens, no expiry, no manual re-auth).

## Problem

`google_docs.js` uses `provider: "gmail"` to get an OAuth token via
`getAccessToken()`. Gmail OAuth refresh tokens expire every 7 days
in "Testing" mode. The tool silently breaks.

## Solution

JWT-based auth directly from the Worker using Web Crypto API. The
service account private key lives in Worker secrets. No external
service, no gateway, no OAuth lifecycle.

```
Worker (CF)
┌──────────────────────┐
│ tools/google_docs.js │
│                      │
│ 1. Build JWT claim   │
│ 2. Sign with RS256   │  HTTPS
│    (Web Crypto API)  │ ──────→ Google Docs API
│ 3. Exchange for      │
│    access token      │
│ 4. Call Docs API     │
└──────────────────────┘
```

## How Service Account Auth Works

1. Build a JWT with claims:
   - `iss`: service account email
   - `scope`: `https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file`
   - `aud`: `https://oauth2.googleapis.com/token`
   - `iat`: now
   - `exp`: now + 3600 (1 hour)

2. Sign JWT with RS256 using the service account's private key

3. POST to `https://oauth2.googleapis.com/token` with:
   ```
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
   assertion={signed_jwt}
   ```

4. Get back an access token (valid 1 hour)

5. Use access token to call Docs API (same as current code)

No refresh tokens. Token generated fresh every time. Private key
never expires (can be rotated manually if needed).

## Worker-Side Changes

### Modified: `tools/google_docs.js`

- Remove `provider: "gmail"` — no longer needs gmail provider
- Remove `meta.secrets` Gmail OAuth creds
- Add `meta.secrets`: `["GOOGLE_SA_CLIENT_EMAIL", "GOOGLE_SA_PRIVATE_KEY"]`
- Replace `getToken()` with inline JWT auth using Web Crypto API
- Rest of the tool (create, update) unchanged — same Docs API calls

### New helper: JWT signing

The JWT signing logic is small (~30 lines) and specific to this tool.
Inline it rather than creating a separate module — YAGNI.

```js
async function getServiceAccountToken(secrets, fetchFn) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: secrets.GOOGLE_SA_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const header = { alg: "RS256", typ: "JWT" };
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = enc(header) + "." + enc(claims);

  // Import private key (PEM → CryptoKey)
  const pem = secrets.GOOGLE_SA_PRIVATE_KEY
    .replace(/\\n/g, "\n")  // normalize escaped newlines from env/secrets
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );

  // Sign
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = unsigned + "." + sigB64;

  // Exchange for access token
  const resp = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Service account token exchange failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.access_token;
}
```

### Secrets

Worker secrets (via `wrangler secret put`):
- `GOOGLE_SA_CLIENT_EMAIL` — e.g. `swayambhu@project.iam.gserviceaccount.com`
- `GOOGLE_SA_PRIVATE_KEY` — the PEM private key from the JSON key file

### Google Cloud Setup

1. Go to Google Cloud Console → IAM → Service Accounts
2. Create a service account (e.g. `swayambhu-docs`)
3. Grant it no project-level roles (it only needs doc-specific access)
4. Create a JSON key → download
5. Extract `client_email` and `private_key` from the JSON
6. Push to Worker secrets
7. Share specific Google Docs with the service account email
   (service accounts can only access docs explicitly shared with them)

### What Gets Deleted

- `meta.provider: "gmail"` from google_docs.js
- Gmail OAuth secrets dependency for this tool
- `getToken()` helper that called `provider.getAccessToken()`

### What Doesn't Change

- `providers/gmail.js` — still exists (google_docs was the last
  consumer but other things may reference it; keep for now, delete
  when confirmed unused)
- Docs API calls (create, update) — identical, just different auth
- Tool registry entry — only secrets change
- `index.js` — no change (gmail provider stays registered)

## Quality Lens Assessment

- **Elegance:** Auth colocated with the tool. No external service.
  No OAuth lifecycle. JWT generated on demand.
- **Generality:** Service account pattern works for any Google API.
  Could extend to Drive, Sheets, etc.
- **Robustness:** No token expiry. Private key doesn't expire.
  Token generated fresh every call (no caching needed at this scale).
- **Simplicity:** ~30 lines of JWT code replaces entire OAuth flow.
  No provider dependency.
- **Modularity:** Self-contained in the tool. No cross-cutting changes.
