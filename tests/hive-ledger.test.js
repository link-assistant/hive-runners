import { rejects, throws } from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'test-anywhere';
import { migrateState } from '@link-assistant/hive-runners';
import { openStore } from '../src/control/store.js';
import { controlPlane } from '../src/control/server.js';
import { FileCheckpointPagedCommitLog } from '@link-foundation/link-cli-client/engine-file-checkpoint-pages';

async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'hive-ledger-test-'));
  try {
    await work(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('Link CLI ledger', () => {
  it('reopens committed transactions across bank replacement and excludes another writer', async () => {
    await withDirectory(async (directory) => {
      const store = openStore(directory, { compactEvery: 2 });
      const memo = { details: ['two\nlines', false, null, {}, []] };
      try {
        store.transaction(() => {
          store.put('credit', 'customer', 50);
          store.put('lease', 'customer', memo);
        });
        expect(store.get('lease', 'customer')).toEqual(memo);
        throws(() => openStore(directory), /exist|writer/i);
        throws(
          () =>
            store.transaction(() => {
              store.delete('credit', 'customer');
              store.put('credit', 'other', 100);
              expect(store.get('credit', 'customer')).toBe(null);
              expect(store.entries('credit')).toEqual([['other', 100]]);
              throw new Error('roll back both writes');
            }),
          /roll back/
        );
        expect(store.entries('credit')).toEqual([['customer', 50]]);
        store.put('job', 'already-billed', true);
        store.transaction(() => {
          store.put('credit', 'customer', 30);
          store.delete('lease', 'customer');
        });
      } finally {
        store.close();
      }
      const reopened = openStore(directory);
      try {
        expect(reopened.get('credit', 'customer')).toBe(30);
        expect(reopened.get('job', 'already-billed')).toBe(true);
        expect(reopened.get('lease', 'customer')).toBe(null);
      } finally {
        reopened.close();
      }
      const journal = new FileCheckpointPagedCommitLog(
        join(directory, 'runner.links')
      );
      try {
        expect(journal.epoch).toBe(1n);
      } finally {
        journal.close();
      }
    });
  });

  it('imports the old SQLite records and preserves the input as well as a preexisting destination', async () => {
    await withDirectory(async (directory) => {
      const { DatabaseSync } = await import('node:sqlite');
      const source = join(directory, 'runner.sqlite');
      const destination = join(directory, 'ledger');
      const db = new DatabaseSync(source);
      try {
        db.exec(
          'CREATE TABLE records (scope TEXT, id TEXT, data TEXT, PRIMARY KEY (scope, id)) WITHOUT ROWID;'
        );
        const put = db.prepare('INSERT INTO records VALUES (?, ?, ?)');
        put.run('job', 'paid-17', '{"metered":true}');
        put.run('balance', 'customer', '13');
      } finally {
        db.close();
      }
      const original = await readFile(source);
      expect(await migrateState(source, destination)).toBe(destination);
      const migrated = openStore(destination);
      try {
        expect(migrated.get('job', 'paid-17')).toEqual({ metered: true });
        expect(migrated.get('balance', 'customer')).toBe(13);
      } finally {
        migrated.close();
      }
      await rejects(migrateState(source, destination), /new directory/);
      expect(await readFile(source)).toEqual(original);
    });
  });

  it('rejects an incomplete portal template before serving', async () => {
    await withDirectory(async (directory) => {
      await writeFile(
        join(directory, 'portal.lino'),
        "(page (title 'Broken') (h1 (content 'Hello')))"
      );
      throws(
        () => controlPlane({ version: 1 }, { env: { HIVE_UI_DIR: directory } }),
        /Portal needs a form with id login/
      );
    });
  });
});
