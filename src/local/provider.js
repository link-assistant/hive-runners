import { isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { requireValue } from '../config.js';
import { githubClient } from '../github.js';
import { gitlabClient } from '../gitlab.js';
import { HttpError } from '../http.js';

async function credential(path) {
  requireValue(
    isAbsolute(path),
    'Use an absolute administrator token file path'
  );
  // O_NOFOLLOW is unavailable on Windows. There the directory must have a private ACL.
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const info = await file.stat();
    requireValue(
      info.isFile() &&
        info.size > 0 &&
        info.size <= 8192 &&
        (process.platform === 'win32' || (info.mode & 0o077) === 0),
      'Administrator token requires a private regular file'
    );
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer);
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    requireValue(
      bytesRead < buffer.length && /^[!-~]+$/.test(token),
      'Invalid administrator token'
    );
    return token;
  } finally {
    await file.close();
  }
}

const jobId = ({ id }) => {
  requireValue(Number.isSafeInteger(id) && id > 0, 'Invalid provider job ID');
  return String(id);
};

function sameLabel(labels, expected) {
  return Array.isArray(labels) && labels.length === 1 && labels[0] === expected;
}

async function deleteMatching(records, lease, remove, nameField) {
  const matching = records.filter((record) => record[nameField] === lease.id);
  requireValue(matching.length <= 1, 'Ambiguous provider runner record');
  if (matching.length) {
    try {
      await remove(matching[0].id);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) {
        throw error;
      }
    }
  }
}

function githubProvider(client, pool) {
  return {
    async queued() {
      await client.requirePrivateRepo(pool.scope);
      const runs = await Promise.all(
        ['queued', 'in_progress'].map((status) =>
          client.listWorkflowRuns(pool.scope, status)
        )
      );
      const queued = [];
      for (const run of new Set(runs.flat().map(jobId))) {
        for (const job of await client.listWorkflowJobs(
          pool.scope,
          Number(run)
        )) {
          if (job.status === 'queued' && sameLabel(job.labels, pool.label)) {
            queued.push(jobId(job));
          }
        }
        if (queued.length >= pool.slots) {
          break;
        }
      }
      return queued;
    },
    async register(lease) {
      await client.requirePrivateRepo(pool.scope);
      return (await client.generateJitConfig(pool.scope, lease.id, pool.label))
        .encoded_jit_config;
    },
    async cleanup(lease) {
      await deleteMatching(
        await client.listRunners(pool.scope),
        lease,
        (id) => client.deleteRunner(pool.scope, id),
        'name'
      );
    },
  };
}

function gitlabProvider(client, pool) {
  return {
    async queued() {
      await client.privateScope(pool.scope, 'project');
      return (await client.pendingJobs(pool.scope))
        .filter(
          (job) =>
            job.status === 'pending' &&
            !job.runner &&
            sameLabel(job.tag_list, pool.label)
        )
        .map(jobId);
    },
    async register(lease) {
      return (
        await client.createRunner(pool.scope, 'project', pool.label, lease.id)
      ).token;
    },
    async cleanup(lease) {
      await deleteMatching(
        await client.listRunners(pool.scope),
        lease,
        client.deleteRunner,
        'description'
      );
    },
  };
}

export async function providerFor(pool, { fetcher }) {
  const token = await credential(pool.tokenFile);
  return pool.platform === 'github'
    ? githubProvider(githubClient(token, fetcher), pool)
    : gitlabProvider(gitlabClient(pool.origin, token, fetcher), pool);
}
