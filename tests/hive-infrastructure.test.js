import { rejects } from 'node:assert/strict';
import { describe, it, expect } from 'test-anywhere';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  arcValues,
  capacityPlan,
  cliReference,
  deploy,
  githubClient,
  githubToken,
  gitlabClient,
  gitlabValues,
  loadConfig,
  propose,
  providerClient,
  renderInfrastructure,
  runnerHost,
  terraformPlan,
  validateConfig,
} from '@link-assistant/hive-runners';
import { runProcess } from '../src/process.js';
import { withWorkspace } from '../src/workspace.js';

describe('Hive Runners infrastructure', () => {
  it('renders both providers and preserves existing Terraform on reconfiguration', async () => {
    const original = await loadConfig('examples/hive-runners/fleet.lino');
    const input = {
      ...original,
      accounts: {},
      pools: {
        ...original.pools,
        'paid-linux': { ...original.pools['paid-linux'], terraformMachines: 1 },
      },
    };
    const directory = await mkdtemp(join(tmpdir(), 'hive-infra-test-'));
    try {
      const central = join(directory, 'main.tf');
      await writeFile(central, '# existing configuration');
      const first = await renderInfrastructure(input, directory);
      const updated = await renderInfrastructure(input, directory);
      expect(first).toEqual(updated);
      expect(await readFile(central, 'utf8')).toBe('# existing configuration');
      const plan = terraformPlan(input);
      expect(plan.output.hive_inventory.value).toEqual({
        'example-paid-linux-tf1': {
          pool: 'paid-linux',
          ip: '${hcloud_server.example-paid-linux-tf1.ipv4_address}',
        },
        'example-private-builds-tf1': {
          pool: 'private-builds',
          ip: '${contabo_instance.example-private-builds-tf1.ip_config[0].v4[0].ip}',
        },
      });
      expect(
        Object.values(plan.variable).every((entry) => entry.sensitive)
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('assigns org hosts separate groups and generates safe default ARC values', async () => {
    const input = {
      version: 1,
      pools: {
        'org-build': {
          scope: 'my-org',
          selectedRepositories: ['one'],
          maxMachines: 2,
        },
      },
    };
    const operations = [];
    const count = await deploy(input, {
      inventory: {
        first: { pool: 'org-build', ip: '192.0.2.10' },
        second: { pool: 'org-build', ip: '192.0.2.11' },
      },
      host: async (pool, machine) =>
        operations.push(arcValues(pool, machine.group)),
    });
    expect(count).toBe(2);
    expect(operations.map(({ runnerGroup }) => runnerGroup)).toEqual([
      'first',
      'second',
    ]);
    expect(operations[0].runnerScaleSetName).toBe('org-build');
    expect(operations[0].template.spec.automountServiceAccountToken).toBe(
      false
    );
    expect(operations[0].minRunners).toBe(0);
    expect(operations[0].maxRunners).toBe(2);
  });

  it('keeps generated docs in sync and rejects multiple clusters for repo-only pools', async () => {
    expect(await readFile('docs/generated-cli.md', 'utf8')).toBe(
      cliReference()
    );
    expect(() =>
      validateConfig({
        version: 1,
        pools: { jobs: { scope: 'org/repo', maxMachines: 2 } },
      })
    ).toThrow();
  });

  it('proposes a managed configuration without changing the caller worktree', async () => {
    await withWorkspace(async ({ directory }) => {
      const upstream = join(directory, 'upstream.git');
      const cwd = join(directory, 'author');
      await runProcess('git', ['init', '--bare', upstream]);
      await runProcess('git', ['init', '-b', 'main', cwd]);
      const git = (args) => runProcess('git', args, { cwd });
      await git(['config', 'user.email', 'operator@example.com']);
      await git(['config', 'user.name', 'Hive Test Operator']);
      await git(['commit', '--allow-empty', '-m', 'Initial configuration']);
      await git(['remote', 'add', 'origin', upstream]);
      await git(['push', 'origin', 'main']);
      const branch = 'hive/test-proposal';
      const url = await propose(
        { version: 1, pools: { jobs: { scope: 'org/private-repo' } } },
        {
          cwd,
          branch,
          async run(program, args, options) {
            if (program === 'git') {
              return runProcess(program, args, options);
            }
            expect(program).toBe('gh');
            expect(args.slice(0, 3)).toEqual(['pr', 'create', '--draft']);
            const description = await readFile(args.at(-1), 'utf8');
            expect(description).toContain('org/private-repo');
            expect(description).toContain('hive-managed/config.lino');
            return 'https://example.com/pull/1';
          },
        }
      );
      expect(url).toBe('https://example.com/pull/1');
      expect(await git(['status', '--porcelain'])).toBe('');
      expect(
        await git(['ls-remote', 'origin', `refs/heads/${branch}`])
      ).toContain(`refs/heads/${branch}`);
    });
  });
});

const mixedConfig = {
  version: 1,
  pools: {
    cuda: {
      scope: 'org/repo',
      isolation: 'job',
      containerMode: 'kubernetes-novolume',
      capacity: 1,
      cpus: 3,
      memoryMiB: 4096,
      job: { cpuMillis: 1000, memoryMiB: 1536, diskMiB: 8192, gpus: 1 },
    },
    lint: {
      platform: 'gitlab',
      scope: 'team/private',
      gitlabRunnerId: 42,
      isolation: 'job',
      capacity: 1,
      cpus: 3,
      memoryMiB: 4096,
    },
  },
};

it('adds the host reserve once and requires isolation, enough hardware and one GPU scheduler', async () => {
  const hardware = {
    cpuMillis: 8000,
    memoryMiB: 12288,
    diskMiB: 65536,
    gpus: 1,
  };
  const inventory = {
    github: { pool: 'cuda', ip: '192.0.2.10', hardware },
    gitlab: { pool: 'lint', ip: '192.0.2.10', hardware },
  };
  const operations = [];
  const host = async (pool, target) =>
    operations.push([pool.profile, target.minimum]);
  expect(await deploy(mixedConfig, { inventory, host })).toBe(2);
  const combined = {
    cpuMillis: 7000,
    memoryMiB: 9216,
    diskMiB: 53248,
    gpus: 1,
  };
  expect(operations).toEqual([
    ['hive-cuda', combined],
    ['hive-lint', combined],
  ]);
  expect(capacityPlan(mixedConfig, ['cuda', 'lint']).minimum).toEqual(combined);
  expect(capacityPlan(mixedConfig).cuda.minimum.gpus).toBe(1);
  expect(capacityPlan(mixedConfig).cuda.recommended.diskMiB).toBe(204800);
  for (const target of Object.values(inventory)) {
    target.hardware = { ...hardware, cpuMillis: 6000 };
  }
  await rejects(
    deploy(mixedConfig, { inventory, host }),
    /combined pool minimum/
  );
  expect(operations.length).toBe(2);
  for (const target of Object.values(inventory)) {
    target.hardware = { ...hardware, gpus: 2 };
  }
  await rejects(
    deploy(
      {
        ...mixedConfig,
        pools: {
          ...mixedConfig.pools,
          lint: { ...mixedConfig.pools.lint, job: { gpus: 1 } },
        },
      },
      { inventory, host }
    ),
    /GPUs to one profile/
  );
  await rejects(
    deploy(
      {
        ...mixedConfig,
        pools: {
          ...mixedConfig.pools,
          lint: { ...mixedConfig.pools.lint, isolation: 'machine' },
        },
      },
      { inventory, host }
    ),
    /job isolation/
  );
});

it('authenticates an SSH GitLab GPU deployment and keeps the credential out of generated values', async () => {
  const pool = validateConfig({
    ...mixedConfig,
    pools: {
      lint: {
        ...mixedConfig.pools.lint,
        gitlabUrl: 'https://git.example.com:8443',
        gitlabEgressIPv4: ['10.0.0.2'],
        job: { gpus: 1 },
      },
    },
  }).pools.lint;
  const env = {
    HIVE_GITLAB_RUNNER_TOKEN: 'glrt-example',
    HIVE_GITLAB_TOKEN: 'gitlab-api-fixture',
  };
  const calls = [];
  let wrongRunner = false;
  const host = runnerHost({
    env,
    fetcher: async (url, request) => {
      calls.push(url.pathname);
      expect(url.origin).toBe('https://git.example.com:8443');
      if (
        url.pathname.endsWith('/verify') ||
        url.pathname.endsWith('/managers')
      ) {
        expect(JSON.parse(request.body).token).toBe(
          env.HIVE_GITLAB_RUNNER_TOKEN
        );
        expect(JSON.parse(request.body).system_id).toMatch(/^r_[a-f0-9]{12}$/);
        if (request.method === 'DELETE') {
          return new globalThis.Response(null, { status: 204 });
        }
        return globalThis.Response.json({ id: wrongRunner ? 43 : 42 });
      }
      expect(request.headers['private-token']).toBe(env.HIVE_GITLAB_TOKEN);
      return globalThis.Response.json(
        url.pathname === '/api/v4/runners/42'
          ? {
              runner_type: 'project_type',
              tag_list: ['lint'],
              paused: false,
              run_untagged: false,
              locked: true,
              projects: [{ id: 7 }],
            }
          : { id: 7, visibility: 'private' }
      );
    },
    async run(program, args, options) {
      expect(program).toBe('ansible-playbook');
      expect(args[2].endsWith('/gitlab.yml')).toBe(true);
      const variables = JSON.parse(
        await readFile(args.at(-1).slice(1), 'utf8')
      );
      expect(variables.hive_profile).toBe('hive-lint');
      expect(variables.hive_gitlab_egress).toEqual(['10.0.0.2']);
      expect(variables.hive_gitlab_port).toBe(8443);
      if (args[4] === 'deploy') {
        expect(options.env.HIVE_RUNNER_AUTH_JSON).toContain('glrt-example');
        expect(variables.hive_gitlab_values.replicas).toBe(0);
        expect(variables.hive_gitlab_values.runners.config).toContain(
          '"nvidia.com/gpu":"1"'
        );
        expect(variables.hive_gitlab_values.runners.config).toContain(
          '/automountServiceAccountToken'
        );
        expect(JSON.stringify(variables).includes('glrt-example')).toBe(false);
      }
      return '"HIVE_RUNNER_COUNT=0;512;0.1;8192"';
    },
  });
  const target = { ip: '192.0.2.10' };
  await host(pool, target, 'deploy-drained');
  expect(calls).toEqual([
    '/api/v4/projects/team%2Fprivate',
    '/api/v4/runners/42',
    '/api/v4/runners/verify',
    '/api/v4/runners/managers',
  ]);
  expect(await host(pool, target, 'drain')).toEqual({
    runners: 0,
    availableMemoryMiB: 512,
    availableDiskMiB: 8192,
    load1: 0.1,
  });
  expect(gitlabValues(pool).replicas).toBe(1);
  wrongRunner = true;
  await rejects(host(pool, target), /runner must be enabled/);
});

it('uses GitHub PAT and gh credentials, and creates a locked GitLab runner through its API', async () => {
  const run = async (name, args) => {
    expect(name).toBe('gh');
    expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    return 'fixture-gh\n';
  };
  expect(await githubToken({}, undefined, run)).toBe('fixture-gh');
  expect(await githubToken({ GH_TOKEN: 'fixture-pat' }, undefined, run)).toBe(
    'fixture-pat'
  );
  await rejects(
    githubToken({ GH_TOKEN: 'wrong-scope' }, 'CUSTOM_TOKEN', run),
    /Missing environment variable CUSTOM_TOKEN/
  );
  const gitlab = gitlabClient(
    'https://gitlab.com',
    'fixture',
    async (url, { body }) => {
      if (url.pathname === '/api/v4/user/runners') {
        expect(JSON.parse(body)).toEqual({
          runner_type: 'project_type',
          project_id: 7,
          description: 'Hive Runners lint',
          locked: true,
          tag_list: ['lint'],
          run_untagged: false,
        });
        return globalThis.Response.json({ id: 42, token: 'glrt-created' });
      }
      return globalThis.Response.json({ id: 7, visibility: 'private' });
    }
  );
  expect(await gitlab.createRunner('team/private', 'project', 'lint')).toEqual({
    id: 42,
    token: 'glrt-created',
  });
});

it('opts into container jobs with mode-specific credentials and rejects privileged paid runners', async () => {
  const scope = 'org/private-repo';
  const runnerImage = 'registry.example.com/actions/runner:custom';
  const provider = {
    type: 'hetzner',
    region: 'fsn1',
    product: 'cx23',
    image: 'ubuntu-24.04',
    sshKeys: ['admin'],
    monthlyCents: 649,
  };
  const input = { version: 1, providers: { local: provider } };
  const isolated = validateConfig({
    ...input,
    pools: {
      jobs: { scope, runnerImage, containerMode: 'kubernetes-novolume' },
    },
  });
  const kube = arcValues(isolated.pools.jobs);
  expect(kube.containerMode).toEqual({ type: 'kubernetes-novolume' });
  expect(kube.template.spec.automountServiceAccountToken).toBe(true);
  expect(kube.template.spec.containers[0].image).toBe(runnerImage);
  expect(kube.template.spec.containers[0].env[0].value).toBe(
    '/etc/hive-job-policy/pod.yaml'
  );

  const privileged = { scope, provider: 'local', containerMode: 'dind' };
  const trusted = validateConfig({ ...input, pools: { jobs: privileged } });
  const docker = arcValues(trusted.pools.jobs);
  expect(docker.containerMode).toEqual({ type: 'dind' });
  expect(docker.template.spec.automountServiceAccountToken).toBe(false);
  expect(() =>
    validateConfig({
      ...input,
      pools: { jobs: privileged },
      accounts: {
        customer: { pool: 'jobs', keyEnv: 'CUSTOMER_KEY', rate: 1 },
      },
    })
  ).toThrow();
});

describe('provider and GitHub API contracts', () => {
  const input = {
    type: 'contabo',
    region: 'EU',
    product: 'VPS',
    image: 'image-id',
    sshKeys: ['12345'],
    tokenPrefix: 'CONTABO',
  };

  it('exchanges Contabo credentials and uses the drift-safe cancellation endpoint', async () => {
    const requests = [];
    const env = Object.fromEntries(
      ['CLIENT_ID', 'CLIENT_SECRET', 'USERNAME', 'PASSWORD'].map((field) => [
        `CONTABO_${field}`,
        `fixture-${field}`,
      ])
    );
    const cloud = providerClient(input, {
      env,
      fetcher: async (url, options) => {
        requests.push([url.pathname, options]);
        if (url.hostname === 'auth.contabo.com') {
          return globalThis.Response.json({
            access_token: 'fixture',
            expires_in: 900,
          });
        }
        return globalThis.Response.json({
          data: [{ instanceId: 7, displayName: 'host', status: 'running' }],
        });
      },
    });
    const machine = await cloud.create('host', '#cloud-config', 'request-id');
    await cloud.retire(machine);
    expect(machine.id).toBe('7');
    expect(requests.length).toBe(4);
    expect(JSON.parse(requests[1][1].body).sshKeys).toEqual([12345]);
    expect(requests[2][0]).toBe('/v1/compute/instances/7/cancel');
    expect(requests[3][0]).toBe('/v1/compute/instances/7/actions/stop');
  });

  it('creates organization groups only for selected private repos', async () => {
    const writes = [];
    const gh = githubClient('fixture', async (url, options) => {
      if (options.method === 'POST') {
        writes.push(JSON.parse(options.body));
        return globalThis.Response.json({ id: 6 });
      }
      return globalThis.Response.json(
        url.pathname.startsWith('/repos')
          ? { private: !url.pathname.endsWith('/public'), id: 5 }
          : { runner_groups: [] }
      );
    });
    expect(await gh.ensureGroup('org', 'group', ['private'])).toEqual({
      id: 6,
    });
    await rejects(gh.ensureGroup('org', 'group', ['public']), /private/);
    expect(writes).toEqual([
      {
        name: 'group',
        visibility: 'selected',
        allows_public_repositories: false,
        selected_repository_ids: [5],
      },
    ]);
  });
});
