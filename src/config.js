import { isIP } from 'node:net';
import { URL } from 'node:url';
import { readData, parseNotation } from './notation.js';
import { fits, jobOverhead, sizing } from './resources.js';
import { integer, requireValue } from './validation.js';

export { integer, requireValue } from './validation.js';

export const slug = /^[a-z][a-z0-9-]{0,30}$/;
export const environmentName = /^[A-Z_][A-Z0-9_]*$/;
export const repositoryName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const version = /^v?[0-9]+\.[0-9]+\.[0-9]+$/;
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const githubScope =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})?$/;
export const gitlabScope =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}){0,9}$/;

export function object(value, label) {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`
  );
  return value;
}

export function match(value, pattern, label) {
  requireValue(
    typeof value === 'string' && pattern.test(value),
    `Invalid ${label}`
  );
  return value;
}

export function secret(name, env = process.env) {
  match(name, environmentName, 'secret environment variable name');
  const value = Object.hasOwn(env, name) && env[name];
  requireValue(
    typeof value === 'string' && value.trim(),
    `Missing environment variable ${name}`
  );
  return value;
}

export function httpsOrigin(value, label) {
  const url = new URL(value);
  requireValue(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    `Invalid HTTPS origin for ${label}`
  );
  return url.origin;
}

function stringList(value, name) {
  requireValue(Array.isArray(value), `${name} must be an array`);
  return value.map((item) =>
    match(item, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/, name)
  );
}

export function hardware(value, label) {
  const fields = object(value, label);
  return {
    cpuMillis: integer(fields.cpuMillis, 1000, 256000, `${label} CPU`),
    memoryMiB: integer(fields.memoryMiB, 1024, 1048576, `${label} memory`),
    diskMiB: integer(fields.diskMiB, 4096, 16777216, `${label} disk`),
    gpus: integer(fields.gpus ?? 0, 0, 64, `${label} GPUs`),
  };
}

function providerConfig(value, name) {
  match(name, slug, 'provider name');
  const provider = object(value, name);
  requireValue(
    ['contabo', 'hetzner'].includes(provider.type),
    `Unsupported provider type for ${name}`
  );
  const settings = {
    type: provider.type,
    maxMachines: integer(
      provider.maxMachines ?? 10,
      1,
      100,
      'provider maxMachines'
    ),
    tokenPrefix: match(
      provider.tokenPrefix ?? provider.type.toUpperCase(),
      environmentName,
      'provider tokenPrefix'
    ),
    region: match(provider.region, /^[A-Za-z0-9-]+$/, 'provider region'),
    product: match(provider.product, /^[A-Za-z0-9-]+$/, 'provider product'),
    image: match(provider.image, /^[A-Za-z0-9._-]+$/, 'provider image'),
    sshKeys: stringList(provider.sshKeys, 'provider sshKeys'),
    monthlyCents: integer(
      provider.monthlyCents,
      1,
      100000,
      'provider monthlyCents'
    ),
    ...(provider.hardware
      ? { hardware: hardware(provider.hardware, 'provider hardware') }
      : {}),
  };
  requireValue(settings.sshKeys.length > 0, `Configure an SSH key for ${name}`);
  if (settings.type === 'contabo') {
    requireValue(
      settings.sshKeys.every((id) => /^[1-9][0-9]{0,12}$/.test(id)),
      'Contabo SSH keys are numeric secret IDs'
    );
  }
  return settings;
}

function spareTarget(value, isProject, provider) {
  const target = object(value, 'spare host');
  requireValue(
    isProject && provider === null,
    'Spare hosts need a repository or project pool without a cloud provider'
  );
  requireValue(isIP(target.ip) === 4, 'A spare host requires its IPv4 address');
  return {
    ip: target.ip,
    user: match(
      target.user ?? 'root',
      /^[a-z_][a-z0-9_-]{0,31}$/,
      'spare host SSH user'
    ),
    hostKey: match(
      target.hostKey,
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/,
      'spare host public SSH key'
    ),
    ...(target.hardware
      ? { hardware: hardware(target.hardware, 'spare host hardware') }
      : {}),
  };
}

function clusterSettings(pool, platform, capacity) {
  const cluster = {
    cpus: integer(pool.cpus ?? 4, 2, 64, 'Minikube CPUs'),
    memoryMiB: integer(pool.memoryMiB ?? 8192, 2048, 131072, 'Minikube memory'),
    arcVersion: match(
      pool.arcVersion ?? '0.15.1',
      version,
      'ARC chart version'
    ),
    containerMode: match(
      pool.containerMode ??
        (platform === 'gitlab' ? 'kubernetes-novolume' : 'process'),
      /^(process|kubernetes-novolume|dind)$/,
      'runner container mode'
    ),
    diskMiB: integer(pool.diskMiB ?? 24576, 8192, 4194304, 'cluster disk'),
    isolation: match(
      pool.isolation ?? 'machine',
      /^(machine|job)$/,
      'isolation mode'
    ),
    runnerImage: match(
      pool.runnerImage ??
        (platform === 'gitlab'
          ? 'alpine:3.23'
          : 'ghcr.io/actions/actions-runner:latest'),
      /^[a-z0-9][a-zA-Z0-9./:_@-]{0,254}$/,
      'runner image'
    ),
  };
  requireValue(
    (platform !== 'gitlab' || cluster.containerMode !== 'process') &&
      (cluster.isolation !== 'job' ||
        cluster.containerMode === 'kubernetes-novolume'),
    'GitLab requires Kubernetes and job isolation requires unprivileged Kubernetes jobs'
  );
  return {
    ...cluster,
    job: jobSettings(pool.job, cluster, platform, capacity),
  };
}

function jobSettings(resources, cluster, platform, capacity) {
  const overhead = jobOverhead(cluster.containerMode, platform);
  const budget = {
    cpuMillis:
      Math.floor(((cluster.cpus - 1) * 1000 - 200) / capacity) -
      overhead.cpuMillis,
    memoryMiB:
      Math.floor((cluster.memoryMiB - 1280) / capacity) - overhead.memoryMiB,
    diskMiB: Math.floor((cluster.diskMiB - 4608) / capacity) - overhead.diskMiB,
  };
  const job = object(resources ?? {}, 'job resources');
  requireValue(
    !job.gpus || cluster.containerMode !== 'dind',
    'GPU pools require process or unprivileged Kubernetes jobs'
  );
  return {
    cpuMillis: integer(
      job.cpuMillis ?? budget.cpuMillis,
      100,
      budget.cpuMillis,
      'job CPU in millicores'
    ),
    memoryMiB: integer(
      job.memoryMiB ?? budget.memoryMiB,
      256,
      budget.memoryMiB,
      'job memory in MiB'
    ),
    diskMiB: integer(
      job.diskMiB ?? budget.diskMiB,
      512,
      budget.diskMiB,
      'job disk in MiB'
    ),
    gpus: integer(
      job.gpus ?? 0,
      0,
      Math.floor(64 / capacity),
      'exclusive NVIDIA GPUs per job'
    ),
  };
}

function spareSettings(pool, isProject, provider) {
  return pool.spareHost === undefined
    ? {}
    : { spareHost: spareTarget(pool.spareHost, isProject, provider) };
}

function poolCredentials(pool, platform) {
  const gitlab = platform === 'gitlab';
  return {
    credentialsEnv: match(
      pool.credentialsEnv ??
        (gitlab ? 'HIVE_GITLAB_RUNNER_TOKEN' : 'HIVE_ARC_CREDENTIALS'),
      environmentName,
      'runner credentials environment variable'
    ),
    groupTokenEnv: match(
      pool.groupTokenEnv ??
        (gitlab ? 'HIVE_GITLAB_TOKEN' : 'HIVE_GITHUB_TOKEN'),
      environmentName,
      'runner administration environment variable'
    ),
    webhookSecretEnv: match(
      pool.webhookSecretEnv ??
        (gitlab ? 'HIVE_GITLAB_WEBHOOK_SECRET' : 'HIVE_WEBHOOK_SECRET'),
      environmentName,
      'runner webhook secret environment variable'
    ),
  };
}

function gitlabSettings(pool) {
  const gitlabUrl = httpsOrigin(
    pool.gitlabUrl ?? 'https://gitlab.com',
    'GitLab server'
  );
  const gitlabEgressIPv4 = stringList(
    pool.gitlabEgressIPv4 ?? [],
    'GitLab egress addresses'
  );
  requireValue(
    gitlabEgressIPv4.every(
      (ip) => isIP(ip) === 4 && !/^(0|127|169\.254)\./.test(ip)
    ),
    'GitLab egress addresses must be routable IPv4 addresses'
  );
  requireValue(
    !new URL(gitlabUrl).port || gitlabEgressIPv4.length,
    'GitLab servers on non-standard HTTPS ports need explicit egress addresses'
  );
  return {
    gitlabUrl,
    gitlabEgressIPv4,
    ...(pool.gitlabCAEnv
      ? {
          gitlabCAEnv: match(
            pool.gitlabCAEnv,
            environmentName,
            'GitLab CA environment variable'
          ),
        }
      : {}),
    gitlabScopeType: match(
      pool.gitlabScopeType ?? 'project',
      /^(project|group)$/,
      'GitLab scope type'
    ),
    gitlabRunnerId: integer(
      pool.gitlabRunnerId,
      1,
      Number.MAX_SAFE_INTEGER,
      'GitLab runner ID'
    ),
    gitlabChartVersion: match(
      pool.gitlabChartVersion ?? '0.95.0',
      version,
      'GitLab Runner chart version'
    ),
  };
}

export function projectPool(pool) {
  return pool.platform === 'gitlab'
    ? pool.gitlabScopeType === 'project'
    : pool.scope.includes('/');
}

export function poolRepositories(pool) {
  return projectPool(pool)
    ? [pool.scope]
    : pool.selectedRepositories.map((repo) => `${pool.scope}/${repo}`);
}

function poolRouting(pool) {
  const platform = match(
    pool.platform ?? 'github',
    /^(github|gitlab)$/,
    'runner platform'
  );
  const gitlab = platform === 'gitlab';
  const scope = match(
    pool.scope,
    gitlab ? gitlabScope : githubScope,
    'runner scope'
  );
  const platformSettings = gitlab ? gitlabSettings(pool) : {};
  const isProject = projectPool({ platform, scope, ...platformSettings });
  requireValue(
    !isProject || scope.includes('/'),
    'A repository or project requires a namespace'
  );
  const selectedRepositories = stringList(
    pool.selectedRepositories ?? [],
    'selected repositories'
  );
  requireValue(
    selectedRepositories.every((repository) =>
      gitlab
        ? gitlabScope.test(`${scope}/${repository}`)
        : repositoryName.test(repository)
    ),
    'Use repository paths relative to the configured scope in selectedRepositories'
  );
  requireValue(
    isProject || selectedRepositories.length,
    'Organization and group pools require selectedRepositories'
  );
  return { platform, ...platformSettings, scope, selectedRepositories };
}

function poolScaling(pool, isProject, platform, providers) {
  const maxMachines = integer(
    pool.maxMachines ?? 1,
    1,
    platform === 'github' && isProject ? 1 : 25,
    'pool maxMachines'
  );
  const capacity = integer(
    pool.capacity ?? 2,
    1,
    64,
    'runner capacity per machine'
  );
  const provider = pool.provider ?? null;
  requireValue(
    provider === null || Object.hasOwn(providers, provider),
    'Unknown pool provider'
  );
  const terraformMachines = integer(
    pool.terraformMachines ?? 0,
    0,
    maxMachines,
    'Terraform machines'
  );
  return {
    maxMachines,
    terraformMachines,
    capacity,
    provider,
    minMachines: integer(
      pool.minMachines ?? 0,
      0,
      maxMachines - terraformMachines,
      'pool minMachines'
    ),
    warmRunners: integer(pool.warmRunners ?? 0, 0, capacity, 'warm runners'),
    idleSeconds: integer(
      pool.idleSeconds ?? 900,
      60,
      86400,
      'fleet idle seconds'
    ),
  };
}

function poolConfig(value, name, providers) {
  match(name, slug, 'pool name');
  const pool = object(value, name);
  const routing = poolRouting(pool);
  const { platform } = routing;
  const isProject = projectPool(routing);
  const scaling = poolScaling(pool, isProject, platform, providers);
  const { provider, capacity } = scaling;
  const settings = {
    ...routing,
    ...scaling,
    label: match(pool.label ?? name, slug, 'runner label'),
    profile:
      pool.isolation === 'job' || platform === 'gitlab'
        ? `hive-${name}`
        : 'minikube',
    ...poolCredentials(pool, platform),
    ...clusterSettings(pool, platform, capacity),
    ...spareSettings(pool, isProject, provider),
  };
  const supply =
    (provider && providers[provider].hardware) || settings.spareHost?.hardware;
  requireValue(
    (!provider || !settings.job.gpus || supply) &&
      (!supply || fits(supply, sizing([settings]).minimum)),
    'Machine hardware does not satisfy the pool minimum; GPU VPS plans require declared hardware'
  );
  return settings;
}

function accountConfig(value, name, pools) {
  match(name, slug, 'account name');
  const account = object(value, name);
  const pool = match(account.pool, slug, 'account pool');
  requireValue(
    Object.hasOwn(pools, pool) && projectPool(pools[pool]),
    'Paid accounts require a dedicated repository or project pool'
  );
  requireValue(
    pools[pool].minMachines === 0 &&
      pools[pool].warmRunners === 0 &&
      pools[pool].terraformMachines === 0,
    'Paid pools must start with zero machines and warm runners'
  );
  requireValue(
    pools[pool].containerMode !== 'dind',
    'Paid pools cannot use privileged Docker-in-Docker'
  );
  requireValue(
    Array.isArray(account.upstreams ?? []),
    'Account upstreams must be an array'
  );
  return {
    pool,
    keyEnv: match(
      account.keyEnv,
      environmentName,
      'account key environment variable'
    ),
    rate: integer(account.rate, 1, 10000, 'price in cents per runner-minute'),
    initialCredit: integer(
      account.initialCredit ?? 0,
      0,
      1000000,
      'initial credit'
    ),
    upstreams: (account.upstreams ?? []).map((upstream) => ({
      origin: httpsOrigin(upstream.origin, 'upstream'),
      keyEnv: match(
        upstream.keyEnv,
        environmentName,
        'upstream key environment variable'
      ),
      maxRate: integer(upstream.maxRate, 1, account.rate, 'upstream rate'),
      notation: match(
        upstream.notation ?? 'lino',
        /^(lino|json)$/,
        'upstream notation'
      ),
    })),
  };
}

function table(input, normalize, ...args) {
  return Object.fromEntries(
    Object.entries(object(input ?? {}, 'configuration table')).map(
      ([name, value]) => [name, normalize(value, name, ...args)]
    )
  );
}

function validateFleet(pools, providers) {
  for (const [name, provider] of Object.entries(providers)) {
    const reserved = Object.values(pools)
      .filter((pool) => pool.provider === name)
      .reduce(
        (total, pool) => total + pool.terraformMachines + pool.minMachines,
        0
      );
    requireValue(
      reserved <= provider.maxMachines,
      `Reserved machines exceed the cap for ${name}`
    );
  }
  const routes = Object.values(pools).flatMap((pool) =>
    poolRepositories(pool).map(
      (repository) =>
        `${pool.platform}/${pool.gitlabUrl ?? ''}/${repository.toLowerCase()}/${pool.label}`
    )
  );
  requireValue(
    new Set(routes).size === routes.length,
    'The same repository and runner label cannot belong to multiple pools'
  );
  const gitlabRunners = Object.values(pools)
    .filter(({ platform }) => platform === 'gitlab')
    .map(({ gitlabUrl, gitlabRunnerId }) => `${gitlabUrl}/${gitlabRunnerId}`);
  requireValue(
    new Set(gitlabRunners).size === gitlabRunners.length,
    'Each GitLab pool needs its own runner ID'
  );
}

function validateSpareHosts(pools, paidPools) {
  const spareHosts = Object.entries(pools).filter(([, pool]) => pool.spareHost);
  const hosts = Map.groupBy(
    spareHosts.map(([, pool]) => pool),
    (pool) => pool.spareHost.ip
  );
  for (const entries of hosts.values()) {
    validateSharedHost(entries, entries[0].spareHost.hardware);
    requireValue(
      entries.every(
        ({ spareHost }) =>
          spareHost.hostKey === entries[0].spareHost.hostKey &&
          JSON.stringify(spareHost.hardware) ===
            JSON.stringify(entries[0].spareHost.hardware)
      ),
      'Shared spare hosts must use the same host key and hardware inventory'
    );
  }
  requireValue(
    spareHosts.every(([name]) => paidPools.includes(name)),
    'Spare hosts require a paid account'
  );
}

export function validateSharedHost(pools, supply) {
  if (pools.length > 1) {
    requireValue(
      pools.every(({ isolation }) => isolation === 'job') &&
        new Set(pools.map(({ profile }) => profile)).size === pools.length,
      'Multiple pools on a machine require job isolation and separate profiles'
    );
    requireValue(
      supply,
      'Shared machines require an explicit hardware inventory'
    );
    requireValue(
      pools.filter(({ job }) => job.gpus > 0).length <= 1,
      'A shared machine can expose GPUs to one profile only'
    );
  }
  const required = sizing(pools).minimum;
  requireValue(
    !supply || fits(supply, required),
    'Machine hardware is below the combined pool minimum'
  );
  return required;
}

export function validateConfig(input) {
  object(input, 'configuration');
  requireValue(input.version === 1, 'Configuration version must be 1');
  const providers = table(input.providers, providerConfig);
  const pools = table(input.pools, poolConfig, providers);
  const accounts = table(input.accounts, accountConfig, pools);
  const paidPools = Object.values(accounts).map(({ pool }) => pool);
  requireValue(
    new Set(paidPools).size === paidPools.length,
    'Each paid account needs its own pool'
  );
  validateSpareHosts(pools, paidPools);
  validateFleet(pools, providers);
  const prefix = match(
    input.prefix ?? 'hive',
    /^[a-z][a-z0-9-]{0,11}$/,
    'fleet prefix'
  );
  return { version: 1, prefix, providers, pools, accounts };
}

export async function loadConfig(path) {
  return validateConfig(await readData(path));
}

export function arcCredentials(envName, env) {
  const text = secret(envName, env);
  const fields = object(
    text.trimStart().startsWith('{') ? JSON.parse(text) : parseNotation(text),
    'ARC credentials'
  );
  const allowed = Object.hasOwn(fields, 'github_token')
    ? ['github_token']
    : ['github_app_id', 'github_app_installation_id', 'github_app_private_key'];
  requireValue(
    Object.keys(fields).length === allowed.length &&
      allowed.every(
        (key) => typeof fields[key] === 'string' && fields[key].trim()
      ),
    'Use the ARC GitHub token or GitHub App credential fields'
  );
  return fields;
}
