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
