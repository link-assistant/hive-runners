import { URL } from 'node:url';
import { formatNotation, linoMediaType, parseNotation } from './notation.js';
export class HttpError extends Error {
  constructor(status, service) {
    super(`${service} returned HTTP ${status}`);
    this.status = status;
  }
}

export function httpClient(
  origin,
  {
    headers = {},
    fetcher = fetch,
    service = new URL(origin).hostname,
    notation = false,
    signal,
  } = {}
) {
  const contentType = notation ? linoMediaType : 'application/json';
  const accept = notation
    ? `${linoMediaType}, application/json;q=0.9`
    : contentType;
  const encode = notation ? formatNotation : JSON.stringify;
  function encodeBody(value) {
    return value === undefined || typeof value === 'string'
      ? value
      : encode(value);
  }
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
        accept,
        ...(body === undefined ? {} : { 'content-type': contentType }),
        ...headers,
        ...extraHeaders,
      },
      body: encodeBody(body),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, service);
    }
    if (response.status === 204) {
      return null;
    }
    if (
      notation &&
      response.headers.get('content-type')?.split(';')[0] === linoMediaType
    ) {
      return parseNotation(await response.text());
    }
    return response.json();
  };
}
