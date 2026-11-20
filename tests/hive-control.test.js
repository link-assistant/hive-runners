import { URLSearchParams } from 'node:url';
import { describe, it, expect } from 'test-anywhere';
import { once } from 'node:events';
import { controlPlane } from '../src/control/server.js';
import { openStore } from '../src/control/store.js';
import { digest } from '../src/control/usage.js';

const webhookSecret = 'fixture-webhook';
const key = 'x'.repeat(48);
const epoch = Date.parse('2026-04-20T15:00:00.000Z');
const options = {
  env: {
    CUSTOMER_KEY: key,
    HIVE_WEBHOOK_SECRET: webhookSecret,
    HIVE_METRICS_KEY: 'metrics-fixture',
  },
  now: () => epoch,
  logger: { error() {} },
};
const provider = {
  type: 'hetzner',
  region: 'fsn1',
  product: 'cx23',
  image: 'ubuntu-24.04',
  sshKeys: ['admin'],
  monthlyCents: 649,
};
const config = {
  version: 1,
  providers: { low: provider },
  pools: {
    jobs: { scope: 'org/repo', provider: 'low', capacity: 1, idleSeconds: 60 },
  },
  accounts: {
    customer: {
      pool: 'jobs',
      keyEnv: 'CUSTOMER_KEY',
      rate: 10,
      initialCredit: 100,
    },
  },
};

function event(action, id = 17) {
  return {
    action,
    repository: { full_name: 'org/repo', private: true },
    workflow_job: {
      id,
      labels: ['jobs'],
      runner_name: 'jobs-dp8m9-runner-9a8mk',
      started_at: new Date(epoch - 61000).toISOString(),
      completed_at: new Date(epoch).toISOString(),
    },
  };
}

function githubRequest(payload, signature) {
  const body = JSON.stringify(payload);
  return {
    method: 'POST',
    headers: {
      'x-github-event': 'workflow_job',
      'x-hub-signature-256':
        signature ?? `sha256=${digest(webhookSecret, body)}`,
    },
    body,
  };
}

function signedEvent(payload, secret) {
  return githubRequest(
    payload,
    `sha256=${digest(secret, JSON.stringify(payload))}`
  );
}

async function withHttp(input, setup, test) {
  const store = openStore();
  const plane = controlPlane(input, { ...options, ...setup, store });
  try {
    plane.server.listen(0, '127.0.0.1');
    await once(plane.server, 'listening');
    await test(plane, (path, args) =>
      fetch(`http://127.0.0.1:${plane.server.address().port}${path}`, args)
    );
  } finally {
    await new Promise((resolve) => plane.server.close(resolve));
    store.close();
  }
}

const auth = { authorization: `Bearer ${key}` };

describe('control plane and usage', () => {
  it('serves the landing page and rejects missing keys or forged usage', async () => {
    await withHttp(config, {}, async (plane, request) => {
      expect((await request('/')).status).toBe(200);
      expect((await request('/guide.html')).status).toBe(200);
      expect(await (await request('/docs/generated-cli.md')).text()).toContain(
        'Hive Runners CLI reference'
      );
      expect((await request('/v1/offer')).status).toBe(401);
      expect(
        (
          await request(
            '/webhooks/github',
            githubRequest(event('completed'), 'wrong')
          )
        ).status
      ).toBe(401);
      expect(
        (await request('/webhooks/github', githubRequest(event('completed'))))
          .status
      ).toBe(202);
      expect(
        (await request('/webhooks/github', githubRequest(event('queued'))))
          .status
      ).toBe(202);
      await request('/webhooks/github', githubRequest(event('completed')));
      const offer = await (
        await request('/v1/offer', { headers: auth })
      ).json();
      expect(offer.credit).toBe(80);
      expect(plane.usage.workloads().jobs).toEqual({ queued: 0, running: 0 });
      expect((await request('/metrics')).status).toBe(401);
      expect(
        (
          await request('/metrics', {
            headers: { authorization: 'Bearer metrics-fixture' },
          })
        ).status
      ).toBe(200);
    });
  });

  it('limits signed job events to pools with the matching webhook secret', async () => {
    const otherSecret = 'other-webhook-secret';
    const inputs = {
      ...config,
      pools: {
        ...config.pools,
        other: {
          ...config.pools.jobs,
          scope: 'org/other',
          webhookSecretEnv: 'OTHER_WEBHOOK_SECRET',
        },
      },
      accounts: {
        ...config.accounts,
        other: {
          ...config.accounts.customer,
          pool: 'other',
          keyEnv: 'OTHER_KEY',
        },
      },
    };
    const env = {
      ...options.env,
      OTHER_KEY: 'y'.repeat(48),
      OTHER_WEBHOOK_SECRET: otherSecret,
    };
    await withHttp(inputs, { env }, async (plane, request) => {
      const forged = signedEvent(event('completed'), otherSecret);
      expect((await request('/webhooks/github', forged)).status).toBe(202);
      expect(plane.usage.credit('customer')).toBe(100);
      const ownEvent = event('completed');
      ownEvent.repository.full_name = 'org/other';
      ownEvent.workflow_job.labels = ['other'];
      ownEvent.workflow_job.runner_name = 'other-dp8m9-runner-fixture';
      await request('/webhooks/github', signedEvent(ownEvent, otherSecret));
      expect(plane.usage.credit('other')).toBe(80);
      await request('/webhooks/github', githubRequest(event('completed')));
      expect(plane.usage.credit('customer')).toBe(80);
    });
    const store = openStore();
    try {
      expect(() =>
        controlPlane(inputs, {
          ...options,
          store,
          env: { ...env, OTHER_WEBHOOK_SECRET: webhookSecret },
        })
      ).toThrow('Each paid pool requires a unique GitHub webhook secret');
    } finally {
      store.close();
    }
  });
});

describe('Stripe payments', () => {
  it('settles Stripe credit only once and handles refunds before fulfillment', async () => {
    const env = {
      ...options.env,
      HIVE_STRIPE_SECRET_KEY: 'fixture-payment-key',
      HIVE_STRIPE_WEBHOOK_SECRET: 'payment-hook-fixture',
      HIVE_PUBLIC_ORIGIN: 'https://example.com',
    };
    const id = 'a993d884-fe5a-4b8c-acd7-db48bcff368a';
    let order;
    await withHttp(
      config,
      {
        env,
        fetcher: async (url, request) => {
          expect(url.hostname).toBe('api.stripe.com');
          order = new URLSearchParams(request.body).get('metadata[hive_order]');
          return globalThis.Response.json({
            url: 'https://checkout.stripe.com/c/pay/fixture',
          });
        },
      },
      async (plane, request) => {
        const checkout = await request('/v1/checkout', {
          method: 'POST',
          headers: { ...auth, 'idempotency-key': id },
          body: JSON.stringify({ amount: 500 }),
        });
        expect(checkout.status).toBe(201);
        expect(plane.usage.credit('customer')).toBe(100);
        async function post(type, object, timestamp = epoch / 1000) {
          const body = JSON.stringify({ type, data: { object } });
          return request('/webhooks/stripe', {
            method: 'POST',
            body,
            headers: {
              'stripe-signature': `t=${timestamp},v1=${digest(env.HIVE_STRIPE_WEBHOOK_SECRET, String(timestamp), '.', body)}`,
            },
          });
        }
        await post('charge.refunded', {
          payment_intent: 'pi_fixture',
          amount_refunded: 140,
        });
        const paid = {
          payment_intent: 'pi_fixture',
          currency: 'usd',
          payment_status: 'paid',
          amount_total: 500,
          metadata: { hive_order: order },
        };
        expect((await post('checkout.session.completed', paid, 1)).status).toBe(
          401
        );
        expect((await post('checkout.session.completed', paid)).status).toBe(
          202
        );
        await post('checkout.session.completed', paid);
        expect(plane.usage.credit('customer')).toBe(460);
        await post('charge.refunded', {
          payment_intent: 'pi_fixture',
          amount_refunded: 500,
        });
        expect(plane.usage.credit('customer')).toBe(100);
      }
    );
  });
});

describe('fleet reconciliation', () => {
  it('activates, provisions, drains across two observations and retires a machine', async () => {
    let time = epoch;
    let runners = 1;
    let remote;
    const operations = [];
    await withHttp(
      config,
      {
        now: () => time,
        scaling: {
          keys: async () => ({
            knownKey: 'ssh-ed25519 fixture',
            userData: '#cloud-config',
          }),
          provider: () => ({
            list: async () => (remote ? [remote] : []),
            create: async (name) => {
              operations.push('create');
              remote = { id: '42', name, ip: '192.0.2.10' };
              return remote;
            },
            retire: async () => {
              operations.push('retire');
              remote = null;
            },
          }),
          host: async (_pool, target, action = 'deploy') => {
            expect(target.knownHosts).toBe('192.0.2.10 ssh-ed25519 fixture\n');
            operations.push(action);
            return { runners, availableMemoryMiB: 512, load1: 0.66 };
          },
        },
      },
      async (plane, request) => {
        const activation = await request('/v1/activation', {
          method: 'PUT',
          headers: auth,
          body: '{"minutes":15}',
        });
        expect(activation.status).toBe(200);
        await request('/webhooks/github', githubRequest(event('queued')));
        await plane.reconcile();
        await plane.reconcile();
        expect(operations).toEqual(['create', 'deploy', 'inspect']);
        await request('/v1/activation', { method: 'DELETE', headers: auth });
        await plane.reconcile();
        expect(operations.at(-1)).toBe('drain');
        time += 61000;
        runners = 0;
        await plane.reconcile();
        expect(operations).not.toContain('retire');
        time += 61000;
        await plane.reconcile();
        expect(operations.at(-1)).toBe('retire');
        await plane.reconcile();
        expect(plane.scale.poolMachines('jobs')).toEqual([]);
      }
    );
  });
});

describe('upstream federation', () => {
  it('tries compatible suppliers in price order and pins the accepted allocation', async () => {
    const hub = {
      ...config,
      providers: {},
      pools: { jobs: { scope: 'org/repo', capacity: 1 } },
      accounts: {
        customer: {
          ...config.accounts.customer,
          upstreams: [
            {
              origin: 'https://supplier.example.com',
              keyEnv: 'UPSTREAM_KEY',
              maxRate: 8,
            },
            {
              origin: 'https://lower-price.example.com',
              keyEnv: 'UPSTREAM_KEY',
              maxRate: 8,
            },
          ],
        },
      },
    };
    const operations = [];
    let draining = true;
    await withHttp(
      hub,
      {
        env: { ...options.env, UPSTREAM_KEY: 'supplier-credential-fixture' },
        fetcher: async (url, args) => {
          const cheaper = url.hostname === 'lower-price.example.com';
          operations.push([
            `${url.hostname}${url.pathname}`,
            args.body && JSON.parse(args.body),
          ]);
          if (cheaper && args.method === 'PUT') {
            return globalThis.Response.json({}, { status: 409 });
          }
          if (args.method === 'DELETE') {
            return globalThis.Response.json({ active: false, draining });
          }
          return globalThis.Response.json({
            available: true,
            currency: 'usd',
            rate: cheaper ? 6 : 7,
            scope: 'org/repo',
            label: 'jobs',
            capacity: 1,
            activation: null,
            draining: false,
          });
        },
      },
      async (plane, request) => {
        const lease = await request('/v1/activation', {
          method: 'PUT',
          headers: auth,
          body: '{"minutes":15}',
        });
        expect((await lease.json()).route).toBe('upstream');
        await plane.reconcile();
        await plane.reconcile();
        const allocation = {
          expires: epoch + 900000,
          rateCeiling: 8,
          scope: 'org/repo',
          label: 'jobs',
        };
        expect(operations).toEqual([
          ['supplier.example.com/v1/offer', undefined],
          ['lower-price.example.com/v1/offer', undefined],
          ['lower-price.example.com/v1/wholesale', allocation],
          ['lower-price.example.com/v1/offer', undefined],
          ['supplier.example.com/v1/wholesale', allocation],
          ['supplier.example.com/v1/wholesale', allocation],
        ]);
        await request('/v1/activation', { method: 'DELETE', headers: auth });
        await plane.reconcile();
        expect(operations.at(-1)).toEqual([
          'supplier.example.com/v1/wholesale',
          undefined,
        ]);
        const activate = () =>
          request('/v1/activation', {
            method: 'PUT',
            headers: auth,
            body: '{"minutes":15}',
          });
        expect((await activate()).status).toBe(409);
        draining = false;
        await plane.reconcile();
        expect((await activate()).status).toBe(200);
      }
    );
  });
});

describe('spare machine sales', () => {
  it('deploys on contributed hardware only for paid demand and parks after drain', async () => {
    const hostKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`;
    const spareHost = { ip: '192.0.2.11', hostKey, user: 'operator' };
    const reseller = {
      ...config,
      providers: {},
      pools: {
        jobs: { scope: 'org/repo', capacity: 1, spareHost },
      },
    };
    let time = epoch;
    const operations = [];
    await withHttp(
      reseller,
      {
        now: () => time,
        scaling: {
          host: async (_pool, target, operation = 'deploy') => {
            expect(target.knownHosts).toBe(`${spareHost.ip} ${hostKey}\n`);
            operations.push(operation);
            return { runners: 0, availableMemoryMiB: 5120, load1: 0.1 };
          },
        },
      },
      async (plane, request) => {
        await request('/webhooks/github', githubRequest(event('queued')));
        await plane.reconcile();
        expect(operations).toEqual([]);
        const lease = await request('/v1/activation', {
          method: 'PUT',
          headers: auth,
          body: '{"minutes":15}',
        });
        expect(lease.status).toBe(200);
        await plane.reconcile();
        expect(operations).toEqual(['deploy', 'inspect']);
        await request('/v1/activation', { method: 'DELETE', headers: auth });
        await plane.reconcile();
        time += 61000;
        await plane.reconcile();
        expect(operations).toEqual(['deploy', 'inspect', 'drain', 'inspect']);
        await plane.reconcile();
        expect(operations.at(-1)).toBe('park');
        expect(plane.scale.poolMachines('jobs')).toEqual([]);
      }
    );
  });
});

it('connects two control planes and meters the same job at retail and wholesale rates', async () => {
  const pool = { scope: 'org/repo', capacity: 1 };
  const account = config.accounts.customer;
  const supplierKey = 's'.repeat(48);
  const supplierSecret = 'supplier-webhook-fixture';
  const spareHost = {
    ip: '192.0.2.11',
    hostKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`,
  };
  const supplier = {
    version: 1,
    pools: { jobs: { ...pool, spareHost } },
    accounts: { customer: { ...account, rate: 4 } },
  };
  const hub = {
    version: 1,
    pools: { jobs: pool },
    accounts: {
      customer: {
        ...account,
        upstreams: [
          {
            origin: 'https://supplier.example.com',
            keyEnv: 'SUPPLIER_KEY',
            maxRate: 5,
          },
        ],
      },
    },
  };
  const operations = [];
  await withHttp(
    supplier,
    {
      env: {
        ...options.env,
        CUSTOMER_KEY: supplierKey,
        HIVE_WEBHOOK_SECRET: supplierSecret,
      },
      scaling: {
        host: async (_pool, _target, operation = 'deploy') => {
          operations.push(operation);
          return { runners: 0 };
        },
      },
    },
    async (reseller, supplierRequest) => {
      await withHttp(
        hub,
        {
          env: { ...options.env, SUPPLIER_KEY: supplierKey },
          fetcher: (url, args) => supplierRequest(url.pathname, args),
        },
        async (retail, hubRequest) => {
          const activation = await hubRequest('/v1/activation', {
            method: 'PUT',
            headers: auth,
            body: '{"minutes":15}',
          });
          expect((await activation.json()).route).toBe('upstream');
          await retail.reconcile();
          for (const action of ['queued', 'completed', 'completed']) {
            const job = event(action);
            expect(
              (await hubRequest('/webhooks/github', githubRequest(job))).status
            ).toBe(202);
            expect(
              (
                await supplierRequest(
                  '/webhooks/github',
                  signedEvent(job, supplierSecret)
                )
              ).status
            ).toBe(202);
            await reseller.reconcile();
          }
          expect(operations).toContain('deploy');
          expect(retail.scale.poolMachines('jobs')).toEqual([]);
          expect(retail.usage.credit('customer')).toBe(80);
          expect(reseller.usage.credit('customer')).toBe(92);
          await hubRequest('/v1/activation', {
            method: 'DELETE',
            headers: auth,
          });
          await retail.reconcile();
          await reseller.reconcile();
          expect(operations).toContain('drain');
        }
      );
    }
  );
});
