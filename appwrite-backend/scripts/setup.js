/**
 * setup.js — one-time Appwrite project configuration.
 *
 * This is the script that answers "what did I configure myself" in the
 * README. Appwrite gives you auth, a database, and storage out of the box,
 * but user-data isolation on the database/storage side is NOT automatic —
 * you must explicitly:
 *
 *   1. Turn on "document security" for the files collection, and "file
 *      security" for the storage bucket. Without this, permissions are
 *      only checked at the collection/bucket level, and any permission
 *      granted there (e.g. "any authenticated user can read") applies to
 *      EVERY document/file regardless of who created it.
 *   2. Grant NO collection-level / bucket-level read permission to
 *      Role.users() (all logged-in users). Read access is granted only at
 *      the individual document/file level, at creation time, to the
 *      specific owner (see seed.js) — that's what actually enforces
 *      "User A cannot read User B's file".
 *
 * Run once: npm run setup
 * Safe to re-run — it checks for existing resources before creating them.
 */
require('dotenv').config();
const { Client, Databases, Storage, IndexType } = require('node-appwrite');

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const storage = new Storage(client);

const DB_ID = process.env.APPWRITE_DATABASE_ID;
const FILES_COLLECTION_ID = process.env.APPWRITE_FILES_COLLECTION_ID;
const BUCKET_ID = process.env.APPWRITE_BUCKET_ID;

async function ignoreIfExists(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err.code === 409) return null; // already exists — fine, this script is idempotent
    throw err;
  }
}

async function main() {
  console.log('Creating database...');
  await ignoreIfExists(databases.create(DB_ID, 'Secure Login DB'));

  console.log('Creating files collection...');
  // NOTE the collection is created with NO collection-level permissions
  // (empty permissions array) and documentSecurity=true. That combination
  // means: nobody gets access from the collection itself; access comes
  // ONLY from permissions set on each individual document.
  await ignoreIfExists(
    databases.createCollection(DB_ID, FILES_COLLECTION_ID, 'files', [], true /* documentSecurity */)
  );

  console.log('Creating attributes...');
  await ignoreIfExists(databases.createStringAttribute(DB_ID, FILES_COLLECTION_ID, 'ownerId', 255, true));
  await ignoreIfExists(databases.createStringAttribute(DB_ID, FILES_COLLECTION_ID, 'fileName', 512, true));
  await ignoreIfExists(databases.createStringAttribute(DB_ID, FILES_COLLECTION_ID, 'mimeType', 255, true));
  await ignoreIfExists(databases.createIntegerAttribute(DB_ID, FILES_COLLECTION_ID, 'sizeBytes', true));
  await ignoreIfExists(databases.createStringAttribute(DB_ID, FILES_COLLECTION_ID, 'storageFileId', 255, true));
  await ignoreIfExists(databases.createDatetimeAttribute(DB_ID, FILES_COLLECTION_ID, 'uploadedAt', true));

  // Attributes need a moment to become "available" before you can index them.
  console.log('Waiting for attributes to become available...');
  await new Promise((r) => setTimeout(r, 5000));

  console.log('Creating index on ownerId (defense in depth — queries filter by owner explicitly, on top of document security)...');
  await ignoreIfExists(
    databases.createIndex(DB_ID, FILES_COLLECTION_ID, 'idx_ownerId', IndexType.Key, ['ownerId'])
  );

  console.log('Creating storage bucket...');
  // Same pattern as the collection: no bucket-level permissions, fileSecurity=true.
  // Access to each file is granted individually, to its owner, when it's uploaded.
  await ignoreIfExists(
    storage.createBucket(BUCKET_ID, 'user-files', [], false, true /* fileSecurity */)
  );

  console.log('\nSetup complete.');
  console.log('Verify in the Appwrite console: Databases > Secure Login DB > files collection');
  console.log('  -> Settings tab -> "Document Security" should show ON, permissions list empty.');
  console.log('Storage > user-files bucket -> Settings -> "File Security" should show ON, permissions list empty.');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
