import { httpsOrigin, integer, match, uuid } from './config.js';
import { httpClient } from './http.js';

export function runnerAccount(origin, key, { fetcher } = {}) {
  match(key, /^[!-~]{32,512}$/, 'runner account key');
  const request = httpClient(httpsOrigin(origin, 'Runner account'), {
    headers: { authorization: `Bearer ${key}` },
    fetcher,
  });
  return {
    offer: () => request('/v1/offer'),
    activate: (minutes) =>
      request('/v1/activation', {
        method: 'PUT',
        body: { minutes: integer(minutes, 1, 60, 'activation minutes') },
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
