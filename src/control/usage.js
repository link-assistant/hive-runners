import { createHmac, timingSafeEqual } from 'node:crypto';
import { githubScope, integer, requireValue } from '../config.js';

export function secureEqual(value, expected) {
  const provided = Buffer.from(typeof value === 'string' ? value : '');
  const secret = Buffer.from(expected);
  return provided.length === secret.length && timingSafeEqual(provided, secret);
}

export function digest(secret, ...parts) {
  const hmac = createHmac('sha256', secret);
  for (const part of parts) {
    hmac.update(part);
  }
  return hmac.digest('hex');
}

const stages = { queued: 0, in_progress: 1, completed: 2 };
const day = 24 * 60 * 60 * 1000;

function belongsTo(pool, repo) {
  const [owner, name] = repo.toLowerCase().split('/');
  return pool.scope.includes('/')
    ? pool.scope.toLowerCase() === repo.toLowerCase()
    : pool.scope.toLowerCase() === owner &&
        pool.selectedRepositories.some(
          (candidate) => candidate.toLowerCase() === name
        );
}

function jobTimes(job, now) {
  const started = Date.parse(job.started_at);
  const completed = Date.parse(job.completed_at);
  return {
    started,
    minutes:
      Number.isFinite(started) &&
      Number.isFinite(completed) &&
      completed >= started &&
      completed <= now + 300000 &&
      completed - started <= 7 * day
        ? Math.max(1, Math.ceil((completed - started) / 60000))
        : 0,
  };
}

function acceptUpdate(previous, stage, minutes) {
  return (
    !previous ||
    previous.stage < stage ||
    (stage === 2 &&
      previous.stage === 2 &&
      previous.minutes === 0 &&
      minutes > 0)
  );
}

export function ledger(store, config, now = Date.now) {
  const accounts = new Map(
    Object.entries(config.accounts).map(([id, account]) => [account.pool, id])
  );
  for (const [id, account] of Object.entries(config.accounts)) {
    store.transaction(() => {
      const pool = config.pools[account.pool];
      const identity = `${pool.scope.toLowerCase()}/${pool.label}`;
      const balance = store.get('balance', id);
      requireValue(
        !balance || balance.identity === identity,
        `Account ${id} already belongs to another runner pool`
      );
      if (!balance) {
        store.put('balance', id, { credit: account.initialCredit, identity });
      }
    });
  }

  function credit(id) {
    return store.get('balance', id)?.credit ?? 0;
  }

  function adjust(id, delta) {
    const account = store.get('balance', id);
    integer(
      account.credit + delta,
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      'account balance'
    );
    store.put('balance', id, { ...account, credit: account.credit + delta });
  }

  function record(pool, repo, job, stage) {
    const key = `${repo.toLowerCase()}:${integer(job.id, 1, Number.MAX_SAFE_INTEGER, 'workflow job ID')}`;
    const time = now();
    const { started, minutes } = jobTimes(job, time);
    const account = accounts.get(pool);
    const label = config.pools[pool].label;
    return store.transaction(() => {
      const previous = store.get('job', key);
      if (!acceptUpdate(previous, stage, minutes)) {
        return false;
      }
      const rate = previous?.rate ?? config.accounts[account]?.rate ?? 0;
      const metered =
        stage === 2 &&
        account &&
        minutes &&
        typeof job.runner_name === 'string' &&
        job.runner_name.startsWith(`${label}-`);
      const charge = metered ? minutes * rate : 0;
      if (charge) {
        adjust(account, -charge);
      }
      store.put('job', key, {
        pool,
        stage,
        rate,
        seen: time,
        started: Number.isFinite(started) ? started : null,
        minutes,
        charge,
      });
      return true;
    });
  }

  function ingest(payload) {
    const { action, repository, workflow_job: job } = payload;
    const repo = repository?.full_name;
    if (
      !Object.hasOwn(stages, action) ||
      !repository?.private ||
      !githubScope.test(repo) ||
      !repo.includes('/') ||
      !Array.isArray(job?.labels)
    ) {
      return false;
    }
    const matches = Object.entries(config.pools).filter(
      ([, pool]) => job.labels.includes(pool.label) && belongsTo(pool, repo)
    );
    return (
      matches.length === 1 && record(matches[0][0], repo, job, stages[action])
    );
  }

  function workloads() {
    const status = Object.fromEntries(
      Object.keys(config.pools).map((pool) => [pool, { queued: 0, running: 0 }])
    );
    const time = now();
    for (const [, job] of store.entries('job')) {
      if (!Object.hasOwn(status, job.pool) || time - job.seen > 7 * day) {
        continue;
      }
      if (job.stage === 0 && time - job.seen <= day + 3600000) {
        status[job.pool].queued++;
      }
      if (job.stage === 1) {
        status[job.pool].running++;
      }
    }
    return status;
  }

  return { credit, adjust, ingest, workloads };
}
