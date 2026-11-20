import { clearInterval, setInterval } from 'node:timers';
import { URL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  httpsOrigin,
  integer,
  requireValue,
  secret,
  validateConfig,
} from '../config.js';
import { fleet } from './fleet.js';
import { market, RequestError } from './market.js';
import { openStore } from './store.js';
import { stripePayments, verifyStripe } from './stripe.js';
import { digest, ledger, secureEqual } from './usage.js';
import { publicPage } from './web.js';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function authorize(config, env) {
  const names = Object.entries(config.accounts).map(([id, account]) => {
    const key = secret(account.keyEnv, env);
    requireValue(
      key.length >= 32,
      `Account key ${account.keyEnv} needs at least 32 characters`
    );
    return [id, hash(key)];
  });
  requireValue(
    new Set(names.map(([, key]) => key)).size === names.length,
    'Account keys must be unique'
  );
  return (header) => {
    const supplied = /^Bearer ([!-~]{32,512})$/.exec(header ?? '');
    const key = supplied && hash(supplied[1]);
    const match =
      key && names.find(([, candidate]) => secureEqual(key, candidate));
    if (!match) {
      throw new RequestError(401, 'Provide your runner account key');
    }
    return match[0];
  };
}

function githubSignatures(config, env) {
  const poolsBySecret = new Map();
  const paidPools = new Set(
    Object.values(config.accounts).map(({ pool }) => pool)
  );
  for (const [name, pool] of Object.entries(config.pools)) {
    const key = secret(pool.webhookSecretEnv, env);
    const names = poolsBySecret.get(key) ?? new Set();
    names.add(name);
    poolsBySecret.set(key, names);
  }
  for (const names of poolsBySecret.values()) {
    requireValue(
      names.size === 1 || ![...names].some((name) => paidPools.has(name)),
      'Each paid pool requires a unique GitHub webhook secret'
    );
  }
  return poolsBySecret;
}

function signedPools(keys, bytes, signature) {
  for (const [key, names] of keys) {
    if (secureEqual(signature, `sha256=${digest(key, bytes)}`)) {
      return names;
    }
  }
  throw new RequestError(401, 'Invalid webhook signature');
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 256 * 1024) {
      request.resume();
      throw new RequestError(413, 'Request exceeded 256 KiB');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parse(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RequestError(400, 'Malformed JSON');
  }
}

function json(response, data, status = 200) {
  response
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(data));
}

function wholesaleExpiration(input, offer) {
  if (
    typeof input.scope !== 'string' ||
    input.scope.toLowerCase() !== offer.scope.toLowerCase() ||
    input.label !== offer.label ||
    !Number.isSafeInteger(input.rateCeiling) ||
    input.rateCeiling < offer.rate
  ) {
    throw new RequestError(409, 'Wholesale offer changed');
  }
  return input.expires;
}

function authenticatedRoutes({ accountFor, commerce, payments, now }) {
  return async (request, response, path) => {
    const id = accountFor(request.headers.authorization);
    const method = request.method;
    if (path === '/v1/offer' && method === 'GET') {
      return json(response, commerce.offer(id));
    }
    if (path === '/v1/activation' || path === '/v1/wholesale') {
      const wholesale = path === '/v1/wholesale';
      if (method === 'DELETE') {
        return json(response, commerce.withdraw(id, wholesale));
      }
      if (method === 'PUT') {
        const input = parse(await body(request));
        const expires = wholesale
          ? wholesaleExpiration(input, commerce.offer(id))
          : now() + integer(input.minutes, 1, 60, 'activation minutes') * 60000;
        return json(response, commerce.activate(id, expires, wholesale));
      }
    }
    if (path === '/v1/checkout' && method === 'POST' && payments) {
      const input = parse(await body(request));
      return json(
        response,
        {
          url: await payments.checkout(
            id,
            request.headers['idempotency-key'],
            input.amount
          ),
        },
        201
      );
    }
    throw new RequestError(404, 'Route not found');
  };
}

function gated(expected, header) {
  if (header !== expected && !secureEqual(header, expected)) {
    throw new RequestError(401, 'Invalid webhook signature');
  }
}

function prometheus(workloads, scale, config, healthy) {
  const lines = [`hive_reconciler_healthy ${Number(healthy)}`];
  for (const [name, { queued, running }] of Object.entries(workloads)) {
    const machines = scale.poolMachines(name);
    for (const machine of machines) {
      const { availableMemoryMiB, load1, runners } = machine.metrics ?? {};
      if (Number.isFinite(availableMemoryMiB) && Number.isFinite(load1)) {
        const labels = `{pool="${name}",machine="${machine.name}"}`;
        lines.push(
          `hive_machine_available_memory_mib${labels} ${availableMemoryMiB}`
        );
        lines.push(`hive_machine_load1${labels} ${load1}`);
        lines.push(`hive_machine_runner_pods${labels} ${runners}`);
      }
    }
    const values = {
      queued_jobs: queued,
      running_jobs: running,
      managed_machines: machines.length,
      static_machines: config.pools[name].terraformMachines,
    };
    for (const [key, value] of Object.entries(values)) {
      lines.push(`hive_${key}{pool="${name}"} ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function controlPlane(
  input,
  {
    env = process.env,
    store = openStore(),
    fetcher,
    now = Date.now,
    scaling = {},
    logger = console,
  } = {}
) {
  const config = validateConfig(input);
  const accountFor = authorize(config, env);
  const usage = ledger(store, config, now);
  const githubKeys = githubSignatures(config, env);
  const stripeSecret =
    env.HIVE_STRIPE_SECRET_KEY && secret('HIVE_STRIPE_WEBHOOK_SECRET', env);
  const payments =
    stripeSecret &&
    stripePayments(store, usage, {
      token: env.HIVE_STRIPE_SECRET_KEY,
      origin: httpsOrigin(env.HIVE_PUBLIC_ORIGIN, 'Checkout'),
      fetcher,
    });
  let failed = false;
  let healthy = true;
  let progress;
  function report(name, error) {
    failed = true;
    logger.error(
      `Hive Runners reconciliation for ${name} failed. ${error.message}`
    );
  }
  const scale = fleet(store, config, { ...scaling, env, fetcher, now, report });
  scale.validateBindings();
  const commerce = market(store, config, usage, scale, { env, fetcher, now });
  const api = authenticatedRoutes({ accountFor, commerce, payments, now });

  async function route(request, response) {
    const { pathname: path } = new URL(request.url, 'http://localhost');
    if (request.method === 'GET') {
      if (path === '/healthz') {
        return json(response, { ready: true });
      }
      if (path === '/metrics' && env.HIVE_METRICS_KEY) {
        gated(`Bearer ${env.HIVE_METRICS_KEY}`, request.headers.authorization);
        return response
          .writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          })
          .end(prometheus(usage.workloads(), scale, config, healthy));
      }
      if (await publicPage(path, response)) {
        return;
      }
    }
    if (
      request.method === 'POST' &&
      path === '/webhooks/github' &&
      githubKeys.size > 0
    ) {
      const bytes = await body(request);
      const pools = signedPools(
        githubKeys,
        bytes,
        request.headers['x-hub-signature-256']
      );
      if (request.headers['x-github-event'] === 'workflow_job') {
        usage.ingest(parse(bytes), pools);
      }
      return json(response, { received: true }, 202);
    }
    if (request.method === 'POST' && path === '/webhooks/stripe' && payments) {
      const bytes = await body(request);
      if (
        !verifyStripe(
          bytes,
          request.headers['stripe-signature'],
          stripeSecret,
          now
        )
      ) {
        throw new RequestError(401, 'Invalid webhook signature');
      }
      payments.ingest(parse(bytes));
      return json(response, { received: true }, 202);
    }
    if (path.startsWith('/v1/')) {
      return api(request, response, path);
    }
    throw new RequestError(404, 'Route not found');
  }

  const server = createServer(
    { requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 8192 },
    (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader(
        'content-security-policy',
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
      );
      route(request, response).catch((error) => {
        const message =
          error instanceof RequestError
            ? error.message
            : 'Request could not be processed';
        if (!(error instanceof RequestError)) {
          logger.error('Hive Runners request failed', error.name);
        }
        if (!response.headersSent && !response.destroyed) {
          json(
            response,
            { error: message },
            error instanceof RequestError ? error.status : 422
          );
        }
      });
    }
  );
  server.maxConnections = 128;

  function reconcile() {
    if (!progress) {
      failed = false;
      progress = commerce
        .reconcile(report)
        .then((routing) => scale.reconcile(usage.workloads(), routing))
        .catch((error) => report('control plane', error))
        .finally(() => {
          healthy = !failed;
          progress = undefined;
        });
    }
    return progress;
  }
  return { server, reconcile, usage, commerce, scale, pending: () => progress };
}

export async function serve(
  config,
  {
    env = process.env,
    state = env.HIVE_STATE ?? './hive-state/runner.sqlite',
    port = Number(env.PORT ?? 8080),
    host = env.HOST ?? '127.0.0.1',
  } = {}
) {
  integer(port, 1, 65535, 'HTTP port');
  await mkdir(dirname(state), { mode: 0o700, recursive: true });
  const store = openStore(state);
  try {
    const plane = controlPlane(config, { env, store });
    await new Promise((ready, fail) => {
      plane.server.once('error', fail);
      plane.server.listen(port, host, ready);
    });
    const timer = setInterval(plane.reconcile, 30000);
    void plane.reconcile();
    async function stop() {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      clearInterval(timer);
      await new Promise((done) => plane.server.close(done));
      await plane.pending();
      store.close();
    }
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return plane.server;
  } catch (error) {
    store.close();
    throw error;
  }
}
