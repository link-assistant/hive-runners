import { httpsOrigin, integer, match, uuid } from './config.js';
import { httpClient } from './http.js';

export function runnerAccount(origin, key, { fetcher, notation = true } = {}) {
  match(key, /^[!-~]{32,512}$/, 'runner account key');
  const request = httpClient(httpsOrigin(origin, 'Runner account'), {
    headers: { authorization: `Bearer ${key}` },
    fetcher,
    notation,
  });
  return {
    offer: () => request('/v1/offer'),
    activate: (minutes, { maxCents, offer } = {}) =>
      request('/v1/activation', {
        method: 'PUT',
        body: {
          minutes: integer(minutes, 1, 60, 'activation minutes'),
          ...(maxCents === undefined
            ? {}
            : {
                maxCents: integer(
                  maxCents,
                  1,
                  Number.MAX_SAFE_INTEGER,
                  'activation spending limit'
                ),
              }),
          ...(offer?.profile
            ? {
                scope: offer.scope,
                label: offer.label,
                capacity: offer.capacity,
                rateCeiling: offer.rate,
                profile: offer.profile,
              }
            : {}),
        },
      }),
    stop: () => request('/v1/activation', { method: 'DELETE' }),
    checkout: (amount, requestId) =>
      request('/v1/checkout', {
        method: 'POST',
        extraHeaders: {
          'idempotency-key': match(requestId, uuid, 'checkout request ID'),
        },
        body: { amount: integer(amount, 500, 100000, 'top-up cents') },
      }),
  };
}
