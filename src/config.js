import { isIP } from 'node:net';
import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';

export const slug = /^[a-z][a-z0-9-]{0,30}$/;
export const environmentName = /^[A-Z_][A-Z0-9_]*$/;
export const repositoryName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const version = /^v?[0-9]+\.[0-9]+\.[0-9]+$/;
export const githubScope =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})?$/;

export function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

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

export function integer(value, min, max, label) {
  requireValue(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${label} must be between ${min} and ${max}`
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

function spareTarget(value, scope, provider) {
  const target = object(value, 'spare host');
  requireValue(
    scope.includes('/') && provider === null,
    'Spare hosts need a repository pool without a cloud provider'
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
  };
}

function clusterSettings(pool) {
  return {
    cpus: integer(pool.cpus ?? 4, 2, 64, 'Minikube CPUs'),
    memoryMiB: integer(pool.memoryMiB ?? 8192, 2048, 131072, 'Minikube memory'),
    arcVersion: match(
      pool.arcVersion ?? '0.15.1',
      version,
      'ARC chart version'
    ),
  };
}

function spareSettings(pool, scope, provider) {
  return pool.spareHost === undefined
    ? {}
    : { spareHost: spareTarget(pool.spareHost, scope, provider) };
}

function poolCredentials(pool) {
  return {
    credentialsEnv: match(
      pool.credentialsEnv ?? 'HIVE_ARC_CREDENTIALS',
      environmentName,
      'ARC credentials environment variable'
    ),
    groupTokenEnv: match(
      pool.groupTokenEnv ?? 'HIVE_GITHUB_TOKEN',
      environmentName,
      'GitHub administration environment variable'
    ),
    webhookSecretEnv: match(
      pool.webhookSecretEnv ?? 'HIVE_WEBHOOK_SECRET',
      environmentName,
      'GitHub webhook secret environment variable'
    ),
  };
}

function poolConfig(value, name, providers) {
  match(name, slug, 'pool name');
  const pool = object(value, name);
  const scope = match(pool.scope, githubScope, 'GitHub scope');
  const maxMachines = integer(
    pool.maxMachines ?? 1,
    1,
    scope.includes('/') ? 1 : 25,
    'pool maxMachines'
  );
  const capacity = integer(
    pool.capacity ?? 2,
    1,
    64,
    'runner capacity per machine'
  );
  const provider = pool.provider ?? null;
  const selectedRepositories = stringList(
    pool.selectedRepositories ?? [],
    'selected repositories'
  );
  requireValue(
    selectedRepositories.every((repository) => repositoryName.test(repository)),
    'Use unqualified repository names in selectedRepositories'
  );
  requireValue(
    scope.includes('/') || selectedRepositories.length,
    'Organization pools require selectedRepositories'
  );
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
    scope,
    label: match(pool.label ?? name, slug, 'runner label'),
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
    ...poolCredentials(pool),
    ...clusterSettings(pool),
    ...spareSettings(pool, scope, provider),
    selectedRepositories,
  };
}

function accountConfig(value, name, pools) {
  match(name, slug, 'account name');
  const account = object(value, name);
  const pool = match(account.pool, slug, 'account pool');
  requireValue(
    Object.hasOwn(pools, pool) && pools[pool].scope.includes('/'),
    'Paid accounts require a dedicated repository pool'
  );
  requireValue(
    pools[pool].minMachines === 0 &&
      pools[pool].warmRunners === 0 &&
      pools[pool].terraformMachines === 0,
    'Paid pools must start with zero machines and warm runners'
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
  const routes = Object.values(pools).flatMap(
    ({ scope, label, selectedRepositories }) =>
      (scope.includes('/')
        ? [scope]
        : selectedRepositories.map((repo) => `${scope}/${repo}`)
      ).map((repository) => `${repository.toLowerCase()}/${label}`)
  );
  requireValue(
    new Set(routes).size === routes.length,
    'The same repository and runner label cannot belong to multiple pools'
  );
}

function validateSpareHosts(pools, paidPools) {
  const spareHosts = Object.entries(pools).filter(([, pool]) => pool.spareHost);
  const spareAddresses = spareHosts.map(([, pool]) => pool.spareHost.ip);
  requireValue(
    new Set(spareAddresses).size === spareAddresses.length,
    'Each spare host needs its own machine'
  );
  requireValue(
    spareHosts.every(([name]) => paidPools.includes(name)),
    'Spare hosts require a paid account'
  );
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
  return validateConfig(JSON.parse(await readFile(path, 'utf8')));
}

export function arcCredentials(envName, env) {
  const fields = object(JSON.parse(secret(envName, env)), 'ARC credentials');
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
