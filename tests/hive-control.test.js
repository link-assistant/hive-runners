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

describe('fleet and federation', () => {
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

  it('finds a compatible supplier and requests a fixed-expiry wholesale allocation', async () => {
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
          operations.push([url.pathname, args.body && JSON.parse(args.body)]);
          if (args.method === 'DELETE') {
            return globalThis.Response.json({ active: false, draining });
          }
          return globalThis.Response.json({
            available: true,
            currency: 'usd',
            rate: 7,
            scope: 'org/repo',
            label: 'jobs',
            capacity: 1,
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
        expect(operations).toEqual([
          ['/v1/offer', undefined],
          [
            '/v1/wholesale',
            {
              expires: epoch + 900000,
              rateCeiling: 8,
              scope: 'org/repo',
              label: 'jobs',
            },
          ],
          [
            '/v1/wholesale',
            {
              expires: epoch + 900000,
              rateCeiling: 8,
              scope: 'org/repo',
              label: 'jobs',
            },
          ],
        ]);
        await request('/v1/activation', { method: 'DELETE', headers: auth });
        await plane.reconcile();
        expect(operations.at(-1)).toEqual(['/v1/wholesale', undefined]);
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
