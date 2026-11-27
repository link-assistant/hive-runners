import { createHash, X509Certificate } from 'node:crypto';
import { URL } from 'node:url';
import {
  gitlabScope,
  httpsOrigin,
  integer,
  match,
  poolRepositories,
  projectPool,
  requireValue,
  secret,
} from './config.js';
import { HttpError, httpClient } from './http.js';
import { k8sResources } from './resources.js';

export function gitlabClient(origin, token, fetcher, signal) {
  const request = httpClient(httpsOrigin(origin, 'GitLab server'), {
    fetcher,
    signal,
  });
  const api = (path, options = {}) =>
    request(`/api/v4${path}`, {
      ...options,
      extraHeaders: { 'private-token': token },
    });
  const id = (value) => integer(value, 1, Number.MAX_SAFE_INTEGER, 'GitLab ID');
  const path = (scope) =>
    encodeURIComponent(match(scope, gitlabScope, 'GitLab scope'));
  const scopePath = (scope, type) =>
    `/${match(type, /^(project|group)$/, 'GitLab scope type')}s/${path(scope)}`;
  async function privateScope(scope, type) {
    const result = await api(scopePath(scope, type));
    requireValue(
      result?.visibility === 'private',
      'GitLab scope must be private'
    );
    return result;
  }
  async function list(endpoint, query = '') {
    const records = [];
    for (let page = 1; page <= 100; page++) {
      const entries = await api(
        `${endpoint}?per_page=100&page=${page}${query}`
      );
      requireValue(Array.isArray(entries), 'Unexpected GitLab list response');
      records.push(...entries);
      if (entries.length < 100) {
        return records;
      }
    }
    throw new Error('GitLab pagination limit reached');
  }
  const runnerPolicy = (label) => ({
    tag_list: [match(label, /^[a-z][a-z0-9-]{0,30}$/, 'runner tag')],
    run_untagged: false,
  });
  return {
    privateScope,
    listRunners: (scope, type = 'project') =>
      list(`${scopePath(scope, type)}/runners`),
    pendingJobs: (scope) =>
      list(`${scopePath(scope, 'project')}/jobs`, '&scope%5B%5D=pending'),
    deleteRunner: (runnerId) =>
      api(`/runners/${id(runnerId)}`, { method: 'DELETE' }),
    runner: (runnerId) => api(`/runners/${id(runnerId)}`),
    job: (scope, jobId) => api(`/projects/${path(scope)}/jobs/${id(jobId)}`),
    listProjects: (scope) =>
      list(
        `/groups/${path(scope)}/projects`,
        '&include_subgroups=true&with_shared=false'
      ),
    async verify(auth, instance) {
      const body = {
        token: auth,
        system_id: `r_${createHash('sha256').update(`hive-preflight/${instance}`).digest('hex').slice(0, 12)}`,
      };
      const runner = await request('/api/v4/runners/verify', {
        method: 'POST',
        body,
      });
      // GitLab records a heartbeat from the verification ID. Remove only that synthetic manager.
      try {
        await request('/api/v4/runners/managers', { method: 'DELETE', body });
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) {
          throw error;
        }
      }
      return runner;
    },
    async createRunner(scope, type, label, name = `Hive Runners ${label}`) {
      const target = await privateScope(scope, type);
      return api('/user/runners', {
        method: 'POST',
        body: {
          runner_type: `${type}_type`,
          [`${type}_id`]: id(target.id),
          description: name,
          ...(type === 'project' ? { locked: true } : {}),
          ...runnerPolicy(label),
        },
      });
    },
    configureRunner: (runnerId, label) =>
      api(`/runners/${id(runnerId)}`, {
        method: 'PUT',
        body: runnerPolicy(label),
      }),
  };
}

async function validateRunnerScope(client, pool, scope, runner) {
  if (projectPool(pool)) {
    requireValue(
      runner.locked === true &&
        runner.projects?.length === 1 &&
        runner.projects[0].id === scope.id,
      'GitLab runner must be locked to the private project'
    );
  } else {
    requireValue(
      runner.groups?.length === 1 && runner.groups[0].id === scope.id,
      'GitLab runner must belong to the private group'
    );
    const expected = new Set(poolRepositories(pool));
    const projects = await client.listProjects(pool.scope);
    requireValue(
      projects.length === expected.size &&
        projects.every(
          (project) =>
            project.visibility === 'private' &&
            expected.has(project.path_with_namespace)
        ),
      'GitLab group projects must match selectedRepositories and be private'
    );
  }
}

function gitlabCertificate(pool, env) {
  if (!pool.gitlabCAEnv) {
    return {};
  }
  const certificate = secret(pool.gitlabCAEnv, env);
  const certificates = certificate.match(
    /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g
  );
  requireValue(certificates?.length, 'Expected PEM certificates for GitLab');
  for (const pem of certificates) {
    new X509Certificate(pem);
  }
  return {
    [`${new URL(pool.gitlabUrl).hostname}.crt`]: certificates.join('\n'),
  };
}

export async function gitlabRunnerAuth(pool, { env, fetcher }, target) {
  const credentials = match(
    secret(pool.credentialsEnv, env),
    /^glrt-[A-Za-z0-9_.-]+$/,
    'GitLab runner authentication token'
  );
  const client = gitlabClient(
    pool.gitlabUrl,
    secret(pool.groupTokenEnv, env),
    fetcher
  );
  const scope = await client.privateScope(pool.scope, pool.gitlabScopeType);
  const runner = await client.runner(pool.gitlabRunnerId);
  const verified = await client.verify(
    credentials,
    `${pool.gitlabUrl}/${target.ip}/${pool.profile}`
  );
  requireValue(
    verified?.id === pool.gitlabRunnerId &&
      runner.runner_type === `${pool.gitlabScopeType}_type` &&
      runner.run_untagged === false &&
      runner.paused === false &&
      runner.tag_list?.length === 1 &&
      runner.tag_list[0] === pool.label,
    'GitLab runner must be enabled, scoped to the pool, and accept only its configured tag'
  );
  await validateRunnerScope(client, pool, scope, runner);
  return {
    'runner-token': credentials,
    ...gitlabCertificate(pool, env),
  };
}

// On scale-down preStop runs while the manager is still present. The inspector
// counts terminating manager pods as well as unfinished jobs before retirement.
const gracefulStop = `pid=$(pgrep -xo gitlab-runner) || exit 0
kill -QUIT "$pid" || exit 0
while kill -0 "$pid" 2>/dev/null; do sleep 1; done`;

export function gitlabValues(pool, drained = false) {
  const { job } = pool;
  const limits = k8sResources(job).limits;
  const privileged = pool.containerMode === 'dind';
  const podPatch = [
    { op: 'add', path: '/automountServiceAccountToken', value: false },
    { op: 'add', path: '/enableServiceLinks', value: false },
  ];
  const gpuPatch = {
    containers: [
      {
        name: 'build',
        resources: {
          requests: { 'nvidia.com/gpu': String(job.gpus) },
          limits: { 'nvidia.com/gpu': String(job.gpus) },
        },
      },
    ],
  };
  return {
    gitlabUrl: pool.gitlabUrl,
    ...(pool.gitlabCAEnv ? { certsSecretName: 'hive-gitlab-ca' } : {}),
    replicas: drained ? 0 : 1,
    concurrent: pool.capacity,
    fullnameOverride: 'hive-gitlab',
    terminationGracePeriodSeconds: 86400,
    strategy: { type: 'Recreate' },
    unregisterRunners: false,
    deploymentLifecycle: {
      preStop: { exec: { command: ['/bin/sh', '-c', gracefulStop] } },
    },
    podLabels: { 'hive-runners.net/workload': 'manager' },
    resources: k8sResources({
      cpuMillis: 150,
      memoryMiB: 256,
      diskMiB: 512,
      gpus: 0,
    }),
    rbac: {
      create: true,
      rules: [
        {
          resources: ['pods'],
          verbs: ['create', 'delete', 'get', 'list', 'watch'],
        },
        {
          resources: ['pods/attach', 'pods/exec'],
          verbs: ['create', 'delete', 'get', 'patch'],
        },
        { resources: ['pods/log'], verbs: ['get', 'list'] },
        {
          resources: ['secrets'],
          verbs: ['create', 'delete', 'get', 'update'],
        },
        { resources: ['serviceaccounts'], verbs: ['get'] },
        { resources: ['services'], verbs: ['create', 'get'] },
      ],
    },
    runners: {
      secret: 'hive-gitlab-auth',
      config: [
        '[[runners]]',
        `  limit = ${pool.capacity}`,
        `  request_concurrency = ${Math.min(10, pool.capacity)}`,
        '  [runners.feature_flags]',
        '    FF_USE_ADVANCED_POD_SPEC_CONFIGURATION = true',
        '  [runners.kubernetes]',
        '    namespace = "hive-runners"',
        `    image = ${JSON.stringify(pool.runnerImage)}`,
        `    privileged = ${privileged}`,
        `    allow_privilege_escalation = ${privileged}`,
        ...Object.entries({
          cpu: limits.cpu,
          memory: limits.memory,
          ephemeral_storage: limits['ephemeral-storage'],
        }).flatMap(([key, value]) => [
          `    ${key}_request = "${value}"`,
          `    ${key}_limit = "${value}"`,
        ]),
        '    [runners.kubernetes.pod_labels]',
        '      "hive-runners.net/workload" = "job"',
        '    [[runners.kubernetes.pod_spec]]',
        '      name = "tokenless"',
        '      patch_type = "json"',
        `      patch = '${JSON.stringify(podPatch)}'`,
        ...(job.gpus
          ? [
              '    [[runners.kubernetes.pod_spec]]',
              '      name = "gpu"',
              '      patch_type = "strategic"',
              `      patch = '${JSON.stringify(gpuPatch)}'`,
            ]
          : []),
        '',
      ].join('\n'),
    },
  };
}
