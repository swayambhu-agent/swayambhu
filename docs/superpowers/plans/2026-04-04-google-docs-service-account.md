# Google Docs Service Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gmail OAuth in google_docs.js with Service Account JWT auth — no token expiry, no manual re-auth.

**Architecture:** JWT signed with Web Crypto API in the Worker, exchanged for access token via Google's token endpoint. ~30 lines replaces the entire OAuth flow.

**Tech Stack:** Web Crypto API (built into Workers), Google OAuth2 token endpoint

**Spec:** `docs/superpowers/specs/2026-04-04-google-docs-service-account-design.md`

---

### Task 1: Update google_docs.js

**Files:**
- Modify: `tools/google_docs.js`

- [ ] **Step 1: Read current implementation**

Read `tools/google_docs.js` to understand the current auth flow.

- [ ] **Step 2: Replace OAuth with Service Account JWT**

```js
// Tool: google_docs — create and update Google Docs via Service Account.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["GOOGLE_SA_CLIENT_EMAIL", "GOOGLE_SA_PRIVATE_KEY"],
  kv_access: "none",
  timeout_ms: 30000,
};

const DOCS_API = "https://docs.googleapis.com/v1/documents";
const SCOPES = "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file";

// JWT-based auth for Google Service Account — no OAuth refresh tokens
async function getServiceAccountToken(secrets, fetchFn) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: secrets.GOOGLE_SA_CLIENT_EMAIL,
    scope: SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const b64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = b64url(header) + "." + b64url(claims);

  // Import PEM private key → CryptoKey
  const pem = secrets.GOOGLE_SA_PRIVATE_KEY
    .replace(/\\n/g, "\n")  // normalize escaped newlines from env/secrets
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Sign
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  // Exchange JWT for access token
  const resp = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${sigB64}`,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Service account auth failed (${resp.status}): ${text}`);
  }
  return (await resp.json()).access_token;
}

export async function execute({ action, doc_id, title, content, email, role, share_with, share_role, secrets, fetch }) {
  const token = await getServiceAccountToken(secrets, fetch);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  if (action === "create") {
    const createResp = await fetch(DOCS_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: title || "Swayambhu Document" }),
    });
    if (!createResp.ok) {
      const err = await createResp.text();
      return { error: `Failed to create doc (${createResp.status}): ${err}` };
    }
    const doc = await createResp.json();
    const newDocId = doc.documentId;

    if (content) {
      const insertResp = await fetch(`${DOCS_API}/${newDocId}:batchUpdate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: 1 }, text: content } }],
        }),
      });
      if (!insertResp.ok) {
        const err = await insertResp.text();
        return {
          doc_id: newDocId,
          url: `https://docs.google.com/document/d/${newDocId}`,
          warning: `Created but content insert failed: ${err}`,
        };
      }
    }

    // Share with specified emails if provided
    const sharedWith = [];
    if (share_with?.length) {
      for (const addr of share_with) {
        const shareResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${newDocId}/permissions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              role: share_role || "reader",
              type: "user",
              emailAddress: addr,
            }),
          },
        );
        if (shareResp.ok) sharedWith.push(addr);
      }
    }

    return {
      doc_id: newDocId,
      url: `https://docs.google.com/document/d/${newDocId}`,
      ...(sharedWith.length ? { shared_with: sharedWith } : {}),
    };
  }

  if (action === "update") {
    if (!doc_id) return { error: "doc_id required for update" };
    if (!content) return { error: "content required for update" };

    const getResp = await fetch(`${DOCS_API}/${doc_id}`, { headers });
    if (!getResp.ok) {
      const err = await getResp.text();
      return { error: `Failed to read doc (${getResp.status}): ${err}` };
    }
    const doc = await getResp.json();
    const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 2;

    const requests = [];
    if (endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: endIndex - 1 },
        },
      });
    }
    requests.push({
      insertText: { location: { index: 1 }, text: content },
    });

    const updateResp = await fetch(`${DOCS_API}/${doc_id}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests }),
    });
    if (!updateResp.ok) {
      const err = await updateResp.text();
      return { error: `Failed to update doc (${updateResp.status}): ${err}` };
    }

    return {
      doc_id,
      url: `https://docs.google.com/document/d/${doc_id}`,
      updated: true,
    };
  }

  if (action === "share") {
    if (!doc_id) return { error: "doc_id required for share" };
    if (!email) return { error: "email required for share" };

    const shareResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${doc_id}/permissions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          role: role || "reader",
          type: "user",
          emailAddress: email,
        }),
      },
    );
    if (!shareResp.ok) {
      const err = await shareResp.text();
      return { error: `Failed to share doc (${shareResp.status}): ${err}` };
    }

    return { shared: true, doc_id, email, role: role || "reader" };
  }

  if (action === "unshare") {
    if (!doc_id) return { error: "doc_id required for unshare" };
    if (!email) return { error: "email required for unshare" };

    // List permissions to find the ID for this email
    const listResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${doc_id}/permissions?fields=permissions(id,emailAddress)`,
      { headers },
    );
    if (!listResp.ok) {
      const err = await listResp.text();
      return { error: `Failed to list permissions (${listResp.status}): ${err}` };
    }
    const perms = (await listResp.json()).permissions || [];
    const perm = perms.find((p) => p.emailAddress === email);
    if (!perm) return { error: `No permission found for ${email}` };

    const delResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${doc_id}/permissions/${perm.id}`,
      { method: "DELETE", headers },
    );
    if (!delResp.ok) {
      const err = await delResp.text();
      return { error: `Failed to unshare (${delResp.status}): ${err}` };
    }

    return { unshared: true, doc_id, email };
  }

  return { error: `Unknown action: ${action}. Use "create", "update", "share", or "unshare".` };
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Fix any test failures in tests/tools.test.js for google_docs tests.

- [ ] **Step 4: Commit**

```bash
git add tools/google_docs.js
git commit -m "feat: replace Gmail OAuth with Service Account JWT in google_docs tool"
```

---

### Task 2: Update Secrets

**Files:**
- Modify: `scripts/push-secrets.sh`
- Modify: `scripts/sync-tool-grants.mjs` (if google_docs is listed)

- [ ] **Step 1: Add service account secrets to push-secrets.sh**

Add to SECRETS array:
```
GOOGLE_SA_CLIENT_EMAIL
GOOGLE_SA_PRIVATE_KEY
```

- [ ] **Step 2: Add google_docs to sync-tool-grants.mjs**

`google_docs` is NOT in the tool list (line 17). Add it — otherwise
the kernel won't get the updated secrets and will still try to
inject the old gmail provider. This is a blocking issue.

In `scripts/sync-tool-grants.mjs`, add `"google_docs"` to the
`toolNames` array.

- [ ] **Step 3: Commit**

```bash
git add scripts/push-secrets.sh scripts/sync-tool-grants.mjs
git commit -m "feat: add Google Service Account secrets for docs tool"
```

---

### Task 3: Google Cloud Setup + Test

- [ ] **Step 1: Create Service Account**

1. Google Cloud Console → IAM → Service Accounts
2. Create `swayambhu-docs` service account
3. Enable Google Docs API and Google Drive API on the project
4. Create JSON key → download

- [ ] **Step 2: Push secrets to Worker**

```bash
# Extract from JSON key file
echo -n "swayambhu-docs@project.iam.gserviceaccount.com" | npx wrangler secret put GOOGLE_SA_CLIENT_EMAIL
cat key.json | jq -r '.private_key' | npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
```

For local dev, add to `.dev.vars`:
```
GOOGLE_SA_CLIENT_EMAIL=swayambhu-docs@project.iam.gserviceaccount.com
GOOGLE_SA_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

- [ ] **Step 3: Test**

Trigger a session that uses google_docs, or test directly via
the Worker's tool dispatch.

---

## Summary

| Task | What |
|------|------|
| 1 | Replace OAuth with JWT in google_docs.js |
| 2 | Update secrets config |
| 3 | Google Cloud setup + test |
