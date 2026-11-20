import { requireValue } from '../config.js';

function identity(pool) {
  return [
    pool.scope.toLowerCase(),
    pool.label,
    ...Object.values(pool.spareHost),
  ].join('/');
}

export function spareFleet(store, config, { now, host, report }) {
  function validateBindings() {
    const assigned = new Set(
      Object.values(config.pools).map((pool) => pool.spareHost?.ip)
    );
    for (const [name, machine] of store.entries('spare')) {
      const pool = config.pools[name];
      if (
        !pool?.spareHost &&
        machine.phase === 'parked' &&
        !assigned.has(machine.ip)
      ) {
        store.delete('spare', name);
        continue;
      }
      requireValue(
        pool?.spareHost && identity(pool) === machine.binding,
        `Spare host ${name} must be retired and its state explicitly released before changing its assignment`
      );
    }
  }

  function machines(name) {
    const machine = store.get('spare', name);
    return machine && machine.phase !== 'parked' ? [machine] : [];
  }

  async function enable(name, pool, target, machine) {
    const timestamp = now();
    if (machine?.phase !== 'active') {
      store.put('spare', name, {
        name,
        binding: identity(pool),
        phase: 'booting',
        ip: target.ip,
      });
      await host(pool, target);
    }
    const refresh = !machine?.observed || timestamp - machine.observed > 120000;
    const metrics = refresh
      ? await host(pool, target, 'inspect')
      : machine.metrics;
    store.put('spare', name, {
      name,
      binding: identity(pool),
      phase: 'active',
      ip: target.ip,
      observed: refresh ? timestamp : machine.observed,
      metrics,
    });
  }

  async function disable(name, pool, target, machine) {
    if (!machine || machine.phase === 'parked') {
      return;
    }
    if (machine.phase === 'booting') {
      await host(pool, target, 'deploy-drained');
    }
    if (machine.phase === 'parking') {
      await host(pool, target, 'park');
      store.put('spare', name, { ...machine, phase: 'parked' });
      return;
    }
    const operation = machine.phase === 'draining' ? 'inspect' : 'drain';
    const metrics = await host(pool, target, operation);
    const timestamp = now();
    const emptySince =
      metrics.runners === 0 ? (machine.emptySince ?? timestamp) : null;
    const empty = emptySince !== null && timestamp - emptySince >= 60000;
    const next = {
      ...machine,
      phase: empty ? 'parking' : 'draining',
      emptySince,
      metrics,
    };
    store.put('spare', name, next);
  }

  async function reconcile(workloads, paidRouting) {
    for (const [name, pool] of Object.entries(config.pools)) {
      if (!pool.spareHost) {
        continue;
      }
      const machine = store.get('spare', name);
      const { ip, user, hostKey } = pool.spareHost;
      const target = { ip, user, knownHosts: `${ip} ${hostKey}\n` };
      const { queued, running } = workloads[name];
      try {
        const available =
          paidRouting[name] === 'local' &&
          (queued + running > 0 || machine?.phase === 'active');
        if (available && machine?.phase !== 'parking') {
          await enable(name, pool, target, machine);
        } else {
          await disable(name, pool, target, machine);
        }
      } catch (error) {
        report(name, error);
      }
    }
  }

  return { machines, reconcile, validateBindings };
}
