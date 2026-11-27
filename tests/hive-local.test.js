/* global Response */
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { describe, it } from 'test-anywhere';
import { admissionPolicy, selectWorkers } from '../src/local/admission.js';
import { startLocal, localStatus } from '../src/local/controller.js';
import { localConfig } from '../src/local/config.js';
import { providerFor } from '../src/local/provider.js';
import { nativeRunnerSpec } from '../src/local/native.js';
import {
  dockerWorkerArgs,
  kubeWorker,
  swarmWorkerArgs,
} from '../src/local/spec.js';

const now = 1000000;
const dimensions = ['cpu', 'memory', 'fs-build'];
const allocations = (value) =>
  Object.fromEntries(dimensions.map((key) => [key, value]));

function scope(id, basis = 'free', percentage = 49) {
  return {
    id,
    identity: id,
    resources: Object.fromEntries(
      dimensions.map((key) => [key, `${id}-${key}`])
    ),
    overhead: allocations(10),
    policy: admissionPolicy({ basis, percentage }),
  };
}

function data(target, available, usage, overrides = {}) {
  return {
    identity: target.identity,
    observedAt: now,
    resources: Object.fromEntries(
      Object.entries(target.resources).map(([key, identity]) => [
        key,
        { identity, total: 1000, available, usage },
      ])
    ),
    ...overrides,
  };
}

function job(id, nodes, weight, shared = []) {
  return {
    id,
    options: nodes.map((node) => ({
      node,
      claims: Object.fromEntries(
        [...shared, node].map((key) => [key, allocations(weight)])
      ),
    })),
  };
}

function admission(scopes, samples, jobs, leases = []) {
  return selectWorkers({ scopes, samples, jobs, leases, now, maxAgeMs: 1000 });
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'hive-local-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('local resource budgets', () => {
  it('selects multiple, one or zero at exact free and dedicated total boundaries', () => {
    const target = scope('node');
    const jobs = [job(1, ['node'], 240), job(2, ['node'], 240)];
    const count = (capacity, target) =>
      admission(
        [target],
        {
          node: data(target, capacity),
        },
        jobs
      ).selected.length;
    assert.equal(count(1000, target), 2);
    assert.equal(count(510, target), 0);
    assert.equal(count(511, target), 1);
    assert.equal(count(500, scope('node', 'free', 50)), 1);
    assert.equal(count(490, scope('node', 'total', 80)), 2);
    assert.equal(count(489, scope('node', 'total', 80)), 1);
    assert.throws(() => scope('node', 'total', 81));
  });

  it('returns capacity after invalid or busy metrics recover in every scope', () => {
    const host = scope('host');
    const node = scope('node');
    const jobs = [job(1, ['node'], 200, ['host'])];
    const healthy = data(node, 1000);
    for (const failed of [
      undefined,
      data(node, 1000, undefined, { observedAt: now - 1001 }),
      data(node, 1000, undefined, { observedAt: now + 1 }),
      data(node, 1000, undefined, { identity: 'another VM' }),
      ...dimensions.map((dimension) => {
        const sample = data(node, 1000);
        sample.resources[dimension].available = 409;
        return sample;
      }),
      {
        ...healthy,
        resources: {
          ...healthy.resources,
          'fs-build': { ...healthy.resources['fs-build'], identity: 'moved' },
        },
      },
    ]) {
      assert.equal(
        admission([host, node], { host: data(host, 1000), node: failed }, jobs)
          .selected.length,
        0
      );
    }
    assert.equal(
      admission([host, node], { host: data(host, 1000), node: healthy }, jobs)
        .selected.length,
      1
    );
  });

  it('counts only measured active usage as occupied and caps committed reservations', () => {
    const target = scope('node', 'free', 50);
    const lease = { id: 'active', claims: { node: allocations(200) } };
    const jobs = [job(1, ['node'], 190), job(2, ['node'], 100)];
    const admitted = admission(
      [target],
      { node: data(target, 600, { active: 200 }) },
      jobs,
      [lease]
    );
    assert.deepEqual(
      admitted.selected.map(({ job }) => job),
      [1]
    );
    assert.equal(
      admission([target], { node: data(target, 600, { active: 201 }) }, jobs, [
        lease,
      ]).selected.length,
      0
    );
    assert.deepEqual(
      admission([target], { node: data(target, 600) }, jobs, [lease]).selected,
      []
    );
  });

  it('balances two placements across measured nodes while charging a shared physical host', () => {
    const scopes = ['host', 'a', 'b'].map((id) => scope(id, 'total', 80));
    const samples = Object.fromEntries(
      scopes.map((entry) => [
        entry.id,
        data(entry, entry.id === 'b' ? 300 : 900),
      ])
    );
    const jobs = [1, 2, 3, 4].map((id) => job(id, ['a', 'b'], 250, ['host']));
    assert.deepEqual(
      admission(scopes, samples, jobs).selected.map(({ node }) => node),
      ['a', 'a', 'b']
    );
  });
});

async function fixture(directory) {
  const config = JSON.parse(
    await readFile(
      new URL(
        '../examples/hive-runners/local/config.example.json',
        import.meta.url
      )
    )
  );
  config.controllerStorage = directory;
  config.pools['local-builds'].tokenFile = join(directory, 'token');
  return config;
}

function sampleFromConfig(config, id, available = 10000) {
  const target = config.scopes[id];
  return {
    identity: target.identity,
    observedAt: now,
    resources: Object.fromEntries(
      Object.entries(target.resources).map(([key, identity]) => [
        key,
        { identity, total: 10000, available },
      ])
    ),
  };
}

describe('local worker lifecycle', () => {
  it('launches two reserved workers, preserves running work across restart and drains under pressure', () =>
    temporary(async (directory) => {
      const config = await fixture(directory);
      const workers = new Map();
      const registrations = [];
      const cleaned = [];
      let available = 1000;
      const state = join(directory, 'state');
      const monitor = () =>
        Promise.resolve(sampleFromConfig(config, 'workstation'));
      const opts = {
        once: true,
        now: () => now,
        monitor,
        backendFactory: () => ({
          inspect: () => Promise.resolve({}),
          ready: () => Promise.resolve(),
          sample: () =>
            Promise.resolve(sampleFromConfig(config, 'engine', available)),
          list: () => Promise.resolve([...workers.values()]),
          launch: (_pool, lease, ticket) => {
            assert.equal(ticket, 'A-valid-ticket');
            workers.set(lease.id, { id: lease.id, state: 'live' });
            return Promise.resolve();
          },
          remove: (lease) => Promise.resolve(workers.delete(lease.id)),
        }),
        providerFactory: () =>
          Promise.resolve({
            queued: () => Promise.resolve(['job1', 'job2', 'job3']),
            register: (lease) => {
              registrations.push(lease);
              return Promise.resolve('A-valid-ticket');
            },
            cleanup: (lease) => Promise.resolve(cleaned.push(lease.id)),
          }),
      };
      assert.equal((await startLocal(config, state, opts)).active, 0);
      available = 10000;
      assert.equal((await startLocal(config, state, opts)).active, 2);
      assert.equal((await startLocal(config, state, opts)).active, 2);
      assert.equal(registrations.length, 2);
      assert.equal((await localStatus(state, 'draining')).desired, 'draining');
      available = 100;
      await startLocal(config, state, opts);
      assert.equal(workers.size, 2);
      workers.get(registrations[0].id).state = 'terminal';
      assert.equal((await startLocal(config, state, opts)).active, 1);
      assert.equal(cleaned.length, 1);
      await localStatus(state, 'stopped');
      workers.get(registrations[1].id).state = 'terminal';
      assert.deepEqual(await startLocal(config, state, opts), {
        mode: 'stopped',
        active: 0,
        errors: {},
      });
      assert.equal(registrations.length, 2);
      assert.ok(
        !(await readFile(join(state, 'controller.json'), 'utf8')).includes(
          'A-valid-ticket'
        )
      );
    }));

  it('rejects invalid OS and architecture before contacting a runtime', () =>
    temporary(async (directory) => {
      const config = await fixture(directory);
      config.nodes['local-engine'].backend = 'windows-container';
      assert.throws(() => localConfig(config), /Unsupported worker backend/);
      config.nodes['local-engine'].backend = 'docker';
      config.nodes['local-engine'].os = 'windows';
      assert.throws(() => localConfig(config), /Linux containers/);
      config.nodes['local-engine'].os = 'linux';
      config.nodes['second-engine'] = {
        ...config.nodes['local-engine'],
        arch: 'arm64',
      };
      config.pools['local-builds'].nodes.push('second-engine');
      assert.throws(
        () => localConfig(config),
        /one worker OS and architecture/
      );
    }));

  it('refreshes credentials and requests only a repository-scoped GitHub JIT configuration', () =>
    temporary(async (directory) => {
      const config = localConfig(await fixture(directory));
      const pool = config.pools['local-builds'];
      await writeFile(pool.tokenFile, 'first-shape', { mode: 0o600 });
      const observed = [];
      const fetcher = (path, options) => {
        observed.push([path.pathname, options.headers.authorization]);
        if (path.pathname.endsWith('generate-jitconfig')) {
          assert.deepEqual(JSON.parse(options.body).labels, [
            'hive-local-amd64',
          ]);
          return Response.json({ encoded_jit_config: 'ticket' });
        }
        if (path.pathname.endsWith('/actions/runs')) {
          return Response.json({ workflow_runs: [{ id: 42 }] });
        }
        if (path.pathname.endsWith('/jobs')) {
          return Response.json({
            jobs: [
              { id: 3, status: 'queued', labels: ['hive-local-amd64'] },
              { id: 4, status: 'queued', labels: ['general'] },
              { id: 5, status: 'running', labels: ['hive-local-amd64'] },
            ],
          });
        }
        return Response.json({ private: true });
      };
      assert.deepEqual(await (await providerFor(pool, { fetcher })).queued(), [
        '3',
      ]);
      await writeFile(join(directory, 'new'), 'rotated-shape', { mode: 0o600 });
      await rename(join(directory, 'new'), pool.tokenFile);
      assert.equal(
        await (await providerFor(pool, { fetcher })).register({ id: 'lease' }),
        'ticket'
      );
      assert.deepEqual(observed.at(-1), [
        '/repos/organization/private-repository/actions/runners/generate-jitconfig',
        'Bearer rotated-shape',
      ]);
    }));
});

describe('local runtime specifications', () => {
  it('uses the same resource envelope for Docker, Swarm and a node-pinned Kubernetes pod', () => {
    const pool = {
      platform: 'github',
      origin: 'https://github.com',
      image: 'test-image',
      limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 1024 },
    };
    const node = {
      arch: 'arm64',
      identity: 'node-id',
      target: 'physical-node',
    };
    const lease = { id: 'lease' };
    const docker = dockerWorkerArgs(node, pool, lease, 'controller');
    assert.ok(
      docker.includes('--read-only') &&
        docker.includes('--memory-swap') &&
        docker.includes('linux/arm64')
    );
    const swarm = swarmWorkerArgs(node, pool, lease, 'controller');
    assert.ok(
      swarm.includes('node.id==node-id') &&
        swarm.includes('--limit-memory') &&
        swarm.includes('--read-only')
    );
    const { spec } = kubeWorker(node, pool, lease, 'controller');
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.restartPolicy, 'Never');
    assert.equal(spec.containers[0].resources.limits.memory, '1552Mi');
    assert.equal(spec.volumes[0].emptyDir.sizeLimit, '1024Mi');
    assert.equal(spec.nodeSelector['kubernetes.io/arch'], 'arm64');
    assert.deepEqual(
      spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
        .nodeSelectorTerms[0].matchFields[0].values,
      ['physical-node']
    );
  });
});

describe('native worker guest launcher', () => {
  it('routes a single provider job only on a contained macOS or Windows guest', () =>
    temporary(async (directory) => {
      const config = {
        workspace: directory,
        runner: join(directory, 'runner'),
      };
      const github = {
        platform: 'github',
        origin: 'https://github.com',
        ticket: 'jit-config',
      };
      assert.deepEqual(nativeRunnerSpec(config, github, 'darwin').args, [
        'run',
        '--jitconfig',
        'jit-config',
      ]);
      assert.throws(
        () => nativeRunnerSpec(config, github, 'linux'),
        /macOS or Windows/
      );
      const gitlab = nativeRunnerSpec(
        config,
        { ...github, platform: 'gitlab', origin: 'https://gitlab.com' },
        'win32'
      );
      assert.deepEqual(gitlab.args.slice(-6), [
        '--max-builds',
        '1',
        '--wait-timeout',
        '60',
        '--shell',
        'powershell',
      ]);
    }));
});
