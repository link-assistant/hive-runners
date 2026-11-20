import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileCheckpointPagedCommitLog } from '@link-foundation/link-cli-client/engine-file-checkpoint-pages';
import { formatRecord, parseNotation } from '../notation.js';

const checkpointBatchSize = 128;

function changesIn(record) {
  const changes = parseNotation(record);
  if (
    !Array.isArray(changes) ||
    changes.some(
      (row) =>
        !Array.isArray(row) ||
        (row.length !== 2 && row.length !== 3) ||
        typeof row[0] !== 'string' ||
        typeof row[1] !== 'string'
    )
  ) {
    throw new Error('Invalid Hive Runners ledger record');
  }
  return changes;
}

function applyChanges(scopes, changes) {
  for (const row of changes) {
    const [scope, id, value] = row;
    if (row.length === 2) {
      const records = scopes.get(scope);
      records?.delete(id);
      if (records?.size === 0) {
        scopes.delete(scope);
      }
    } else {
      const records = scopes.get(scope) ?? new Map();
      records.set(id, value);
      scopes.set(scope, records);
    }
  }
}

function* checkpoint(scopes) {
  let batch = [];
  for (const [scope, records] of scopes) {
    for (const [id, value] of records) {
      batch.push([scope, id, value]);
      if (batch.length === checkpointBatchSize) {
        yield formatRecord(batch);
        batch = [];
      }
    }
  }
  if (batch.length) {
    yield formatRecord(batch);
  }
}

export function openStore(
  directory,
  { compactEvery = 256, maxPages = 32768 } = {}
) {
  if (directory) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  const log =
    directory &&
    new FileCheckpointPagedCommitLog(join(directory, 'runner.links'), {
      maxPages,
    });
  const scopes = new Map();
  let commits = 0;
  try {
    for (const record of log ? JSON.parse(log.read()) : []) {
      applyChanges(scopes, changesIn(record));
      commits++;
    }
  } catch (error) {
    log?.close();
    throw error;
  }
  let pending;
  let unusable = false;

  function checkOpen() {
    if (unusable) {
      throw new Error('Hive Runners ledger must be reopened');
    }
  }

  function transaction(work) {
    checkOpen();
    if (pending) {
      throw new Error('Nested ledger transactions are unsupported');
    }
    pending = new Map();
    try {
      const result = work();
      if (result && typeof result.then === 'function') {
        throw new TypeError('Ledger transactions must be synchronous');
      }
      const changes = [...pending.values()].flatMap((rows) => [
        ...rows.values(),
      ]);
      if (log && changes.length) {
        try {
          if (commits >= compactEvery) {
            log.replace([...checkpoint(scopes)]);
            commits = 0;
          }
          log.append(formatRecord(changes));
          log.flush();
          commits++;
        } catch (error) {
          unusable = true;
          throw error;
        }
      }
      applyChanges(scopes, changes);
      return result;
    } finally {
      pending = undefined;
    }
  }

  function stage(row) {
    const [scope, id] = row;
    if (!pending) {
      return transaction(() => stage(row));
    }
    const rows = pending.get(scope) ?? new Map();
    rows.set(id, row);
    pending.set(scope, rows);
  }

  return {
    get(scope, id) {
      checkOpen();
      const change = pending?.get(scope)?.get(id);
      const value = change ? change[2] : scopes.get(scope)?.get(id);
      return globalThis.structuredClone(value ?? null);
    },
    entries(scope) {
      checkOpen();
      const view = new Map(scopes.get(scope));
      for (const row of pending?.get(scope)?.values() ?? []) {
        const [, id, value] = row;
        if (row.length === 2) {
          view.delete(id);
        } else {
          view.set(id, value);
        }
      }
      return globalThis.structuredClone(
        [...view].sort(([a], [b]) => (a < b ? -1 : 1))
      );
    },
    put(scope, id, value) {
      stage([scope, id, globalThis.structuredClone(value)]);
      return value;
    },
    delete(scope, id) {
      stage([scope, id]);
    },
    transaction,
    close() {
      unusable = true;
      log?.close();
    },
  };
}
