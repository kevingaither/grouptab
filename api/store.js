const { createClient } = require('@libsql/client');

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = Promise.resolve(
      createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      })
    ).then(async (db) => {
      await db.execute(
        'CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
      );
      return db;
    });
  }
  return clientPromise;
}

// A path's direct children under `prefix` are rows whose path starts with
// `prefix/` and has no further `/` after that point (one level deeper only).
function isDirectChild(prefix, path) {
  if (!path.startsWith(prefix + '/')) return false;
  const rest = path.slice(prefix.length + 1);
  return rest.length > 0 && !rest.includes('/');
}

const PATH_RE = /^[A-Za-z0-9_\-.]{1,200}(?:\/[A-Za-z0-9_\-.]{1,200}){0,15}$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { op, path, data } = body || {};
  if (!op || typeof path !== 'string' || !PATH_RE.test(path)) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  try {
    const db = await getClient();

    if (op === 'get') {
      const r = await db.execute({ sql: 'SELECT data FROM docs WHERE path = ?', args: [path] });
      if (!r.rows.length) { res.json({ exists: false }); return; }
      res.json({ exists: true, data: JSON.parse(r.rows[0].data) });
      return;
    }

    if (op === 'list') {
      const r = await db.execute({ sql: 'SELECT path, data FROM docs WHERE path LIKE ?', args: [path + '/%'] });
      const docs = r.rows
        .filter((row) => isDirectChild(path, row.path))
        .map((row) => ({ id: row.path.slice(path.length + 1), data: JSON.parse(row.data) }));
      res.json({ docs: docs });
      return;
    }

    if (op === 'set' || op === 'update') {
      if (data == null || typeof data !== 'object' || Array.isArray(data)) {
        res.status(400).json({ error: 'invalid_data' });
        return;
      }
      let finalData = data;
      if (op === 'update') {
        const r = await db.execute({ sql: 'SELECT data FROM docs WHERE path = ?', args: [path] });
        if (!r.rows.length) { res.status(400).json({ error: 'not_found' }); return; }
        finalData = Object.assign({}, JSON.parse(r.rows[0].data), data);
      }
      const json = JSON.stringify(finalData);
      if (json.length > 250000) { res.status(400).json({ error: 'too_large' }); return; }
      await db.execute({
        sql: 'INSERT INTO docs (path, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at',
        args: [path, json, Date.now()],
      });
      res.json({ ok: true });
      return;
    }

    if (op === 'delete') {
      await db.execute({ sql: 'DELETE FROM docs WHERE path = ?', args: [path] });
      res.json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'unknown_op' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error', message: String((e && e.message) || e) });
  }
};
