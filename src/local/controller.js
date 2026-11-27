import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { requireValue } from '../config.js';
import { runProcess } from '../process.js';
import { selectWorkers } from './admission.js';
import { backendFor } from './backends.js';
import { localConfig, workerOption } from './config.js';
import { providerFor } from './provider.js';
import {
  controllerLock,
  desiredMode,
  openState,
  readState,
  setDesiredMode,
  stateDirectory,
} from './state.js';
import { commandSample, hostSample } from './telemetry.js';

const maxSampleAge = 10000;
const startupHold = 120000;

function noteError(errors, id, error) {
  errors[id] = error.message;
}

async function boundedEach(entries, operation) {
  const remaining = entries.values();
  await Promise.all(
    Array.from({ length: Math.min(entries.length, 4) }, async () => {
      for (const entry of remaining) {
        await operation(entry);
      }
    })
  );
}

async function runtimeInventory(nodes, backends, leases, errors) {
  const observations = {};
  await boundedEach(nodes, async (node) => {
    try {
      observations[node.id] = {
        info: await backends[node.id].inspect(),
        workers: await backends[node.id].list(),
      };
    } catch (error) {
      noteError(errors, node.id, error);
    }
  });
  const ids = new Set(leases.map(({ id }) => id));
  requireValue(
    Object.values(observations).every(({ workers }) =>
      workers.every(({ id }) => ids.has(id))
    ),
    'Worker inventory contains an unknown reservation; reconcile the local state before admitting work'
  );
  return observations;
}

async function cleanupLeases(ctx, observations, errors) {
  const { state, backends, providers, save, now, config } = ctx;
  for (const lease of [...state.leases]) {
    const observation = observations[lease.node];
    if (!observation || !providers[lease.pool]) {
      continue;
    }
    const worker = observation.workers.find(({ id }) => id === lease.id);
    if (worker?.target && worker.target !== config.nodes[lease.node].target) {
      noteError(
        errors,
        lease.node,
        new Error('Worker placed on the wrong runtime node')
      );
      continue;
    }
    if (worker?.state === 'live' || (!worker && now() < lease.holdUntil)) {
      continue;
    }
    try {
      await backends[lease.node].remove(lease, Boolean(worker));
      await providers[lease.pool].cleanup(lease);
      state.leases = state.leases.filter(({ id }) => id !== lease.id);
      await save();
    } catch (error) {
      noteError(errors, lease.node, error);
    }
  }
}

async function measure(ctx, observations, errors) {
  const { config, state, backends, run, env, monitor } = ctx;
  const samples = {};
  await boundedEach(Object.values(config.scopes), async (scope) => {
    try {
      if (scope.id === config.controllerScope) {
        const storage = Object.keys(scope.resources).filter((key) =>
          key.startsWith('fs-')
        );
        requireValue(
          storage.length === 1,
          'Controller sampling requires one configured storage filesystem'
        );
        samples[scope.id] = await monitor({
          [storage[0]]: config.controllerStorage,
        });
      } else if (scope.probe) {
        samples[scope.id] = await commandSample(scope, state.leases, run, env);
      } else {
        const node = Object.values(config.nodes).find(
          ({ runtimeScope }) => runtimeScope === scope.id
        );
        requireValue(observations[node.id], 'Docker engine inspection failed');
        samples[scope.id] = await backends[node.id].sample(
          scope,
          observations[node.id].info
        );
      }
    } catch (error) {
      noteError(errors, scope.id, error);
    }
  });
  return samples;
}

async function routeJobs(ctx, observations, samples, demand, errors) {
  const { config, backends, state } = ctx;
  const jobs = [];
  for (const pool of Object.values(config.pools)) {
    if (!demand[pool.id]?.length) {
      continue;
    }
    const options = [];
    for (const id of pool.nodes) {
      if (!observations[id] || errors[id]) {
        continue;
      }
      try {
        const node = config.nodes[id];
        const reading = samples[node.runtimeScope];
        if (
          node.backend !== 'docker' &&
          reading?.runtimeIdentity !== node.identity
        ) {
          throw new Error(
            'Probe did not verify the pinned runtime node identity'
          );
        }
        await backends[id].ready(pool, observations[id].info, reading);
        options.push(workerOption(pool, node, config));
      } catch (error) {
        noteError(errors, `${pool.id}/${id}`, error);
      }
    }
    const active = state.leases.filter((lease) => lease.pool === pool.id);
    const outstanding = new Set(active.map(({ job }) => job));
    const pending = [...new Set(demand[pool.id])].filter(
      (id) => !outstanding.has(id)
    );
    jobs.push(
      ...pending
        .slice(0, Math.max(0, pool.slots - active.length))
        .map((id) => ({
          id,
          options,
        }))
    );
  }
  return jobs.sort((left, right) => left.options.length - right.options.length);
}

async function launchWorker(ctx, choice, plannedAt, errors) {
  const { directory, state, save, backends, providers, now } = ctx;
  if (
    ctx.isStopping() ||
    (await desiredMode(directory)) !== 'running' ||
    now() - plannedAt > maxSampleAge
  ) {
    return false;
  }
  const lease = {
    ...choice,
    id: `hive-${state.owner}-${randomUUID().replaceAll('-', '')}`,
    holdUntil: now() + startupHold,
  };
  state.leases.push(lease);
  await save();
  try {
    const ticket = await providers[lease.pool].register(lease);
    requireValue(
      typeof ticket === 'string' &&
        ticket.length <= 32768 &&
        /^[A-Za-z0-9_+/=.-]+$/.test(ticket),
      'Provider returned an invalid worker ticket'
    );
    if (
      ctx.isStopping() ||
      (await desiredMode(directory)) !== 'running' ||
      now() - plannedAt > maxSampleAge
    ) {
      lease.holdUntil = 0;
      await save();
      return false;
    }
    await backends[lease.node].inspect();
    if (
      ctx.isStopping() ||
      (await desiredMode(directory)) !== 'running' ||
      now() - plannedAt > maxSampleAge
    ) {
      lease.holdUntil = 0;
      await save();
      return false;
    }
    await backends[lease.node].launch(
      ctx.config.pools[lease.pool],
      lease,
      ticket
    );
    lease.holdUntil = 0;
    await save();
    return true;
  } catch (error) {
    noteError(errors, lease.id, error);
    return false;
  }
}

async function tick(ctx) {
  const {
    config,
    state,
    now,
    directory,
    backends,
    fetcher,
    providerFactory,
    isStopping,
  } = ctx;
  if (isStopping()) {
    await setDesiredMode(directory, 'stopped');
  }
  const mode = await desiredMode(directory);
  requireValue(
    ['running', 'draining', 'stopped'].includes(mode),
    'Invalid persisted local controller mode'
  );
  const errors = {};
  const demand = {};
  ctx.providers = {};
  for (const pool of Object.values(config.pools)) {
    try {
      const provider = await providerFactory(pool, { fetcher });
      ctx.providers[pool.id] = provider;
    } catch (error) {
      noteError(errors, pool.id, error);
    }
  }
  const observations = await runtimeInventory(
    Object.values(config.nodes),
    backends,
    state.leases,
    errors
  );
  await cleanupLeases(ctx, observations, errors);
  if (mode === 'running' && !isStopping()) {
    const eligible = Object.values(config.pools).filter(
      (pool) =>
        ctx.providers[pool.id] &&
        pool.nodes.some((node) => observations[node]) &&
        state.leases.filter((lease) => lease.pool === pool.id).length <
          pool.slots
    );
    await boundedEach(eligible, async (pool) => {
      try {
        demand[pool.id] = await ctx.providers[pool.id].queued();
      } catch (error) {
        noteError(errors, pool.id, error);
      }
    });
  }
  if (
    mode === 'running' &&
    !isStopping() &&
    Object.values(demand).some((jobs) => jobs.length)
  ) {
    const samples = await measure(ctx, observations, errors);
    const jobs = await routeJobs(ctx, observations, samples, demand, errors);
    const plan = selectWorkers({
      scopes: Object.values(config.scopes),
      samples,
      leases: state.leases,
      jobs,
      now: now(),
      maxAgeMs: maxSampleAge,
    });
    Object.assign(errors, plan.rejected);
    const failedNodes = new Set();
    for (const choice of plan.selected) {
      if (failedNodes.has(choice.node)) {
        continue;
      }
      const plannedAt = Math.min(
        ...Object.keys(choice.claims).map((scope) => samples[scope].observedAt)
      );
      if (!(await launchWorker(ctx, choice, plannedAt, errors))) {
        failedNodes.add(choice.node);
      }
    }
  }
  const report = { mode, active: state.leases.length, errors };
  state.report = report;
  await ctx.save();
  return report;
}

export async function localStatus(path, mode) {
  const directory = await stateDirectory(path);
  if (mode) {
    await setDesiredMode(directory, mode);
  }
  const state = await readState(directory);
  return {
    desired: await desiredMode(directory),
    report: state?.report ?? null,
    workers: (state?.leases ?? []).map(({ id, node, pool }) => ({
      id,
      node,
      pool,
    })),
  };
}

async function cycle(ctx, options) {
  let previous;
  for (;;) {
    let report;
    try {
      report = await tick(ctx);
    } catch (error) {
      report = {
        mode: await desiredMode(ctx.directory),
        active: ctx.state.leases.length,
        errors: { controller: error.message },
      };
      ctx.state.report = report;
      await ctx.save();
    }
    const signature = JSON.stringify(report);
    if (signature !== previous) {
      options.report?.(report);
      previous = signature;
    }
    if (
      options.once ||
      ((ctx.isStopping() || report.mode === 'stopped') && report.active === 0)
    ) {
      return report;
    }
    await wait(ctx.config.pollMs);
  }
}

export async function startLocal(input, path, options = {}) {
  const config = localConfig(input);
  const directory = await stateDirectory(path);
  const release = await controllerLock();
  try {
    const store = await openState(directory, config);
    const now = options.now ?? Date.now;
    const env = options.env ?? process.env;
    const run = options.run ?? runProcess;
    const backends = Object.fromEntries(
      Object.values(config.nodes).map((node) => [
        node.id,
        (options.backendFactory ?? backendFor)(node, store.state.owner, {
          run,
          env,
          now,
        }),
      ])
    );
    return await cycle(
      {
        ...store,
        config,
        directory,
        backends,
        now,
        run,
        env,
        fetcher: options.fetcher,
        monitor: options.monitor ?? hostSample,
        providerFactory: options.providerFactory ?? providerFor,
        isStopping: () => options.signal?.aborted === true,
      },
      options
    );
  } finally {
    await release();
  }
}
