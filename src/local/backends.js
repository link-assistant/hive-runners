import { requireValue } from '../config.js';
import { runProcess } from '../process.js';
import { dockerSample } from './telemetry.js';
import {
  controllerLabel,
  dockerWorkerArgs,
  kubeNodeLabel,
  kubeSecret,
  kubeWorker,
  swarmWorkerArgs,
} from './spec.js';

const leaseName = /^hive-[a-f0-9]{12}-[a-f0-9]{32}$/;

function lines(output) {
  return output.trim().split('\n').filter(Boolean).map(JSON.parse);
}

function owned(records) {
  requireValue(
    records.every(
      ({ id, state }) =>
        leaseName.test(id) && ['live', 'terminal'].includes(state)
    ) && new Set(records.map(({ id }) => id)).size === records.length,
    'Invalid worker inventory'
  );
  return records;
}

function dockerCli(node, run, env) {
  const childEnv = { ...env };
  delete childEnv.DOCKER_HOST;
  delete childEnv.DOCKER_CONTEXT;
  delete childEnv.DOCKER_API_VERSION;
  return (args, { ticket, input } = {}) =>
    run('docker', ['--context', node.context, ...args], {
      env: ticket ? { ...childEnv, HIVE_WORKER_TICKET: ticket } : childEnv,
      input,
      maxMs: 12000,
    });
}

function dockerArchitecture(value) {
  return { x86_64: 'amd64', aarch64: 'arm64' }[value] ?? value;
}

function validEngine(info, node) {
  requireValue(
    info.ID === node.identity &&
      info.OSType === 'linux' &&
      dockerArchitecture(info.Architecture) === node.arch &&
      info.CgroupVersion === '2' &&
      info.CpuCfsQuota === true &&
      info.MemoryLimit === true &&
      info.SwapLimit === true &&
      info.PidsLimit === true,
    'Docker engine identity, Linux architecture or containment support mismatch'
  );
}

function dockerBackend(node, owner, run, env, now) {
  const docker = dockerCli(node, run, env);
  const selector = `label=${controllerLabel}`;
  const inspect = async () => {
    const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    validEngine(info, node);
    return info;
  };
  return {
    inspect,
    sample: (scope, info) => dockerSample(node, scope, docker, info, now),
    async ready(pool) {
      const [image] = JSON.parse(
        await docker(['image', 'inspect', pool.image])
      );
      requireValue(
        image?.Os === 'linux' &&
          image.Architecture === node.arch &&
          image.RepoDigests?.includes(pool.image) &&
          Object.keys(image.Config?.Volumes ?? {}).length === 0,
        'Preload the exact Linux worker image without image-declared volumes'
      );
    },
    async list() {
      return owned(
        lines(
          await docker([
            'ps',
            '--all',
            '--filter',
            selector,
            '--format',
            '{{json .}}',
          ])
        ).map(({ Names, State }) => ({
          id: Names,
          state: ['exited', 'dead', 'created'].includes(State)
            ? 'terminal'
            : 'live',
        }))
      );
    },
    async launch(pool, lease, ticket) {
      await docker(dockerWorkerArgs(node, pool, lease, owner), { ticket });
      await docker(['start', lease.id]);
    },
    async remove(lease, present) {
      if (present) {
        await docker(['rm', lease.id]);
      }
    },
  };
}

function checkLinuxNode(os, arch, node) {
  requireValue(
    os === 'linux' && dockerArchitecture(arch) === node.arch,
    'Runtime node Linux architecture changed'
  );
}

function probeContainment(sample, pool) {
  requireValue(
    sample?.checks?.cgroupV2 === true &&
      sample.checks.cpuLimits === true &&
      sample.checks.memoryLimits === true &&
      sample.checks.workspaceLimits === true &&
      sample.checks.swapDisabled === true &&
      sample.checks.images?.includes(pool.image),
    'Node probe did not confirm containment, swap disabled and preloaded image'
  );
}

function swarmBackend(node, owner, run, env) {
  const docker = dockerCli(node, run, env);
  const selector = `label=${controllerLabel}`;
  async function namedServices(kind) {
    return lines(
      await docker([kind, 'ls', '--filter', selector, '--format', '{{json .}}'])
    ).map(({ Name }) => Name);
  }
  return {
    async inspect() {
      const [target] = JSON.parse(
        await docker(['node', 'inspect', node.identity])
      );
      requireValue(
        target?.ID === node.identity &&
          target.Description?.Hostname === node.target &&
          target.Status?.State === 'ready' &&
          typeof target.Spec?.Availability === 'string',
        'Swarm node is unavailable or mismatched'
      );
      checkLinuxNode(
        target.Description.Platform?.OS,
        target.Description.Platform?.Architecture,
        node
      );
      return target;
    },
    ready(pool, entry, sample) {
      requireValue(
        entry.Spec.Availability === 'active',
        'Swarm node is unavailable for placements'
      );
      probeContainment(sample, pool);
    },
    async list() {
      const workers = [];
      for (const service of await namedServices('service')) {
        const tasks = lines(
          await docker([
            'service',
            'ps',
            '--no-trunc',
            '--format',
            '{{json .}}',
            service,
          ])
        );
        // Keep orphaned or unreachable tasks reserved until the node can establish termination.
        const terminal =
          tasks.length > 0 &&
          tasks.every(({ CurrentState }) =>
            /^(Complete|Failed|Rejected)\b/.test(CurrentState)
          );
        workers.push({ id: service, state: terminal ? 'terminal' : 'live' });
      }
      return owned(workers);
    },
    async launch(pool, lease, ticket) {
      await docker(
        [
          'secret',
          'create',
          '--label',
          `${controllerLabel}=${owner}`,
          lease.id,
          '-',
        ],
        { input: ticket }
      );
      await docker(swarmWorkerArgs(node, pool, lease, owner));
    },
    async remove(lease, present) {
      if (present) {
        await docker(['service', 'rm', lease.id]);
      }
      if ((await namedServices('secret')).includes(lease.id)) {
        await docker(['secret', 'rm', lease.id]);
      }
    },
  };
}

function kubernetesBackend(node, owner, run, env) {
  const kubectl = (args, spec) =>
    run(
      'kubectl',
      ['--context', node.context, '--namespace', node.namespace, ...args],
      {
        env,
        maxMs: 12000,
        input: spec && JSON.stringify(spec),
      }
    );
  const create = (spec) => kubectl(['create', '-f', '-'], spec);
  return {
    async inspect() {
      const entry = JSON.parse(
        await kubectl(['get', 'node', node.target, '-o', 'json'])
      );
      requireValue(
        entry.metadata?.uid === node.identity &&
          entry.status?.conditions?.some(
            ({ type, status }) => type === 'Ready' && status === 'True'
          ),
        'Kubernetes node is unavailable or mismatched'
      );
      checkLinuxNode(
        entry.status.nodeInfo?.operatingSystem,
        entry.status.nodeInfo?.architecture,
        node
      );
      return entry;
    },
    ready(pool, entry, sample) {
      probeContainment(sample, pool);
      requireValue(
        !entry.spec?.unschedulable &&
          entry.metadata.labels?.[kubeNodeLabel] === node.identity,
        'Kubernetes node is unschedulable or lacks its protected UID label'
      );
      requireValue(
        ['MemoryPressure', 'DiskPressure', 'PIDPressure'].every((kind) =>
          entry.status.conditions.some(
            ({ type, status }) => type === kind && status === 'False'
          )
        ),
        'Kubernetes node reports resource pressure or lacks pressure conditions'
      );
      requireValue(
        entry.status.images?.some(({ names }) => names.includes(pool.image)),
        'Kubernetes did not report the pinned worker image on this node'
      );
    },
    async list() {
      const { items } = JSON.parse(
        await kubectl(['get', 'pods', '-l', controllerLabel, '-o', 'json'])
      );
      return owned(
        items.map((pod) => ({
          id: pod.metadata.name,
          state: ['Succeeded', 'Failed'].includes(pod.status?.phase)
            ? 'terminal'
            : 'live',
          target: pod.spec.nodeName,
        }))
      );
    },
    async launch(pool, lease, ticket) {
      await create(kubeSecret(lease, owner, ticket));
      await create(kubeWorker(node, pool, lease, owner));
    },
    async remove(lease, present) {
      if (present) {
        await kubectl(['delete', 'pod', lease.id, '--ignore-not-found']);
      }
      await kubectl(['delete', 'secret', lease.id, '--ignore-not-found']);
    },
  };
}

function nativeBackend(node, owner, run, env) {
  const [program, ...args] = node.adapter;
  async function invoke(operation, data) {
    const response = JSON.parse(
      await run(program, [...args, operation], {
        env,
        input: JSON.stringify({
          version: 1,
          owner,
          node: node.identity,
          ...data,
        }),
        maxMs: 12000,
      })
    );
    requireValue(
      response?.version === 1 && response.identity === node.identity,
      'Native adapter identity mismatch'
    );
    return response;
  }
  return {
    async inspect() {
      const entry = await invoke('inspect');
      requireValue(
        entry.os === node.os &&
          entry.arch === node.arch &&
          entry.native === true &&
          (node.os !== 'darwin' || entry.appleHost === true) &&
          ['cpu', 'memory', 'filesystems', 'process-tree'].every((key) =>
            entry.hardLimits?.includes(key)
          ),
        'Native adapter does not confirm OS, architecture and whole-worker containment'
      );
      return entry;
    },
    ready(pool, entry) {
      requireValue(
        entry.templates?.includes(pool.image),
        'Native worker template is unavailable'
      );
    },
    async list() {
      return owned((await invoke('list')).workers);
    },
    async launch(pool, lease, ticket) {
      await invoke('launch', {
        lease: lease.id,
        template: pool.image,
        platform: pool.platform,
        origin: pool.origin,
        ticket,
        limits: pool.limits,
      });
    },
    async remove(lease, present) {
      await invoke('remove', { lease: lease.id, present });
    },
  };
}

export function backendFor(node, owner, { run = runProcess, env, now }) {
  const backend = {
    docker: dockerBackend,
    swarm: swarmBackend,
    kubernetes: kubernetesBackend,
    native: nativeBackend,
  }[node.backend];
  return backend(node, owner, run, env, now);
}
