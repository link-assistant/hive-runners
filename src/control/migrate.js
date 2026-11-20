import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { openStore } from './store.js';

export async function migrateState(source, destination) {
  const target = resolve(destination);
  const parent = dirname(target);
  if (existsSync(target)) {
    throw new Error('Choose a new directory for the Link CLI ledger');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(resolve(source), { readOnly: true });
  let staging;
  try {
    await mkdir(parent, { mode: 0o700, recursive: true });
    staging = await mkdtemp(resolve(parent, `.${basename(target)}-migration-`));
    const store = openStore(staging);
    try {
      const records = legacy.prepare('SELECT scope, id, data FROM records');
      let batch = [];
      function writeBatch() {
        store.transaction(() => {
          for (const { scope, id, data } of batch) {
            store.put(scope, id, JSON.parse(data));
          }
        });
        batch = [];
      }
      for (const row of records.iterate()) {
        batch.push(row);
        if (batch.length === 128) {
          writeBatch();
        }
      }
      writeBatch();
    } finally {
      store.close();
    }
    if (existsSync(target)) {
      throw new Error('The destination ledger directory already exists');
    }
    await rename(staging, target);
    staging = undefined;
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return target;
  } finally {
    legacy.close();
    if (staging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
