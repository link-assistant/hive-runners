import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath, URL } from 'node:url';
import { arcCredentials, match, requireValue, secret } from './config.js';
import { githubClient } from './github.js';
import { runProcess } from './process.js';
import { withWorkspace } from './workspace.js';

export const playbook = fileURLToPath(
  new URL('./assets/ansible/arc.yml', import.meta.url)
);

export function arcValues(pool, group, drained = false) {
  return {
    githubConfigUrl: `https://github.com/${pool.scope}`,
    githubConfigSecret: 'hive-arc-auth',
    runnerScaleSetName: pool.label,
    ...(group ? { runnerGroup: group } : {}),
    minRunners: drained ? 0 : pool.warmRunners,
    maxRunners: drained ? 0 : pool.capacity,
    controllerServiceAccount: {
      namespace: 'hive-system',
      name: 'hive-arc-gha-rs-controller',
    },
    template: {
      metadata: { labels: { 'hive-runners.net/workload': 'runner' } },
      spec: {
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1001,
          runAsGroup: 1001,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'runner',
            image: 'ghcr.io/actions/actions-runner:latest',
            command: ['/home/runner/run.sh'],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
            resources: {
              requests: {
                cpu: `${Math.floor(((pool.cpus - 1) * 1000) / pool.capacity)}m`,
                memory: `${Math.floor((pool.memoryMiB - 1024) / pool.capacity)}Mi`,
              },
            },
          },
        ],
      },
    },
  };
}

function processEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      /^(PATH|HOME|LANG|LC_.*|TMPDIR|USER|SSH_AUTH_SOCK|SSL_CERT_.*|SYSTEMROOT|WINDIR)$/i.test(
        key
      )
    )
  );
}

export function arcHost({ run = runProcess, env = process.env, fetcher } = {}) {
  async function prepareGithub(pool, group) {
    const client = githubClient(secret(pool.groupTokenEnv, env), fetcher);
    if (group) {
      await client.ensureGroup(pool.scope, group, pool.selectedRepositories);
    } else {
      await client.requirePrivateRepo(pool.scope);
    }
  }

  return async (
    pool,
    { ip, group, user = 'root', knownHosts },
    operation = 'deploy'
  ) => {
    requireValue(
      isIP(ip) || /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(ip),
      'Invalid SSH host'
    );
    match(user, /^[a-z_][a-z0-9_-]{0,31}$/, 'SSH user');
    requireValue(
      ['deploy', 'deploy-drained', 'drain', 'inspect', 'park'].includes(
        operation
      ),
      'Invalid ARC operation'
    );
    requireValue(
      pool.scope.includes('/') || group,
      'Organization deployments require a distinct runner group'
    );
    const deploying = operation.startsWith('deploy');
    const credentials = deploying
      ? arcCredentials(pool.credentialsEnv, env)
      : {};
    if (deploying) {
      await prepareGithub(pool, group);
    }
    const inventory = {
      all: {
        hosts: {
          runner: { ansible_host: ip, ansible_user: user },
        },
      },
    };
    return withWorkspace(async ({ save }) => {
      const inventoryPath = await save(
        'inventory.json',
        JSON.stringify(inventory)
      );
      const knownHostsPath =
        knownHosts && (await save('known_hosts', knownHosts));
      const identity =
        env.HIVE_SSH_PRIVATE_KEY_FILE &&
        (await save('identity', await readFile(env.HIVE_SSH_PRIVATE_KEY_FILE)));
      const variables = await save(
        'variables.json',
        JSON.stringify({
          hive_arc_version: pool.arcVersion,
          hive_arc_values: arcValues(
            pool,
            group,
            operation === 'deploy-drained'
          ),
          hive_minikube_cpus: pool.cpus,
          hive_minikube_memory: pool.memoryMiB,
        })
      );
      const output = await run(
        'ansible-playbook',
        [
          '-i',
          inventoryPath,
          playbook,
          '--tags',
          deploying ? 'deploy' : operation,
          '--extra-vars',
          `@${variables}`,
        ],
        {
          env: {
            ...processEnvironment(env),
            HIVE_ARC_AUTH_JSON: JSON.stringify(credentials),
            ANSIBLE_HOST_KEY_CHECKING: 'True',
            ANSIBLE_NOCOLOR: '1',
            ANSIBLE_SSH_ARGS: `-o BatchMode=yes -o StrictHostKeyChecking=yes${identity ? ` -i '${identity}' -o IdentitiesOnly=yes` : ''}${knownHostsPath ? ` -o 'UserKnownHostsFile=${knownHostsPath}'` : ''}`,
          },
        }
      );
      if (operation === 'inspect' || operation === 'drain') {
        const status = output.match(
          /"HIVE_RUNNER_COUNT=([0-9]+);([0-9]+);([0-9.]+)"/
        );
        requireValue(status, 'Runner count missing from Ansible output');
        return {
          runners: Number(status[1]),
          availableMemoryMiB: Number(status[2]),
          load1: Number(status[3]),
        };
      }
      return null;
    });
  };
}
