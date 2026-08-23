/**
 * files-access — Appwrite Function
 * ---------------------------------
 * Fixes the exact gap documented in README §16/§20 and appwrite-adapter.js:
 * the Appwrite Web SDK, running as the caller, gets 404 for BOTH "document
 * doesn't exist" and "exists but I have no read permission on it" — document
 * security intentionally hides the second case behind the first so a caller
 * can't probe for other users' document IDs.
 *
 * That's the right default for a client with no server behind it. But this
 * task explicitly requires distinguishing the two cases, and the only way to
 * do that WITHOUT weakening the caller's own permissions (i.e. without
 * granting read on every file to every user) is to check existence and
 * ownership from a trusted server context that isn't subject to the
 * caller's own document-level permissions. That's exactly what an Appwrite
 * Function is for — same "admin API key, never shipped to the browser"
 * principle already used by scripts/setup.js and scripts/seed.js.
 *
 * Request contract (POST body, JSON): { "fileId": "...", "jwt": "..." }
 *   - fileId: the files-collection document id being requested.
 *   - jwt: a short-lived Appwrite JWT for the CALLER's own session, minted
 *     client-side via `account.createJWT()`. We never trust a userId passed
 *     directly in the body — the only identity we trust is whatever this
 *     JWT verifies to, checked server-side via `Account.get()`.
 *
 * Response contract (mirrors the custom backend's /files/:id exactly):
 *   200 { file: { id, fileName, mimeType, sizeBytes, uploadedAt } }
 *   403 { error: 'You do not have access to this file' }
 *   404 { error: 'File not found' }
 *   401 { error: 'Not authenticated' }
 *
 * Required environment variables (set in the Appwrite console, Function
 * Settings > Variables — see README §8/§16 for exact steps):
 *   APPWRITE_API_KEY              server key, scope: databases.read only
 *                                 (least privilege — this function never
 *                                 writes anything)
 *   APPWRITE_DATABASE_ID
 *   APPWRITE_FILES_COLLECTION_ID
 * APPWRITE_FUNCTION_API_ENDPOINT and APPWRITE_FUNCTION_PROJECT_ID are
 * injected automatically by Appwrite into every execution — no need to set
 * those yourself.
 */
const { Client, Account, Databases } = require('node-appwrite');

module.exports = async ({ req, res, log, error }) => {
  const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;

  let payload;
  try {
    payload = req.bodyJson ?? JSON.parse(req.body || '{}');
  } catch (e) {
    return res.json({ error: 'Invalid request body' }, 400);
  }

  const { fileId, jwt } = payload || {};
  if (!fileId || !jwt) {
    return res.json({ error: 'fileId and jwt are required' }, 400);
  }

  // Step 1 — identify the caller from THEIR OWN JWT. Appwrite verifies the
  // JWT's signature and expiry itself when we call account.get() with it;
  // if it's invalid, expired, or missing, this throws and we return 401.
  // This is the only identity check in this function, and it cannot be
  // spoofed by passing a different userId in the request body (there is no
  // userId in the request body at all, by design).
  const userClient = new Client().setEndpoint(endpoint).setProject(projectId).setJWT(jwt);
  const userAccount = new Account(userClient);

  let callerId;
  try {
    const me = await userAccount.get();
    callerId = me.$id;
  } catch (e) {
    return res.json({ error: 'Not authenticated' }, 401);
  }

  // Step 2 — look up the document as an ADMIN (API key), which bypasses
  // document security. This is what lets us see "does this document exist
  // at all" independent of whether the caller has read permission on it.
  // We use this ONLY to check existence + ownerId — the admin-fetched
  // document is never returned to a caller who isn't its owner.
  const adminClient = new Client().setEndpoint(endpoint).setProject(projectId).setKey(process.env.APPWRITE_API_KEY);
  const databases = new Databases(adminClient);

  let doc;
  try {
    doc = await databases.getDocument(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_FILES_COLLECTION_ID,
      fileId
    );
  } catch (e) {
    if (e.code === 404) return res.json({ error: 'File not found' }, 404);
    error('files-access: unexpected error looking up document: ' + e.message);
    return res.json({ error: 'Internal server error' }, 500);
  }

  // Step 3 — the actual 403-vs-404 decision the task requires.
  if (doc.ownerId !== callerId) {
    return res.json({ error: 'You do not have access to this file' }, 403);
  }

  return res.json(
    {
      file: {
        id: doc.$id,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt,
      },
    },
    200
  );
};
