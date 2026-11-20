import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { arcHost } from '../arc.js';
import { requireValue } from '../config.js';
import { HttpError } from '../http.js';
import { machineName } from '../infrastructure.js';
import { runProcess } from '../process.js';
import { providerClient } from '../providers.js';
import { withWorkspace } from '../workspace.js';
import { spareFleet } from './spare.js';

export function bootstrapKeys(run = runProcess) {
  return withWorkspace(async ({ directory }) => {
    const path = join(directory, 'host-key');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path]);
    const [key, publicKey] = await Promise.all([
      readFile(path, 'utf8'),
      readFile(`${path}.pub`, 'utf8'),
    ]);
    const knownKey = publicKey.trim().split(' ').slice(0, 2).join(' ');
    return {
      knownKey,
      userData: `#cloud-config\n${JSON.stringify({
        ssh_pwauth: false,
        disable_root: false,
        ssh_deletekeys: true,
        ssh_keys: { ed25519_private: key, ed25519_public: knownKey },
      })}`,
    };
  });
}

function totals(config, store, provider) {
  const reserved = Object.values(config.pools)
    .filter((pool) => pool.provider === provider)
    .reduce((sum, pool) => sum + pool.terraformMachines, 0);
  const machines = store
    .entries('machine')
    .filter(([, machine]) => machine.provider === provider);
  return { reserved, machines };
}

function binding(pool, cloud) {
  return [
    pool.scope.toLowerCase(),
    pool.label,
    cloud.type,
    cloud.tokenPrefix,
  ].join('/');
}

function machineLifecycle(store, config, { now, host, keys }) {
  async function create(name, pool, client) {
    const { knownKey, userData } = await keys();
    const id = randomUUID();
    const key = machineName(config.prefix, name, id.slice(0, 8));
    const pending = {
      name: key,
      pool: name,
      provider: pool.provider,
      binding: binding(pool, config.providers[pool.provider]),
      phase: 'ordering',
      knownKey,
      wanted: now(),
    };
    store.put('machine', key, pending);
    try {
      const remote = await client.create(key, userData, id);
      requireValue(
        remote.name === key && /^[0-9]+$/.test(remote.id),
        'Provider returned an unexpected instance'
      );
      store.put('machine', key, {
        ...pending,
        remoteId: remote.id,
        phase: 'booting',
      });
    } catch (error) {
      if (
        error instanceof HttpError &&
        [400, 401, 403, 422, 429].includes(error.status)
      ) {
        store.delete('machine', key);
      }
      throw error;
    }
  }

  function target(machine, remote, pool) {
    requireValue(isIP(remote.ip) === 4, 'Waiting for provider IPv4');
    return {
      ip: remote.ip,
      group: pool.scope.includes('/') ? undefined : machine.name,
      knownHosts: `${remote.ip} ${machine.knownKey}\n`,
    };
  }

  async function retire(machine, remote, client) {
    if (machine.phase !== 'retiring') {
      store.put('machine', machine.name, { ...machine, phase: 'retiring' });
    }
    await client.retire(remote);
  }

  async function applyMachine(machine, remote, pool, client, demand) {
    const time = now();
    if (!remote) {
      if (machine.phase === 'retiring') {
        store.delete('machine', machine.name);
      } else {
        throw new Error(`Awaiting provider confirmation for ${machine.name}`);
      }
      return;
    }
    if (machine.phase === 'retiring') {
      await retire(machine, remote, client);
      return;
    }
    if (machine.phase === 'ordering') {
      store.put('machine', machine.name, {
        ...machine,
        remoteId: remote.id,
        phase: 'booting',
      });
      return;
    }
    const hostTarget = target(machine, remote, pool);
    if (demand.keep) {
      await maintain(machine, pool, hostTarget, time);
    } else if (
      !demand.allow ||
      time - machine.wanted >= pool.idleSeconds * 1000
    ) {
      await drain(machine, pool, hostTarget, remote, client, time);
    }
  }

  async function maintain(machine, pool, hostTarget, time) {
    if (machine.phase !== 'active') {
      await host(pool, hostTarget);
    }
    const refresh = !machine.observed || time - machine.observed > 120000;
    const metrics = refresh
      ? await host(pool, hostTarget, 'inspect')
      : machine.metrics;
    store.put('machine', machine.name, {
      ...machine,
      phase: 'active',
      wanted: time,
      emptySince: null,
      metrics,
      observed: refresh ? time : machine.observed,
    });
  }

  async function drain(machine, pool, hostTarget, remote, client, time) {
    if (machine.phase === 'booting') {
      // An interrupted bootstrap may have deployed ARC. Never assume the instance is empty.
      await host(pool, hostTarget, 'deploy-drained');
    }
    const result = await host(
      pool,
      hostTarget,
      machine.phase === 'draining' ? 'inspect' : 'drain'
    );
    const count = typeof result === 'number' ? result : result.runners;
    const emptySince = count === 0 ? (machine.emptySince ?? time) : null;
    store.put('machine', machine.name, {
      ...machine,
      phase: 'draining',
      emptySince,
    });
    if (emptySince !== null && time - emptySince >= 60000) {
      await retire(machine, remote, client);
    }
  }

  return { create, applyMachine };
}

export function fleet(
  store,
  config,
  {
    env,
    fetcher,
    now = Date.now,
    host = arcHost({ env, fetcher }),
    provider = (cloud) => providerClient(cloud, { env, fetcher }),
    keys = bootstrapKeys,
    report = () => {},
  } = {}
) {
  let reconciling = false;
  const { create, applyMachine } = machineLifecycle(store, config, {
    now,
    host,
    keys,
  });

  const spare = spareFleet(store, config, { now, host, report });

  function poolMachines(name) {
    const machines = store
      .entries('machine')
      .map(([, machine]) => machine)
      .filter((machine) => machine.pool === name);
    return [...machines, ...spare.machines(name)];
  }

  function hasRoom(name) {
    const pool = config.pools[name];
    if (!pool.provider || pool.terraformMachines >= pool.maxMachines) {
      return Boolean(pool.spareHost);
    }
    const { reserved, machines } = totals(config, store, pool.provider);
    const leases = store.entries('lease').filter(([id, lease]) => {
      const reservedPool = config.accounts[id]?.pool;
      return (
        reservedPool !== name &&
        config.pools[reservedPool]?.provider === pool.provider &&
        lease.route === 'local' &&
        lease.expires > now() &&
        !machines.some(([, machine]) => machine.pool === reservedPool)
      );
    });
    const loaded = machines.filter(([, machine]) => machine.pool === name);
    if (loaded.some(([, machine]) => machine.phase !== 'retiring')) {
      return true;
    }
    return (
      reserved + machines.length + leases.length <
      config.providers[pool.provider].maxMachines
    );
  }

  function validateBindings() {
    spare.validateBindings();
    for (const [, machine] of store.entries('machine')) {
      const pool = config.pools[machine.pool];
      const cloud = config.providers[machine.provider];
      requireValue(
        pool?.provider === machine.provider &&
          cloud &&
          machine.binding === binding(pool, cloud),
        `Existing machine ${machine.name} must be drained before removing or moving its pool or provider credentials`
      );
    }
  }

  async function reconcilePool(name, pool, client, remotes, demand) {
    const wanted = demand.allow
      ? Math.min(
          pool.maxMachines - pool.terraformMachines,
          Math.max(
            pool.minMachines,
            Math.ceil(demand.count / pool.capacity) - pool.terraformMachines
          )
        )
      : 0;
    const machines = poolMachines(name).sort(
      (a, b) =>
        Number(b.phase === 'active') - Number(a.phase === 'active') ||
        (b.metrics?.runners ?? 0) - (a.metrics?.runners ?? 0) ||
        a.wanted - b.wanted
    );
    const canRun = machines.filter(({ phase }) => phase !== 'retiring');
    for (const machine of machines) {
      const remote = remotes.find(
        (entry) =>
          entry.name === machine.name &&
          (!machine.remoteId || entry.id === machine.remoteId)
      );
      const index = canRun.indexOf(machine);
      try {
        await applyMachine(machine, remote, pool, client, {
          allow: demand.allow,
          keep: index >= 0 && index < wanted,
        });
      } catch (error) {
        report(name, error);
      }
    }
    const { reserved, machines: all } = totals(config, store, pool.provider);
    if (
      wanted > canRun.length &&
      reserved + all.length < config.providers[pool.provider].maxMachines
    ) {
      await create(name, pool, client);
    }
  }

  async function reconcile(workloads, paidRouting) {
    if (reconciling) {
      return;
    }
    reconciling = true;
    try {
      validateBindings();
      await spare.reconcile(workloads, paidRouting);
      for (const [id, cloud] of Object.entries(config.providers)) {
        try {
          const client = provider(cloud);
          const remotes = await client.list();
          // Unpaid and minimum private capacity is considered first.
          const pools = Object.entries(config.pools)
            .filter(([, pool]) => pool.provider === id)
            .sort(
              ([a], [b]) =>
                Number(Object.hasOwn(paidRouting, a)) -
                Number(Object.hasOwn(paidRouting, b))
            );
          for (const [name, pool] of pools) {
            try {
              const { queued, running } = workloads[name];
              await reconcilePool(name, pool, client, remotes, {
                count: queued + running,
                allow:
                  !Object.hasOwn(paidRouting, name) ||
                  paidRouting[name] === 'local',
              });
            } catch (error) {
              report(name, error);
            }
          }
        } catch (error) {
          report(id, error);
        }
      }
    } finally {
      reconciling = false;
    }
  }

  return { reconcile, hasRoom, validateBindings, poolMachines };
}
