import { URL } from 'node:url';
export class HttpError extends Error {
  constructor(status, service) {
    super(`${service} returned HTTP ${status}`);
    this.status = status;
  }
}

export function httpClient(
  origin,
  { headers = {}, fetcher = fetch, service = new URL(origin).hostname } = {}
) {
  return async (path, { method = 'GET', body, extraHeaders = {} } = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error('Expected an API path');
    }
    const url = new URL(path, origin);
    if (url.origin !== origin) {
      throw new Error('API path crossed the configured origin');
    }
    const response = await fetcher(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
        ...extraHeaders,
      },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, service);
    }
    return response.status === 204 ? null : response.json();
  };
}
