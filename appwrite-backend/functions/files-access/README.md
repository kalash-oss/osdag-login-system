# files-access (Appwrite Function)

Resolves the `GET /files/:id` 403-vs-404 gap described in the top-level
`README.md` (§16 "Known limitation" / §20 "what I'd improve") and in
`web/appwrite-adapter.js`. See `src/main.js` for the full explanation of why
this needs to be a server-side Function rather than something the browser
can do with the Appwrite Web SDK alone.

Deploy steps, required env vars, and execute permissions are documented in
the top-level `README.md`, section **"8. How to run — Appwrite
implementation"**, so setup instructions live in exactly one place.
