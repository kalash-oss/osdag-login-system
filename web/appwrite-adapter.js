/**
 * appwrite-adapter.js
 * --------------------
 * Makes index.html's "Appwrite" backend-mode radio button actually work.
 *
 * Same trick mock-api.js uses: intercept window.fetch for the routes the
 * client calls (/register, /login, /logout, /me, /files, /files/:id,
 * /files/:id/download) and translate them into REAL Appwrite Web SDK calls
 * — not a fake/local implementation. Every one of these hits Appwrite's
 * actual REST API over the network.
 *
 * Requires the Appwrite Web SDK to be loaded first (see the commented
 * <script> tags in index.html) and the "Appwrite settings" fields in
 * index.html to be filled in with your project's real endpoint/IDs.
 *
 * GET /files/:id and the 403-vs-404 distinction:
 * Appwrite's document security returns 404 for BOTH "doesn't exist" and
 * "exists but you have no read permission on it" when the CALLER's own
 * session is used to fetch it — that's by design, to avoid leaking the
 * existence of other users' documents to an ordinary client. Getting a real
 * 403 (as this task requires) needs a check from a trusted server context
 * that isn't subject to the caller's own permissions, so `handleFileById`
 * below calls the `files-access` Appwrite Function (see
 * appwrite-backend/functions/files-access/) instead of querying the
 * database directly. See that function's source for the full explanation
 * and README §8/§16 for deployment steps.
 */
(function () {
  function cfg() {
    return {
      endpoint: document.getElementById('awEndpoint').value.trim(),
      projectId: document.getElementById('awProjectId').value.trim(),
      databaseId: document.getElementById('awDatabaseId').value.trim(),
      filesCollectionId: document.getElementById('awFilesCollectionId').value.trim(),
      bucketId: document.getElementById('awBucketId').value.trim(),
      filesAccessFunctionId: document.getElementById('awFilesAccessFunctionId').value.trim(),
    };
  }

  function client() {
    const c = cfg();
    return new Appwrite.Client().setEndpoint(c.endpoint).setProject(c.projectId);
  }

  function json(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Appwrite throws AppwriteException with a `.code` (HTTP status) and
  // `.type` (machine-readable error type). We map these to the same
  // generic-error shape the task requires, never leaking Appwrite's own
  // more detailed message for auth failures.
  function mapAuthError(err) {
    return json(401, { error: 'Invalid email or password' });
  }

  async function handleRegister(req) {
    const { email, password } = await req.json();
    if (!email || !password) return json(400, { error: 'email and password are required' });

    const account = new Appwrite.Account(client());
    try {
      const user = await account.create(Appwrite.ID.unique(), email, password, email.split('@')[0]);

      // Prefs (fullName/bio/role/createdAt) can only be set with an active
      // session, so log in briefly, set them, then log back out — /register
      // in this client contract does not itself return a session.
      try {
        await account.createEmailPasswordSession(email, password);
        await account.updatePrefs({
          fullName: '',
          bio: '',
          role: 'user',
          createdAt: new Date().toISOString(),
        });
        await account.deleteSession('current');
      } catch (prefsErr) {
        console.warn('[appwrite-adapter] could not set initial prefs:', prefsErr);
      }

      return json(201, { id: user.$id, email: user.email });
    } catch (err) {
      if (err.code === 409) return json(409, { error: 'An account with that email already exists' });
      console.error('[appwrite-adapter] register error:', err);
      return json(400, { error: 'Registration failed' });
    }
  }

  async function handleLogin(req) {
    const { email, password } = await req.json();
    const account = new Appwrite.Account(client());
    try {
      await account.createEmailPasswordSession(email, password);
      const user = await account.get();
      // No bearer token: Appwrite's Web SDK manages the session via a
      // cookie set on its own domain, sent automatically on subsequent SDK
      // calls. index.html's token field simply stays empty in this mode.
      return json(200, { user: { id: user.$id, email: user.email } });
    } catch (err) {
      // Appwrite already returns a generic 401 for bad credentials and does
      // its own platform-level rate limiting on auth endpoints; we still
      // normalize the message so the client contract matches the custom
      // backend exactly.
      return mapAuthError(err);
    }
  }

  async function handleLogout() {
    const account = new Appwrite.Account(client());
    try {
      await account.deleteSession('current');
    } catch (err) {
      // Already logged out / no session — treat as success either way,
      // logout should be idempotent from the client's point of view.
    }
    return json(200, { message: 'Logged out' });
  }

  async function handleMe() {
    const account = new Appwrite.Account(client());
    try {
      const user = await account.get();
      const prefs = user.prefs || {};
      return json(200, {
        id: user.$id,
        email: user.email,
        profile: {
          fullName: prefs.fullName || '',
          displayName: user.name || '',
          bio: prefs.bio || '',
          createdAt: prefs.createdAt || user.registration,
          role: prefs.role || 'user',
        },
      });
    } catch (err) {
      return json(401, { error: 'Not authenticated' });
    }
  }

  async function currentUserId(account) {
    const user = await account.get(); // throws if not authenticated
    return user.$id;
  }

  async function handleFiles() {
    const c = cfg();
    const account = new Appwrite.Account(client());
    const databases = new Appwrite.Databases(client());
    try {
      const userId = await currentUserId(account);
      // Explicit ownerId filter on top of Appwrite's document security —
      // belt-and-suspenders, matches the "ownership is part of the query"
      // principle from the custom backend, even though document security
      // alone would already prevent other users' docs from being returned.
      const result = await databases.listDocuments(c.databaseId, c.filesCollectionId, [
        Appwrite.Query.equal('ownerId', userId),
      ]);
      const files = result.documents.map((d) => ({
        id: d.$id,
        fileName: d.fileName,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        uploadedAt: d.uploadedAt,
      }));
      return json(200, { files });
    } catch (err) {
      if (err.code === 401) return json(401, { error: 'Not authenticated' });
      console.error('[appwrite-adapter] list files error:', err);
      return json(500, { error: 'Internal server error' });
    }
  }

  async function handleFileById(fileId) {
    const account = new Appwrite.Account(client());
    const c = cfg();

    // Step 1 — mint a short-lived JWT for the CALLER's own session. This is
    // also our auth check: createJWT() throws if there's no active session,
    // which we map to 401 exactly like every other authenticated route here.
    let jwt;
    try {
      const jwtResult = await account.createJWT();
      jwt = jwtResult.jwt;
    } catch (err) {
      return json(401, { error: 'Not authenticated' });
    }

    if (!c.filesAccessFunctionId) {
      console.error(
        '[appwrite-adapter] awFilesAccessFunctionId is not set. Deploy the ' +
          'appwrite-backend/functions/files-access Function and fill in its ' +
          'ID in the "Appwrite settings" panel — see README §8/§16.'
      );
      return json(500, { error: 'Files access function not configured' });
    }

    // Step 2 — the actual 403-vs-404 decision happens server-side in the
    // files-access Function, using an admin API key that isn't subject to
    // the caller's own document permissions (see that function's source).
    // We only hand it a JWT (proves who the caller is) and the requested
    // fileId — never an admin key, never a userId we could have spoofed.
    const functions = new Appwrite.Functions(client());
    try {
      const execution = await functions.createExecution(
        c.filesAccessFunctionId,
        JSON.stringify({ fileId, jwt }),
        false, // synchronous — we need the result immediately
        undefined,
        'POST',
        { 'content-type': 'application/json' }
      );
      const status = execution.responseStatusCode || 500;
      let body;
      try {
        body = JSON.parse(execution.responseBody || '{}');
      } catch (parseErr) {
        body = { error: 'Internal server error' };
      }
      return json(status, body);
    } catch (err) {
      console.error('[appwrite-adapter] files-access function call failed:', err);
      return json(500, { error: 'Internal server error' });
    }
  }

  async function handleFileDownload(fileId) {
    const c = cfg();
    const account = new Appwrite.Account(client());
    const databases = new Appwrite.Databases(client());
    const storage = new Appwrite.Storage(client());
    try {
      await currentUserId(account);
    } catch (err) {
      return new Response('Not authenticated', { status: 401 });
    }
    try {
      const doc = await databases.getDocument(c.databaseId, c.filesCollectionId, fileId);
      const url = storage.getFileDownload(c.bucketId, doc.storageFileId);
      // Real network fetch against Appwrite's storage download endpoint —
      // the browser sends the Appwrite session cookie automatically.
      return fetch(url, { credentials: 'include' });
    } catch (err) {
      return new Response('File not found', { status: 404 });
    }
  }

  const realFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    const modeRadio = document.querySelector('input[name="backendMode"]:checked');
    if (!modeRadio || modeRadio.value !== 'appwrite') return realFetch(input, init);

    if (typeof Appwrite === 'undefined') {
      console.error('[appwrite-adapter] Appwrite Web SDK not loaded — uncomment the SDK <script> tag in index.html');
      return json(500, { error: 'Appwrite SDK not loaded' });
    }

    const url = typeof input === 'string' ? input : input.url;
    const { pathname } = new URL(url, window.location.href);
    const req = new Request(url, init);

    if (pathname === '/register' && req.method === 'POST') return handleRegister(req);
    if (pathname === '/login' && req.method === 'POST') return handleLogin(req);
    if (pathname === '/logout' && req.method === 'POST') return handleLogout();
    if (pathname === '/me' && req.method === 'GET') return handleMe();
    if (pathname === '/files' && req.method === 'GET') return handleFiles();

    let m = pathname.match(/^\/files\/([^/]+)\/download$/);
    if (m && req.method === 'GET') return handleFileDownload(m[1]);

    m = pathname.match(/^\/files\/([^/]+)$/);
    if (m && req.method === 'GET') return handleFileById(m[1]);

    return json(404, { error: 'No Appwrite adapter route for ' + req.method + ' ' + pathname });
  };

  console.info('[appwrite-adapter] ready — select "Appwrite" backend mode and fill in the settings fields above');
})();
