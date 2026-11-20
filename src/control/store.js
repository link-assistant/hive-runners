import { DatabaseSync } from 'node:sqlite';

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (scope, id)
    ) WITHOUT ROWID;
  `);
  const read = db.prepare(
    'SELECT data FROM records WHERE scope = ? AND id = ?'
  );
  const select = db.prepare(
    'SELECT id, data FROM records WHERE scope = ? ORDER BY id'
  );
  const write = db.prepare(`
    INSERT INTO records (scope, id, data) VALUES (?, ?, ?)
    ON CONFLICT(scope, id) DO UPDATE SET data = excluded.data
  `);
  const remove = db.prepare('DELETE FROM records WHERE scope = ? AND id = ?');
  return {
    get(scope, id) {
      const row = read.get(scope, id);
      return row ? JSON.parse(row.data) : null;
    },
    entries(scope) {
      return select.all(scope).map(({ id, data }) => [id, JSON.parse(data)]);
    },
    put(scope, id, value) {
      write.run(scope, id, JSON.stringify(value));
      return value;
    },
    delete(scope, id) {
      remove.run(scope, id);
    },
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
