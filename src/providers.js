import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { secret } from './config.js';
import { httpClient, HttpError } from './http.js';

function contabo(config, { env, fetcher }) {
  const { tokenPrefix } = config;
  const auth = httpClient('https://auth.contabo.com', { fetcher });
  let credentials;
  let expires = 0;
  async function api(path, options) {
    if (Date.now() >= expires) {
      credentials = await auth(
        '/auth/realms/contabo/protocol/openid-connect/token',
        {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'password',
            client_id: secret(`${tokenPrefix}_CLIENT_ID`, env),
            client_secret: secret(`${tokenPrefix}_CLIENT_SECRET`, env),
            username: secret(`${tokenPrefix}_USERNAME`, env),
            password: secret(`${tokenPrefix}_PASSWORD`, env),
          }).toString(),
          extraHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
        }
      );
      expires = Date.now() + Math.max(0, credentials.expires_in - 30) * 1000;
    }
    return httpClient('https://api.contabo.com', {
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        'x-request-id': randomUUID(),
      },
      fetcher,
    })(`/v1/compute/instances${path}`, options);
  }
  const normalize = (machine) => ({
    id: String(machine.instanceId),
    name: machine.displayName,
    ip: machine.ipConfig?.v4?.ip,
    status: machine.status,
    cancelDate: machine.cancelDate,
  });
  return {
    async list() {
      const records = [];
      for (let page = 1; page <= 100; page++) {
        const response = await api(`?size=100&page=${page}`);
        records.push(...response.data.map(normalize));
        if (page >= response._pagination.totalPages) {
          return records;
        }
      }
      throw new Error('Contabo pagination limit reached');
    },
    async create(name, userData, requestId) {
      const response = await api('', {
        method: 'POST',
        extraHeaders: { 'x-request-id': requestId },
        body: {
          displayName: name,
          region: config.region,
          productId: config.product,
          imageId: config.image,
          sshKeys: config.sshKeys.map(Number),
          defaultUser: 'root',
          userData,
          period: 1,
        },
      });
      return normalize(response.data[0]);
    },
    async retire(machine) {
      if (!machine.cancelDate) {
        await api(`/${machine.id}/cancel`, { method: 'POST' });
      }
      if (machine.status === 'running') {
        await api(`/${machine.id}/actions/stop`, { method: 'POST' });
      }
    },
  };
}

function hetzner(config, { env, fetcher }) {
  const api = httpClient('https://api.hetzner.cloud', {
    headers: {
      authorization: `Bearer ${secret(`${config.tokenPrefix}_TOKEN`, env)}`,
    },
    fetcher,
  });
  const normalize = (machine) => ({
    id: String(machine.id),
    name: machine.name,
    ip: machine.public_net?.ipv4?.ip,
    status: machine.status,
  });
  return {
    async list() {
      const records = [];
      let page = 1;
      while (page && page <= 100) {
        const response = await api(
          `/v1/servers?page=${page}&per_page=50&label_selector=managed-by%3Dhive-runners`
        );
        records.push(...response.servers.map(normalize));
        page = response.meta.pagination.next_page;
      }
      if (page) {
        throw new Error('Hetzner pagination limit reached');
      }
      return records;
    },
    async create(name, userData) {
      const response = await api('/v1/servers', {
        method: 'POST',
        body: {
          name,
          location: config.region,
          server_type: config.product,
          image: config.image,
          ssh_keys: config.sshKeys,
          user_data: userData,
          labels: { 'managed-by': 'hive-runners' },
        },
      });
      return normalize(response.server);
    },
    async retire({ id }) {
      try {
        await api(`/v1/servers/${id}`, { method: 'DELETE' });
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) {
          throw error;
        }
      }
    },
  };
}

export function providerClient(config, { env = process.env, fetcher } = {}) {
  return config.type === 'contabo'
    ? contabo(config, { env, fetcher })
    : hetzner(config, { env, fetcher });
}
