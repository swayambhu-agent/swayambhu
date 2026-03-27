// Google Docs API tool — create and update documents via existing Gmail OAuth.
// Requires scopes: documents, drive.file (add to gmail-auth.mjs).
// No `export default`.

export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  kv_access: "none",
  timeout_ms: 30000,
  provider: "gmail",
};

const DOCS_API = "https://docs.googleapis.com/v1/documents";

async function getToken(provider, secrets, fetchFn) {
  return provider.getAccessToken(secrets, fetchFn);
}

export async function execute({ action, doc_id, title, content, provider, secrets, fetch }) {
  const token = await getToken(provider, secrets, fetch);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };

  if (action === "create") {
    // Create a new empty doc, then insert content
    const createResp = await fetch(DOCS_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: title || "Swayambhu Research Brief" }),
    });
    if (!createResp.ok) {
      const err = await createResp.text();
      return { error: `Failed to create doc (${createResp.status}): ${err}` };
    }
    const doc = await createResp.json();
    const newDocId = doc.documentId;

    // Insert content if provided
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
        return { doc_id: newDocId, url: `https://docs.google.com/document/d/${newDocId}`, warning: `Created but content insert failed: ${err}` };
      }
    }

    return {
      doc_id: newDocId,
      url: `https://docs.google.com/document/d/${newDocId}`,
    };
  }

  if (action === "update") {
    if (!doc_id) return { error: "doc_id required for update" };
    if (!content) return { error: "content required for update" };

    // Get current doc to find content length
    const getResp = await fetch(`${DOCS_API}/${doc_id}`, { headers });
    if (!getResp.ok) {
      const err = await getResp.text();
      return { error: `Failed to read doc (${getResp.status}): ${err}` };
    }
    const doc = await getResp.json();
    const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 2;

    // Full rewrite: delete all content, then insert new
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

  return { error: `Unknown action: ${action}. Use "create" or "update".` };
}
