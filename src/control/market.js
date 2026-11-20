import { integer, requireValue, secret } from '../config.js';
import { httpClient } from '../http.js';

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

function priceMatches(remote, peer, own) {
  return (
    remote.currency === 'usd' &&
    Number.isSafeInteger(remote.rate) &&
    remote.rate > 0 &&
    remote.rate <= peer.maxRate &&
    remote.scope?.toLowerCase() === own.scope.toLowerCase() &&
    remote.label === own.label &&
    Number.isSafeInteger(remote.capacity) &&
    remote.capacity > 0 &&
    remote.capacity <= own.capacity
  );
}

export function market(
  store,
  config,
  ledger,
  fleet,
  { env, fetcher, now = Date.now } = {}
) {
  const active = (id) => {
    const lease = store.get('lease', id);
    return lease && lease.expires > now() ? lease : null;
  };

  const funded = (id) => {
    const account = config.accounts[id];
    return (
      ledger.credit(id) >= account.rate * config.pools[account.pool].capacity
    );
  };

  function offer(id) {
    const { pool, rate } = config.accounts[id];
    const { scope, label, capacity } = config.pools[pool];
    return {
      scope,
      label,
      capacity,
      rate,
      currency: 'usd',
      available: funded(id) && fleet.hasRoom(pool),
      activation: active(id),
      draining: fleet.poolMachines(pool).length > 0 && !active(id),
      credit: ledger.credit(id),
    };
  }

  function activate(id, expires, wholesale = false) {
    integer(expires, now() + 1, now() + 3600000, 'activation expiration');
    if (!funded(id)) {
      throw new RequestError(402, 'Add credit before activating runners');
    }
    const account = config.accounts[id];
    const previous = store.get('lease', id);
    const old = active(id);
    const local = fleet.hasRoom(account.pool);
    checkRoute(old, previous, local, wholesale, account.upstreams.length);
    const route = old?.route ?? (local ? 'local' : 'upstream');
    const lease = {
      expires: Math.max(old?.expires ?? 0, expires),
      route,
      wholesale,
      ...(old?.peer ? { peer: old.peer } : {}),
    };
    return store.put('lease', id, lease);
  }

  function peerClient(peer) {
    return httpClient(peer.origin, {
      headers: { authorization: `Bearer ${secret(peer.keyEnv, env)}` },
      fetcher,
    });
  }

  async function selectPeer(id, account) {
    const own = offer(id);
    const offers = [];
    for (const peer of account.upstreams) {
      try {
        const remote = await peerClient(peer)('/v1/offer');
        if (remote.available && priceMatches(remote, peer, own)) {
          offers.push({ peer, rate: remote.rate });
        }
      } catch {
        // An unavailable offer does not prevent queries to other suppliers.
      }
    }
    offers.sort((a, b) => a.rate - b.rate);
    return offers[0]?.peer;
  }

  async function provisionUpstream(id, lease) {
    const account = config.accounts[id];
    const peer = lease.peer
      ? account.upstreams.find(({ origin }) => origin === lease.peer)
      : await selectPeer(id, account);
    requireValue(
      peer,
      'No upstream can supply the requested repository, label and price'
    );
    const current = active(id);
    if (!current || !funded(id) || current.route !== 'upstream') {
      return;
    }
    if (!current.peer) {
      store.put('lease', id, { ...current, peer: peer.origin });
    }
    await peerClient(peer)('/v1/wholesale', {
      method: 'PUT',
      body: {
        expires: current.expires,
        rateCeiling: peer.maxRate,
        scope: config.pools[account.pool].scope,
        label: config.pools[account.pool].label,
      },
    });
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

  function withdraw(id, wholesale = false) {
    const old = store.get('lease', id);
    if (old?.wholesale === wholesale) {
      store.put('lease', id, { ...old, expires: now() });
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
            await provisionUpstream(id, lease);
          }
        } else {
          const previous = store.get('lease', id);
          if (previous?.peer) {
            withdraw(id);
            await releaseUpstream(id, previous);
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
