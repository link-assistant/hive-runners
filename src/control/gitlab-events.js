import {
  gitlabScope,
  poolRepositories,
  requireValue,
  secret,
} from '../config.js';
import { gitlabClient } from '../gitlab.js';
import { RequestError } from './market.js';
import { digest, secureEqual } from './usage.js';

export function gitlabEvents(config, usage, { env, now, fetcher }) {
  const keys = new Map();
  const paid = new Set(Object.values(config.accounts).map(({ pool }) => pool));
  for (const [name, pool] of Object.entries(config.pools)) {
    if (pool.platform !== 'gitlab') {
      continue;
    }
    const key = secret(pool.webhookSecretEnv, env);
    requireValue(
      key.startsWith('whsec_')
        ? /^whsec_[A-Za-z0-9+/]{43}=$/.test(key)
        : /^[!-~]{32,512}$/.test(key),
      'Use a GitLab signing token or a webhook secret of at least 32 characters'
    );
    const entry = keys.get(key) ?? { origin: pool.gitlabUrl, pools: new Set() };
    requireValue(
      entry.origin === pool.gitlabUrl,
      'GitLab webhook secrets must be unique per server'
    );
    entry.pools.add(name);
    keys.set(key, entry);
  }
  for (const { pools } of keys.values()) {
    requireValue(
      pools.size === 1 || ![...pools].some((name) => paid.has(name)),
      'Each paid pool requires a unique GitLab webhook secret'
    );
  }

  function authenticate(headers, bytes) {
    const signature = headers['webhook-signature'];
    const timestamp = headers['webhook-timestamp'];
    const id = headers['webhook-id'];
    for (const [key, entry] of keys) {
      if (key.startsWith('whsec_')) {
        if (
          typeof signature !== 'string' ||
          typeof id !== 'string' ||
          !id ||
          typeof timestamp !== 'string' ||
          !/^\d{10}$/.test(timestamp) ||
          Math.abs(now() - Number(timestamp) * 1000) > 300000
        ) {
          continue;
        }
        const raw = Buffer.from(key.slice(6), 'base64');
        const expected = Buffer.from(
          digest(raw, `${id}.${timestamp}.`, bytes),
          'hex'
        ).toString('base64');
        if (
          signature
            .split(' ')
            .some((candidate) => secureEqual(candidate, `v1,${expected}`))
        ) {
          return entry;
        }
      } else if (!signature && secureEqual(headers['x-gitlab-token'], key)) {
        return entry;
      }
    }
    throw new RequestError(401, 'Invalid GitLab webhook credential');
  }

  async function ingest(payload, { origin, pools }) {
    const repo = payload.project?.path_with_namespace;
    const id = payload.build_id;
    if (
      payload.object_kind !== 'build' ||
      typeof repo !== 'string' ||
      !gitlabScope.test(repo) ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      ![
        'pending',
        'preparing',
        'running',
        'canceling',
        'success',
        'failed',
        'canceled',
        'skipped',
      ].includes(payload.build_status)
    ) {
      return;
    }
    const candidates = [...pools].filter((name) =>
      poolRepositories(config.pools[name]).includes(repo)
    );
    if (!candidates.length) {
      return;
    }
    // The Job Hook doesn't include the job's requested tags. Read durable
    // state from the authenticated Jobs API, which also resolves stale events.
    const signal = AbortSignal.timeout(6500);
    let job;
    for (const name of candidates) {
      const client = gitlabClient(
        origin,
        secret(config.pools[name].groupTokenEnv, env),
        fetcher,
        signal
      );
      try {
        [, job] = await Promise.all([
          client.privateScope(repo, 'project'),
          client.job(repo, id),
        ]);
        break;
      } catch (error) {
        if (name === candidates.at(-1)) {
          throw new RequestError(
            502,
            `Could not verify GitLab job ${id}. ${error.message}`
          );
        }
      }
    }
    if (job?.id !== id) {
      throw new RequestError(502, 'GitLab returned an unexpected job');
    }
    usage.ingestGitlab(repo, job, candidates);
  }

  return { enabled: keys.size > 0, authenticate, ingest };
}
