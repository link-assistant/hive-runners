import { integer, object, requireValue } from '../config.js';

const max = Number.MAX_SAFE_INTEGER;

export const defaultAdmission = Object.freeze({
  basis: 'free',
  percentage: 49,
});

export function admissionPolicy(value = defaultAdmission) {
  object(value, 'admission policy');
  requireValue(
    ['free', 'total'].includes(value.basis),
    'Invalid admission basis'
  );
  return {
    basis: value.basis,
    percentage: integer(
      value.percentage,
      value.basis === 'total' ? 50 : 1,
      value.basis === 'total' ? 80 : 50,
      'admission percentage'
    ),
  };
}

function budget(scope, sample, leases, now, maxAgeMs) {
  requireValue(
    sample?.identity === scope.identity &&
      Number.isSafeInteger(sample.observedAt) &&
      now >= sample.observedAt &&
      now - sample.observedAt <= maxAgeMs,
    'Missing, stale or mismatched resource telemetry'
  );
  return Object.fromEntries(
    Object.entries(scope.resources).map(([resource, identity]) => {
      const reading = sample.resources?.[resource];
      requireValue(
        reading?.identity === identity,
        `Mismatched ${resource} resource identity`
      );
      const total = integer(reading.total, 1, max, `${resource} total`);
      const available = integer(
        reading.available,
        0,
        total,
        `${resource} available`
      );
      let reserved = scope.overhead[resource] ?? 0;
      let used = 0;
      for (const lease of leases) {
        const allocation = lease.claims[scope.id]?.[resource] ?? 0;
        const observed = reading.usage?.[lease.id] ?? 0;
        used += integer(
          observed,
          0,
          allocation,
          `${resource} attributed usage`
        );
        reserved += allocation;
        requireValue(
          Number.isSafeInteger(used + reserved),
          'Resource accounting overflow'
        );
      }
      requireValue(used <= total - available, `Inconsistent ${resource} usage`);
      const grossAvailable = available + used;
      const { basis, percentage } = scope.policy;
      const basisCapacity = basis === 'free' ? grossAvailable : total;
      const fraction = Number(
        (BigInt(basisCapacity) * BigInt(percentage)) / 100n
      );
      return [resource, Math.min(grossAvailable, fraction) - reserved];
    })
  );
}

function workerRoom(available, claims) {
  return Math.min(
    ...Object.entries(claims).flatMap(([scope, resources]) =>
      Object.entries(resources).map(
        ([resource, request]) => (available[scope]?.[resource] ?? -1) / request
      )
    )
  );
}

function chooseWorker(options, available, placed) {
  let best;
  let room = 1;
  for (const option of options) {
    const score = workerRoom(available, option.claims);
    const fewerLeases =
      best && (placed.get(option.node) ?? 0) < (placed.get(best.node) ?? 0);
    if (
      score >= 1 &&
      (!best || score > room || (score === room && fewerLeases))
    ) {
      best = option;
      room = score;
    }
  }
  return best;
}

export function selectWorkers({
  scopes,
  samples,
  leases,
  jobs,
  now = Date.now(),
  maxAgeMs,
}) {
  const rejected = {};
  const available = {};
  for (const scope of scopes) {
    try {
      available[scope.id] = budget(
        scope,
        samples[scope.id],
        leases,
        now,
        maxAgeMs
      );
    } catch (error) {
      rejected[scope.id] = error.message;
    }
  }
  const selected = [];
  const placed = new Map();
  for (const lease of leases) {
    placed.set(lease.node, (placed.get(lease.node) ?? 0) + 1);
  }
  for (const job of jobs) {
    const best = chooseWorker(job.options, available, placed);
    if (!best) {
      continue;
    }
    selected.push({ job: job.id, ...best });
    placed.set(best.node, (placed.get(best.node) ?? 0) + 1);
    for (const [scope, resources] of Object.entries(best.claims)) {
      for (const [resource, request] of Object.entries(resources)) {
        available[scope][resource] -= request;
      }
    }
  }
  return { selected, rejected, available };
}
