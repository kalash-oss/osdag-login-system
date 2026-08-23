const { Pool } = require('pg');

// pg reads PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD from process.env
// automatically, so no explicit config object is required here. Keeping it
// explicit anyway makes the connection source obvious when reading the code.
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

pool.on('error', (err) => {
  // Errors on idle clients (e.g. connection dropped) — log, don't crash.
  console.error('Unexpected PostgreSQL error on idle client', err);
});

module.exports = pool;
