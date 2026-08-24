const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();
const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage');
const filesReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /files — only files owned by the authenticated user. Ownership is part
// of the WHERE clause (not filtered after fetching everything), so the DB
// itself never returns another user's rows.
router.get('/files', requireAuth, filesReadLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, file_name AS "fileName", mime_type AS "mimeType",
              size_bytes AS "sizeBytes", uploaded_at AS "uploadedAt"
       FROM files WHERE owner_id = $1
       ORDER BY uploaded_at DESC`,
      [req.userId]
    );
    return res.status(200).json({ files: result.rows });
  } catch (err) {
    console.error('List files error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Shared helper: look up a file by id, distinguishing "doesn't exist" (404)
// from "exists but isn't yours" (403). We deliberately do two queries so the
// distinction is explicit and easy to audit, rather than baking ownership
// into a single WHERE clause that would collapse both cases into 404.
async function findFileOrRespondError(req, res, fileId) {
  // Basic UUID sanity check — reject obviously malformed ids before hitting
  // the DB (also avoids a Postgres "invalid input syntax for type uuid" error).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(fileId)) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }

  const result = await pool.query(
    `SELECT id, owner_id AS "ownerId", file_name AS "fileName", mime_type AS "mimeType",
            size_bytes AS "sizeBytes", storage_path AS "storagePath", uploaded_at AS "uploadedAt"
     FROM files WHERE id = $1`,
    [fileId]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }

  const file = result.rows[0];
  if (file.ownerId !== req.userId) {
    // Exists, but belongs to someone else — 403, distinct from 404. We do NOT
    // leak any metadata about the file (name, size, etc.) in this response.
    res.status(403).json({ error: 'You do not have access to this file' });
    return null;
  }

  return file;
}

// GET /files/:id — metadata for a single file, with ownership enforced.
router.get('/files/:id', requireAuth, filesReadLimiter, async (req, res) => {
  try {
    const file = await findFileOrRespondError(req, res, req.params.id);
    if (!file) return; // response already sent by the helper
    const { storagePath, ownerId, ...publicFields } = file;
    return res.status(200).json({ file: publicFields });
  } catch (err) {
    console.error('Get file error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /files/:id/download — streams the actual file bytes, same ownership check.
router.get('/files/:id/download', requireAuth, filesReadLimiter, async (req, res) => {
  try {
    const file = await findFileOrRespondError(req, res, req.params.id);
    if (!file) return;

    const absolutePath = path.join(STORAGE_DIR, file.storagePath);
    // Defense in depth: make sure the resolved path is still inside STORAGE_DIR
    // (storage_path is server-generated, never client-supplied, but this
    // guards against any future regression that lets it be influenced).
    if (!absolutePath.startsWith(STORAGE_DIR)) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    return res.sendFile(absolutePath);
  } catch (err) {
    console.error('Download file error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
