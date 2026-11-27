import { isAbsolute } from 'node:path';
import {
  githubScope,
  gitlabScope,
  httpsOrigin,
  integer,
  match,
  object,
  requireValue,
  slug,
} from '../config.js';
import { admissionPolicy } from './admission.js';

const token = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,250}$/;
const nodeName = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const imageDigest = /^[a-z0-9][a-z0-9./_:-]+@sha256:[a-f0-9]{64}$/;
const filesystemKey = /^fs-[a-z][a-z0-9-]{0,27}$/;
const max = Number.MAX_SAFE_INTEGER;

function command(value, label) {
  requireValue(
    Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 32 &&
      value.every(
        (item) =>
          typeof item === 'string' &&
          item.length <= 2048 &&
          !item.includes('\0')
      ) &&
      isAbsolute(value[0]),
    `Expected absolute executable and arguments for ${label}`
  );
  return value;
}

function resourceSpec(resources, label) {
  const records = Object.entries(object(resources, label));
  requireValue(
    records.length >= 3 && records.length <= 18,
    `Invalid resources for ${label}`
  );
  requireValue(
    Object.hasOwn(resources, 'cpu') && Object.hasOwn(resources, 'memory'),
    `Missing CPU or memory for ${label}`
  );
  return Object.fromEntries(
    records.map(([key, value]) => {
      requireValue(
        key === 'cpu' || key === 'memory' || filesystemKey.test(key),
        `Invalid resource ${key}`
      );
      return [key, match(value, token, `${label} resource identity`)];
    })
  );
}

function scopeConfig(id, input) {
  match(id, slug, 'measurement scope');
  const entry = object(input, `measurement scope ${id}`);
  const resources = resourceSpec(entry.resources, id);
  requireValue(
    new Set(
      Object.entries(resources)
        .filter(([key]) => filesystemKey.test(key))
        .map(([, value]) => value)
    ).size ===
      Object.keys(resources).length - 2,
    `Use one resource per filesystem in ${id}`
  );
  const overhead = Object.fromEntries(
    Object.entries(object(entry.overhead ?? {}, 'overhead')).map(
      ([key, value]) => {
        requireValue(
          Object.hasOwn(resources, key),
          `Unknown overhead resource ${key}`
        );
        return [key, integer(value, 0, max, `${id} overhead ${key}`)];
      }
    )
  );
  return {
    id,
    identity: match(entry.identity, token, `${id} identity`),
    resources,
    overhead,
    policy: admissionPolicy(entry.policy),
    probe: entry.probe ? command(entry.probe, `${id} probe`) : null,
  };
}

function nodeConfig(id, input, scopes) {
  match(id, slug, 'node alias');
  const node = object(input, `node ${id}`);
  const modes = ['docker', 'swarm', 'kubernetes', 'native'];
  requireValue(
    modes.includes(node.backend),
    `Unsupported worker backend: ${node.backend}`
  );
  const arch = match(node.arch, /^(amd64|arm64)$/, 'worker architecture');
  const os = match(node.os, /^(linux|darwin|windows)$/, 'worker OS');
  requireValue(
    node.backend === 'native' ? os !== 'linux' : os === 'linux',
    'Container backends require Linux containers. Use the native adapter for macOS or Windows jobs.'
  );
  const nodeScopes = node.scopes;
  requireValue(
    Array.isArray(nodeScopes) &&
      nodeScopes.length > 0 &&
      new Set(nodeScopes).size === nodeScopes.length &&
      nodeScopes.every((scope) => Object.hasOwn(scopes, scope)),
    `Missing or invalid measurement scopes for ${id}`
  );
  const runtimeScope = match(
    node.runtimeScope,
    slug,
    'runtime measurement scope'
  );
  requireValue(
    nodeScopes.includes(runtimeScope),
    `Missing runtime measurements for ${id}`
  );
  const scope = scopes[runtimeScope];
  requireValue(
    node.backend !== 'docker' || scope.identity === `docker:${node.identity}`,
    'Docker runtime measurement scope must match the pinned Docker engine ID'
  );
  requireValue(
    node.backend === 'docker' || scope.probe,
    `Every measurement scope for ${id} needs a node probe`
  );
  return {
    id,
    arch,
    os,
    backend: node.backend,
    identity: match(node.identity, token, `${id} runtime identity`),
    scopes: nodeScopes,
    runtimeScope,
    context:
      node.backend === 'native'
        ? undefined
        : match(node.context, nodeName, 'runtime context'),
    target: ['swarm', 'kubernetes'].includes(node.backend)
      ? match(node.target, nodeName, 'runtime node')
      : undefined,
    namespace:
      node.backend === 'kubernetes'
        ? match(node.namespace, nodeName, 'worker namespace')
        : undefined,
    adapter:
      node.backend === 'native'
        ? command(node.adapter, `${id} native adapter`)
        : undefined,
    monitorImage:
      node.backend === 'docker' && !scope.probe
        ? match(node.monitorImage, imageDigest, 'local monitor image digest')
        : undefined,
  };
}

function poolConfig(id, input, nodes) {
  match(id, slug, 'local pool');
  const pool = object(input, `pool ${id}`);
  const platform = match(
    pool.platform,
    /^(github|gitlab)$/,
    'private CI platform'
  );
  const scope = match(
    pool.scope,
    platform === 'github' ? githubScope : gitlabScope,
    'private repository or project'
  );
  requireValue(
    scope.includes('/'),
    'Local workers require a private repository or project'
  );
  requireValue(
    Array.isArray(pool.nodes) &&
      pool.nodes.length > 0 &&
      new Set(pool.nodes).size === pool.nodes.length &&
      pool.nodes.every((node) => Object.hasOwn(nodes, node)),
    `Invalid nodes for pool ${id}`
  );
  const { os, arch, backend } = nodes[pool.nodes[0]];
  requireValue(
    pool.nodes.every(
      (node) =>
        nodes[node].os === os &&
        nodes[node].arch === arch &&
        (nodes[node].backend === 'native') === (backend === 'native')
    ),
    `Pool ${id} must use one worker OS and architecture`
  );
  requireValue(
    isAbsolute(pool.tokenFile ?? ''),
    'Use an absolute administrator token file path'
  );
  const limits = object(pool.limits, `${id} per-worker limits`);
  const diskMiB = integer(limits.diskMiB, 64, 32768, 'workspace MiB');
  const memoryMiB = integer(limits.memoryMiB, 128, 65536, 'worker memory MiB');
  return {
    id,
    platform,
    scope,
    origin:
      platform === 'gitlab'
        ? httpsOrigin(pool.origin ?? 'https://gitlab.com', 'GitLab server')
        : 'https://github.com',
    tokenFile: match(pool.tokenFile, /^[^\0]+$/, 'administrator token file'),
    label: match(
      pool.label,
      /^(?!self-hosted$|linux$|windows$|macos$|x64$|arm64$)[a-z][a-z0-9-]{0,30}$/,
      'dedicated local job label'
    ),
    image:
      backend !== 'native'
        ? match(pool.image, imageDigest, 'worker image digest')
        : match(pool.image, token, 'native worker template'),
    nodes: pool.nodes,
    os,
    arch,
    slots: integer(pool.slots ?? 1, 1, 32, 'pool slots'),
    limits: {
      cpuMillis: integer(limits.cpuMillis, 100, 64000, 'worker millicores'),
      memoryMiB,
      diskMiB,
    },
  };
}

export function localConfig(input) {
  const config = object(input, 'local controller configuration');
  requireValue(
    config.version === 1,
    'Unsupported local controller configuration version'
  );
  const scopes = Object.fromEntries(
    Object.entries(object(config.scopes, 'measurement scopes')).map(
      ([id, spec]) => [id, scopeConfig(id, spec)]
    )
  );
  const nodes = Object.fromEntries(
    Object.entries(object(config.nodes, 'worker nodes')).map(([id, spec]) => [
      id,
      nodeConfig(id, spec, scopes),
    ])
  );
  const pools = Object.fromEntries(
    Object.entries(object(config.pools, 'local pools')).map(([id, spec]) => [
      id,
      poolConfig(id, spec, nodes),
    ])
  );
  requireValue(
    Object.keys(nodes).length > 0 &&
      Object.keys(nodes).length <= 32 &&
      new Set(
        Object.values(nodes).map(
          ({ backend, identity }) => `${backend}:${identity}`
        )
      ).size === Object.keys(nodes).length,
    'Configure 1–32 distinct runtime nodes'
  );
  requireValue(
    Object.keys(scopes).length <= 64,
    'Configure at most 64 measurement scopes'
  );
  requireValue(
    Object.keys(pools).length > 0 && Object.keys(pools).length <= 32,
    'Configure 1–32 local pools'
  );
  const routes = Object.values(pools).map(
    ({ platform, origin, scope, label }) =>
      JSON.stringify([platform, origin, scope.toLowerCase(), label])
  );
  requireValue(
    new Set(routes).size === routes.length,
    'Local job labels must be unique within each private project'
  );
  const controller =
    Object.hasOwn(scopes, config.controllerScope) &&
    scopes[config.controllerScope];
  requireValue(
    controller &&
      !controller.probe &&
      controller.overhead.cpu > 0 &&
      controller.overhead.memory > 0 &&
      Object.keys(controller.resources).filter(
        (resource) =>
          filesystemKey.test(resource) && controller.overhead[resource] > 0
      ).length === 1 &&
      Object.keys(controller.resources).length === 3,
    'Configure local CPU, memory and filesystem overhead for the controller'
  );
  requireValue(
    Object.values(nodes).every(
      (node) =>
        node.scopes.includes(config.controllerScope) &&
        node.runtimeScope !== config.controllerScope &&
        node.scopes.every(
          (id) =>
            id === config.controllerScope ||
            scopes[id].probe ||
            (node.backend === 'docker' && id === node.runtimeScope)
        )
    ),
    'Each worker must measure the controller and its runtime independently'
  );
  requireValue(
    isAbsolute(config.controllerStorage ?? ''),
    'Use an absolute controller storage path'
  );
  return {
    controllerScope: config.controllerScope,
    controllerStorage: config.controllerStorage,
    pollMs: integer(config.pollMs ?? 5000, 1000, 60000, 'poll interval'),
    scopes,
    nodes,
    pools,
  };
}

export function workerOption(pool, node, config) {
  const { cpuMillis, memoryMiB, diskMiB } = pool.limits;
  return {
    pool: pool.id,
    node: node.id,
    claims: Object.fromEntries(
      node.scopes.map((id) => [
        id,
        Object.fromEntries(
          Object.keys(config.scopes[id].resources).map((resource) => [
            resource,
            resource === 'cpu'
              ? cpuMillis
              : resource === 'memory'
                ? memoryMiB + (node.backend === 'native' ? 0 : diskMiB + 16)
                : diskMiB + (node.backend === 'native' ? 0 : 16),
          ])
        ),
      ])
    ),
  };
}
