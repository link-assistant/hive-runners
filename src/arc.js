import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath, URL } from 'node:url';
import { match, projectPool, requireValue } from './config.js';
import { githubRunnerAuth } from './github.js';
import { gitlabRunnerAuth, gitlabValues } from './gitlab.js';
import { runProcess } from './process.js';
import { k8sResources, machineResources, sizing } from './resources.js';
import { withWorkspace } from './workspace.js';

export const playbook = fileURLToPath(
  new URL('./assets/ansible/arc.yml', import.meta.url)
);
export const gitlabPlaybook = fileURLToPath(
  new URL('./assets/ansible/gitlab.yml', import.meta.url)
);

const runnerUser = { runAsNonRoot: true, runAsUser: 1001, runAsGroup: 1001 };
const seccomp = { seccompProfile: { type: 'RuntimeDefault' } };

export function arcValues(pool, group, drained = false) {
  const kubernetes = pool.containerMode === 'kubernetes-novolume';
  const docker = pool.containerMode === 'dind';
  return {
    githubConfigUrl: `https://github.com/${pool.scope}`,
    githubConfigSecret: 'hive-arc-auth',
    runnerScaleSetName: pool.label,
    ...(group ? { runnerGroup: group } : {}),
    ...(kubernetes || docker
      ? { containerMode: { type: pool.containerMode } }
      : {}),
    minRunners: drained ? 0 : pool.warmRunners,
    maxRunners: drained ? 0 : pool.capacity,
    controllerServiceAccount: {
      namespace: 'hive-system',
      name: 'hive-arc-gha-rs-controller',
    },
    template: {
      metadata: { labels: { 'hive-runners.net/workload': 'runner' } },
      spec: {
        automountServiceAccountToken: kubernetes,
        securityContext: docker
          ? { fsGroup: 123, supplementalGroups: [123] }
          : { ...runnerUser, ...seccomp },
        ...(kubernetes
          ? {
              volumes: [
                {
                  name: 'hive-job-policy',
                  configMap: { name: 'hive-job-policy' },
                },
              ],
            }
          : {}),
        containers: [
          {
            name: 'runner',
            image: pool.runnerImage ?? 'ghcr.io/actions/actions-runner:latest',
            command: ['/home/runner/run.sh'],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              ...(docker ? { ...runnerUser, ...seccomp } : {}),
            },
            resources: k8sResources(
              kubernetes
                ? { cpuMillis: 100, memoryMiB: 192, diskMiB: 256, gpus: 0 }
                : pool.job
            ),
            ...(kubernetes
              ? {
                  env: [
                    {
                      name: 'ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE',
                      value: '/etc/hive-job-policy/pod.yaml',
                    },
                  ],
                  volumeMounts: [
                    {
                      name: 'hive-job-policy',
                      mountPath: '/etc/hive-job-policy',
                      readOnly: true,
                    },
                  ],
                }
              : {}),
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

export function runnerHost({
  run = runProcess,
  env = process.env,
  fetcher,
} = {}) {
  async function prepareGithub(pool, group) {
    const { client, credentials } = await githubRunnerAuth(pool, {
      env,
      run,
      fetcher,
    });
    if (group) {
      await client.ensureGroup(pool.scope, group, pool.selectedRepositories);
    } else {
      await client.requirePrivateRepo(pool.scope);
    }
    return credentials;
  }

  return async (
    pool,
    { ip, group, user = 'root', knownHosts, minimum = sizing([pool]).minimum },
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
      'Invalid runner operation'
    );
    const gitlab = pool.platform === 'gitlab';
    requireValue(
      gitlab || projectPool(pool) || group,
      'Organization deployments require a distinct runner group'
    );
    const deploying = operation.startsWith('deploy');
    const credentials = !deploying
      ? {}
      : gitlab
        ? await gitlabRunnerAuth(pool, { env, fetcher }, { ip })
        : await prepareGithub(pool, group);
    const drained = operation === 'deploy-drained';
    const profile = pool.profile ?? 'minikube';
    const kubeconfig =
      profile === 'minikube'
        ? '/home/hive-runner/.kube/config'
        : `/home/hive-runner/kube-${profile}`;
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
          ...(gitlab
            ? {
                hive_gitlab_version: pool.gitlabChartVersion,
                hive_gitlab_values: gitlabValues(pool, drained),
              }
            : {
                hive_arc_version: pool.arcVersion,
                hive_arc_values: arcValues(pool, group, drained),
              }),
          hive_platform: gitlab ? 'gitlab' : 'github',
          ...(gitlab
            ? {
                hive_gitlab_egress: pool.gitlabEgressIPv4,
                hive_gitlab_port: Number(new URL(pool.gitlabUrl).port || 443),
              }
            : {}),
          hive_profile: profile,
          hive_kubeconfig: kubeconfig,
          hive_gpu_count: machineResources(pool).gpus,
          hive_minimum: minimum,
          hive_disk_mib: pool.diskMiB,
          hive_job_resources: k8sResources(pool.job),
          hive_minikube_cpus: pool.cpus,
          hive_minikube_memory: pool.memoryMiB,
          hive_container_mode: pool.containerMode ?? 'process',
        })
      );
      const output = await run(
        'ansible-playbook',
        [
          '-i',
          inventoryPath,
          gitlab ? gitlabPlaybook : playbook,
          '--tags',
          deploying ? 'deploy' : operation,
          '--extra-vars',
          `@${variables}`,
        ],
        {
          env: {
            ...processEnvironment(env),
            HIVE_RUNNER_AUTH_JSON: JSON.stringify(credentials),
            ANSIBLE_HOST_KEY_CHECKING: 'True',
            ANSIBLE_NOCOLOR: '1',
            ANSIBLE_SSH_ARGS: `-o BatchMode=yes -o StrictHostKeyChecking=yes${identity ? ` -i '${identity}' -o IdentitiesOnly=yes` : ''}${knownHostsPath ? ` -o 'UserKnownHostsFile=${knownHostsPath}'` : ''}`,
          },
        }
      );
      if (operation === 'inspect' || operation === 'drain') {
        const status = output.match(
          /"HIVE_RUNNER_COUNT=([0-9]+);([0-9]+);([0-9.]+);([0-9]+)"/
        );
        requireValue(status, 'Runner count missing from Ansible output');
        return {
          runners: Number(status[1]),
          availableMemoryMiB: Number(status[2]),
          load1: Number(status[3]),
          availableDiskMiB: Number(status[4]),
        };
      }
      return null;
    });
  };
}

export const arcHost = runnerHost;
