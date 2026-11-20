import { randomUUID } from 'node:crypto';
import { integer, requireValue, secret } from '../config.js';
import { HttpError, httpClient } from '../http.js';
import { offerProfile, sameOfferProfile } from '../resources.js';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkRoute(active, previous, local, wholesale, upstreams) {
  if (active && active.wholesale !== wholesale) {
    throw new RequestError(409, 'This runner pool already has an activation');
  }
  if (!active && previous?.peer) {
    throw new RequestError(
      409,
      'Previous upstream activation is still draining'
    );
  }
  if (!active && !local && (wholesale || upstreams === 0)) {
    throw new RequestError(409, 'No machine capacity is available');
  }
}

function activationBudget(old, maxCents, credit, minimum) {
  if (old?.maxCents !== undefined) {
    if (maxCents !== undefined && maxCents !== old.maxCents) {
      throw new RequestError(
        409,
        'Stop this activation to change its spending limit'
      );
    }
    return old.maxCents;
  }
  const budget = maxCents ?? credit;
  integer(budget, 1, Number.MAX_SAFE_INTEGER, 'activation spending limit');
  if (budget < minimum || budget > credit) {
    throw new RequestError(
      402,
      'The spending limit must cover the selected capacity and fit available credit'
    );
  }
  return budget;
}

function priceMatches(remote, peer, own) {
  return (
    remote.currency === 'usd' &&
    Number.isSafeInteger(remote.rate) &&
    remote.rate > 0 &&
    remote.rate <= peer.maxRate &&
    remote.scope?.toLowerCase() === own.scope.toLowerCase() &&
    remote.label === own.label &&
    remote.capacity === own.capacity &&
    sameOfferProfile(remote.profile, offerProfile(own))
  );
}

function suppliers(store, config, { env, fetcher, active, funded }) {
  function peerClient(peer) {
    return httpClient(peer.origin, {
      headers: { authorization: `Bearer ${secret(peer.keyEnv, env)}` },
      fetcher,
      notation: peer.notation === 'lino',
    });
  }

  async function compatiblePeers(account, pool) {
    const offers = [];
    for (const peer of account.upstreams) {
      try {
        const remote = await peerClient(peer)('/v1/offer');
        if (remote.available && priceMatches(remote, peer, pool)) {
          offers.push({ peer, rate: remote.rate });
        }
      } catch {
        // An unavailable offer does not prevent queries to other suppliers.
      }
    }
    offers.sort((a, b) => a.rate - b.rate);
    return offers;
  }

  async function claimPeer(id, peer, pool, rate) {
    const current = active(id);
    if (!current || !funded(id) || current.route !== 'upstream') {
      return;
    }
    if (!current.peer) {
      store.put('lease', id, { ...current, peer: peer.origin, peerRate: rate });
    }
    await peerClient(peer)('/v1/wholesale', {
      method: 'PUT',
      body: {
        expires: current.expires,
        rateCeiling: rate,
        scope: pool.scope,
        label: pool.label,
        capacity: pool.capacity,
        profile: offerProfile(pool),
      },
    });
  }

  async function releaseRejectedClaim(id, peer, error) {
    if (!(error instanceof HttpError) || ![402, 409].includes(error.status)) {
      throw error;
    }
    const { activation, draining } = await peerClient(peer)('/v1/offer');
    // Keep the supplier pinned if it could be holding capacity for this hub.
    if (activation !== null || draining !== false) {
      throw error;
    }
    const current = store.get('lease', id);
    if (current?.peer === peer.origin) {
      store.put('lease', id, { ...current, peer: null, peerRate: null });
    }
  }

  async function provisionUpstream(id, lease) {
    const account = config.accounts[id];
    const pool = config.pools[account.pool];
    if (lease.peer) {
      const peer = account.upstreams.find(
        ({ origin }) => origin === lease.peer
      );
      requireValue(peer, 'Restore the configured upstream for this activation');
      return claimPeer(id, peer, pool, lease.peerRate ?? peer.maxRate);
    }
    for (const { peer, rate } of await compatiblePeers(account, pool)) {
      try {
        return await claimPeer(id, peer, pool, rate);
      } catch (error) {
        await releaseRejectedClaim(id, peer, error);
      }
    }
    throw new Error(
      'No upstream can supply the requested runner profile, capacity and price'
    );
  }

  async function releaseUpstream(id, lease) {
    const peer = config.accounts[id].upstreams.find(
      ({ origin }) => origin === lease.peer
    );
    requireValue(
      peer,
      'Restore the supplier configuration to release its outstanding activation'
    );
    const request = peerClient(peer);
    const { draining } = await request('/v1/wholesale', { method: 'DELETE' });
    if (draining === false && store.get('lease', id)?.peer === lease.peer) {
      store.delete('lease', id);
    }
  }

  return { provisionUpstream, releaseUpstream };
}

export function market(
  store,
  config,
  ledger,
  fleet,
  { env, fetcher, now = Date.now } = {}
) {
  for (const [id, lease] of store.entries('lease')) {
    if (lease.profile && (lease.expires > now() || lease.peer)) {
      const pool = config.pools[config.accounts[id]?.pool];
      requireValue(
        pool &&
          lease.capacity === pool.capacity &&
          sameOfferProfile(lease.profile, offerProfile(pool)),
        `Account ${id} must finish draining before its runner configuration changes`
      );
    }
  }

  const active = (id) => {
    const lease = store.get('lease', id);
    return lease && lease.expires > now() ? lease : null;
  };

  const funded = (id, lease = active(id)) => {
    const account = config.accounts[id];
    const rate = lease?.rate ?? account.rate;
    const available = Math.min(ledger.credit(id), ledger.remaining(id, lease));
    return available >= rate * config.pools[account.pool].capacity;
  };

  const upstream = suppliers(store, config, { env, fetcher, active, funded });

  function offer(id) {
    const { pool, rate } = config.accounts[id];
    const { scope, label, capacity } = config.pools[pool];
    const activation = active(id);
    const draining = fleet.poolMachines(pool).length > 0 && !activation;
    return {
      scope,
      label,
      capacity,
      rate: activation?.rate ?? rate,
      profile: offerProfile(config.pools[pool]),
      currency: 'usd',
      available: !activation && !draining && funded(id) && fleet.hasRoom(pool),
      activation,
      draining,
      credit: ledger.credit(id),
    };
  }

  function activate(id, expires, wholesale = false, maxCents) {
    integer(expires, now() + 1, now() + 3600000, 'activation expiration');
    if (!funded(id)) {
      throw new RequestError(402, 'Add credit before activating runners');
    }
    const account = config.accounts[id];
    const previous = store.get('lease', id);
    const old = active(id);
    const local = fleet.hasRoom(account.pool);
    checkRoute(old, previous, local, wholesale, account.upstreams.length);
    const rate = old?.rate ?? account.rate;
    const pool = config.pools[account.pool];
    const max = activationBudget(
      old,
      maxCents,
      ledger.credit(id),
      rate * pool.capacity
    );
    const lease = {
      ...old,
      expires: Math.max(old?.expires ?? 0, expires),
      starts: old?.starts ?? Math.floor(now() / 1000) * 1000,
      window: old?.window ?? randomUUID(),
      route: old?.route ?? (local ? 'local' : 'upstream'),
      wholesale,
      rate,
      maxCents: max,
      profile: offerProfile(pool),
      capacity: pool.capacity,
    };
    return ledger.saveLease(id, lease);
  }

  function withdraw(id, wholesale = false) {
    const old = store.get('lease', id);
    if (old?.wholesale === wholesale && old.expires > now()) {
      ledger.saveLease(id, { ...old, expires: now() });
    }
    return { active: false, draining: offer(id).draining };
  }

  async function reconcile(report) {
    const routes = {};
    for (const [id, { pool }] of Object.entries(config.accounts)) {
      const lease = active(id);
      routes[pool] = 'off';
      try {
        if (lease && funded(id)) {
          routes[pool] = lease.route;
          if (lease.route === 'upstream') {
            await upstream.provisionUpstream(id, lease);
          }
        } else {
          const previous = store.get('lease', id);
          if (lease) {
            withdraw(id, lease.wholesale);
          }
          if (previous?.peer) {
            await upstream.releaseUpstream(id, previous);
          }
        }
      } catch (error) {
        report(id, error);
      }
    }
    return routes;
  }

  return { offer, activate, withdraw, reconcile };
}
