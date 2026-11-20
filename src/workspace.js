import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withWorkspace(work) {
  const directory = await mkdtemp(join(tmpdir(), 'hive-runners-'));
  try {
    return await work({
      directory,
      async save(name, data) {
        const path = join(directory, name);
        await writeFile(path, data, { mode: 0o600 });
        return path;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
