import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  githubScope,
  integer,
  poolRepositories,
  requireValue,
} from '../config.js';

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
  return poolRepositories(pool).some(
    (path) => path.toLowerCase() === repo.toLowerCase()
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

function usageWindows(store, now) {
  const scope = (id) => `activation:${id}`;
  return {
    saveLease(id, lease) {
      return store.transaction(() => {
        const history = scope(id);
        if (lease.window && !store.get(history, lease.window)) {
          const retention = now() - 14 * day;
          for (const [key, { expires }] of store.entries(history)) {
            if (expires < retention) {
              store.delete(history, key);
            }
          }
        }
        if (lease.window) {
          store.put(history, lease.window, {
            ...store.get(history, lease.window),
            starts: lease.starts,
            expires: lease.expires,
            ...(lease.rate === undefined ? {} : { rate: lease.rate }),
            ...(lease.maxCents === undefined
              ? {}
              : { maxCents: lease.maxCents }),
          });
        }
        return store.put('lease', id, lease);
      });
    },
    find(id, started) {
      return store
        .entries(scope(id))
        .find(
          ([, { starts, expires }]) => starts <= started && started < expires
        );
    },
    charge(id, [key, record], cents) {
      store.put(scope(id), key, {
        ...record,
        charged: (record.charged ?? 0) + cents,
      });
    },
  };
}

function rebuildWorkloads(store, time) {
  // Older ledgers contain jobs without a separate active-work projection.
  // Build it once; reconciliation only reads queued and running records.
  if (!store.get('schema', 'workloads')) {
    const pending = store
      .entries('job')
      .filter(([, job]) => job.stage < 2 && time - job.seen <= 7 * day);
    for (let index = 0; index < pending.length; index += 128) {
      store.transaction(() => {
        for (const [key, job] of pending.slice(index, index + 128)) {
          store.put('workload', key, {
            pool: job.pool,
            stage: job.stage,
            seen: job.seen,
          });
        }
      });
    }
    store.put('schema', 'workloads', { version: 1 });
  }
}

function settleJob(
  { windows, config, credit, adjust },
  { account, previous, stage, minutes, started, ownRunner }
) {
  const window =
    stage === 2 &&
    account &&
    minutes &&
    ownRunner &&
    windows.find(account, started);
  const fallbackRate = previous?.rate ?? config.accounts[account]?.rate ?? 0;
  if (!window) {
    return { rate: fallbackRate, charge: 0 };
  }
  const rate = window[1].rate ?? fallbackRate;
  const allowance =
    (window[1].maxCents ?? Number.MAX_SAFE_INTEGER) - (window[1].charged ?? 0);
  const charge = Math.max(
    0,
    Math.min(minutes * rate, allowance, credit(account))
  );
  if (charge) {
    adjust(account, -charge);
    windows.charge(account, window, charge);
  }
  return { rate, charge };
}

function jobRecorder(
  store,
  config,
  { now, windows, accounts, credit, adjust }
) {
  return (pool, repo, job, stage, ownRunner, trackedOnly = false) => {
    const settings = config.pools[pool];
    const origin =
      settings.platform === 'gitlab' ? `${settings.gitlabUrl}:` : '';
    const key = `${origin}${repo.toLowerCase()}:${integer(job.id, 1, Number.MAX_SAFE_INTEGER, 'workflow job ID')}`;
    const time = now();
    const { started, minutes } = jobTimes(job, time);
    const account = accounts.get(pool);
    return store.transaction(() => {
      const previous = store.get('job', key);
      if (
        (trackedOnly && previous?.pool !== pool) ||
        !acceptUpdate(previous, stage, minutes)
      ) {
        return false;
      }
      const { rate, charge } = settleJob(
        { windows, config, credit, adjust },
        { account, previous, stage, minutes, started, ownRunner }
      );
      store.put('job', key, {
        pool,
        stage,
        rate,
        seen: time,
        started: Number.isFinite(started) ? started : null,
        minutes,
        charge,
      });
      if (stage < 2) {
        store.put('workload', key, { pool, stage, seen: time });
      } else {
        store.delete('workload', key);
      }
      return true;
    });
  };
}

function activeWorkloads(store, pools, time) {
  const status = Object.fromEntries(
    Object.keys(pools).map((pool) => [pool, { queued: 0, running: 0 }])
  );
  const expired = [];
  for (const [key, job] of store.entries('workload')) {
    const ttl = job.stage === 0 ? day + 3600000 : 7 * day;
    if (time - job.seen > ttl) {
      expired.push(key);
    } else if (Object.hasOwn(status, job.pool)) {
      status[job.pool][job.stage === 0 ? 'queued' : 'running']++;
    }
  }
  for (let index = 0; index < expired.length; index += 128) {
    store.transaction(() => {
      for (const key of expired.slice(index, index + 128)) {
        store.delete('workload', key);
      }
    });
  }
  return status;
}

export function ledger(store, config, now = Date.now) {
  const windows = usageWindows(store, now);
  const accounts = new Map(
    Object.entries(config.accounts).map(([id, account]) => [account.pool, id])
  );
  for (const [id, account] of Object.entries(config.accounts)) {
    store.transaction(() => {
      const pool = config.pools[account.pool];
      const target = `${pool.scope.toLowerCase()}/${pool.label}`;
      const identity =
        pool.platform === 'gitlab'
          ? `${pool.gitlabUrl}/${pool.gitlabRunnerId}/${target}`
          : target;
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

  rebuildWorkloads(store, now());
  const record = jobRecorder(store, config, {
    now,
    windows,
    accounts,
    credit,
    adjust,
  });

  function ingest(payload, authorizedPools) {
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
      ([, pool]) =>
        pool.platform === 'github' &&
        job.labels.includes(pool.label) &&
        belongsTo(pool, repo)
    );
    return (
      matches.length === 1 &&
      authorizedPools.has(matches[0][0]) &&
      record(
        matches[0][0],
        repo,
        job,
        stages[action],
        typeof job.runner_name === 'string' &&
          job.runner_name.startsWith(`${matches[0][1].label}-`)
      )
    );
  }

  function ingestGitlab(repo, job, authorizedPools) {
    const stage = {
      pending: 0,
      preparing: 1,
      running: 1,
      canceling: 1,
      success: 2,
      failed: 2,
      canceled: 2,
      skipped: 2,
    }[job.status];
    if (!Number.isInteger(stage)) {
      return false;
    }
    const eligible = [...authorizedPools].filter((name) => {
      const pool = config.pools[name];
      return (
        belongsTo(pool, repo) &&
        Array.isArray(job.tag_list) &&
        job.tag_list.length === 1 &&
        job.tag_list[0] === pool.label
      );
    });
    if (eligible.length !== 1) {
      return false;
    }
    const [name] = eligible;
    const ours = job.runner?.id === config.pools[name].gitlabRunnerId;
    const elsewhere = stage > 0 && !ours;
    if (elsewhere && stage < 2 && !job.runner?.id) {
      return false;
    }
    return record(
      name,
      repo,
      {
        id: job.id,
        started_at: job.started_at,
        completed_at: job.finished_at,
      },
      elsewhere ? 2 : stage,
      ours,
      elsewhere
    );
  }

  function remaining(id, lease) {
    const window = lease?.window && store.get(`activation:${id}`, lease.window);
    return (
      (lease?.maxCents ?? Number.MAX_SAFE_INTEGER) - (window?.charged ?? 0)
    );
  }

  return {
    credit,
    adjust,
    ingest,
    ingestGitlab,
    workloads: () => activeWorkloads(store, config.pools, now()),
    remaining,
    saveLease: windows.saveLease,
  };
}
