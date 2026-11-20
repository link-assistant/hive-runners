import { rejects } from 'node:assert/strict';
import { describe, it, expect } from 'test-anywhere';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  arcValues,
  cliReference,
  deploy,
  githubClient,
  propose,
  providerClient,
  renderInfrastructure,
  terraformPlan,
  validateConfig,
} from '@link-assistant/hive-runners';
import { runProcess } from '../src/process.js';
import { withWorkspace } from '../src/workspace.js';

describe('Hive Runners infrastructure', () => {
  it('renders both providers and preserves existing Terraform on reconfiguration', async () => {
    const original = JSON.parse(
      await readFile('examples/hive-runners/fleet.json', 'utf8')
    );
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
            expect(description).toContain('hive-managed/config.json');
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
