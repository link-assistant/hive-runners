import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  kubeNodeLabel,
  kubeSecret,
  kubeWorker,
  swarmWorkerArgs,
} from '../../src/local/spec.js';

const execute = promisify(execFile);
async function command(program, args, options = {}) {
  try {
    const { stdout } = await execute(program, args, {
      maxBuffer: 1024 * 1024,
      ...options,
    });
    return stdout.trim();
  } catch (error) {
    console.error(error.stderr?.trim());
    throw error;
  }
}

const suffix = randomBytes(6).toString('hex');
const image = `hive-local-pressure:${suffix}`;
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const pool = {
  image,
  platform: 'github',
  origin: 'https://github.com',
  limits: { cpuMillis: 200, memoryMiB: 128, diskMiB: 64 },
};
const ticket = 'fixture-ticket';
const docker = (args) => command('docker', ['--context', 'default', ...args]);

async function swarm(directory) {
  assert.equal(
    await docker(['info', '--format', '{{.Swarm.LocalNodeState}}']),
    'inactive',
    'The Swarm smoke requires a disposable Docker Engine'
  );
  await docker(['swarm', 'init', '--advertise-addr', '127.0.0.1']);
  try {
    const identity = await docker(['info', '--format', '{{.Swarm.NodeID}}']);
    const target = await docker([
      'node',
      'inspect',
      identity,
      '--format',
      '{{.Description.Hostname}}',
    ]);
    const ticketPath = join(directory, 'ticket');
    await writeFile(ticketPath, ticket, { mode: 0o600 });
    await swarmWorkers(
      docker,
      [
        { identity, target },
        { identity, target },
      ],
      ticketPath
    );
  } finally {
    await docker(['swarm', 'leave', '--force']);
  }
}

async function swarmWorkers(manager, nodes, ticketPath) {
  const placements = [];
  for (const [index, { identity, target }] of nodes.entries()) {
    const lease = { id: `hive-${suffix}-${index}` };
    await manager(['secret', 'create', lease.id, ticketPath]);
    await manager(swarmWorkerArgs({ arch, identity }, pool, lease, suffix));
    placements.push({ lease, target });
  }
  for (const { lease, target } of placements) {
    let complete = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const rows = await manager([
        'service',
        'ps',
        '--no-trunc',
        '--format',
        '{{json .}}',
        lease.id,
      ]);
      const task = rows && JSON.parse(rows);
      if (/^(Failed|Rejected)\b/.test(task?.CurrentState)) {
        throw new Error(`${lease.id} on ${task.Node}: ${task.Error}`);
      }
      if (/^Complete\b/.test(task?.CurrentState)) {
        assert.equal(task.Node, target);
        complete = true;
        break;
      }
      await wait(1000);
    }
    assert.ok(complete, `${lease.id} did not finish on ${target}`);
  }
  console.log(
    `Bounded Swarm tasks completed on ${placements.map(({ target }) => target).join(', ')}`
  );
}

async function distributedSwarm(directory) {
  const network = `hive-${suffix}`;
  const nodes = [`${network}-manager`, `${network}-worker`];
  const [managerName, workerName] = nodes;
  const dind =
    'docker:28.5.2-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac';
  const inside = (node, args) => docker(['exec', node, 'docker', ...args]);
  const manager = (args) => inside(managerName, args);
  const archive = join(directory, 'image.tar');
  const ticketPath = join(directory, 'ticket');
  await docker(['network', 'create', network]);
  try {
    await docker(['save', '-o', archive, image]);
    await writeFile(ticketPath, ticket, { mode: 0o600 });
    for (const node of nodes) {
      await docker([
        'run',
        '-d',
        '--privileged',
        '--name',
        node,
        '--hostname',
        node,
        '--network',
        network,
        '--mount',
        `type=bind,source=${directory},target=/hive-fixture,readonly`,
        dind,
        'dockerd',
        '--host=unix:///var/run/docker.sock',
      ]);
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (
          await inside(node, ['info', '--format', '{{.ServerVersion}}']).catch(
            () => ''
          )
        ) {
          ready = true;
          break;
        }
        await wait(1000);
      }
      assert.ok(ready, `Fixture Docker Engine ${node} did not start`);
      await inside(node, ['load', '-i', '/hive-fixture/image.tar']);
    }
    const ip = await docker([
      'inspect',
      managerName,
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    ]);
    await manager(['swarm', 'init', '--advertise-addr', ip]);
    const token = await manager(['swarm', 'join-token', '-q', 'worker']);
    await inside(workerName, ['swarm', 'join', '--token', token, `${ip}:2377`]);
    const placements = [];
    for (const target of nodes) {
      const identity = await inside(target, [
        'info',
        '--format',
        '{{.Swarm.NodeID}}',
      ]);
      assert.ok(identity, `Missing Swarm node ID on ${target}`);
      placements.push({ target, identity });
    }
    assert.notEqual(placements[0].identity, placements[1].identity);
    await swarmWorkers(manager, placements, '/hive-fixture/ticket');
  } finally {
    await Promise.allSettled(
      nodes.map((node) => docker(['rm', '-f', '-v', node]))
    );
    await docker(['network', 'rm', network]);
  }
}

async function kind(directory) {
  const cluster = `hive-${suffix}`;
  const configFile = join(directory, 'kind.json');
  const kubeconfig = join(directory, 'kubeconfig');
  const kindCmd = (args) => command('kind', args);
  const kubectl = (args) =>
    command('kubectl', ['--kubeconfig', kubeconfig, ...args]);
  await writeFile(
    configFile,
    JSON.stringify({
      apiVersion: 'kind.x-k8s.io/v1alpha4',
      kind: 'Cluster',
      nodes: [{ role: 'control-plane' }, { role: 'worker' }],
    })
  );
  try {
    await kindCmd([
      'create',
      'cluster',
      '--name',
      cluster,
      '--config',
      configFile,
      '--kubeconfig',
      kubeconfig,
      '--wait',
      '60s',
      '--image',
      'kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f',
    ]);
    await kindCmd(['load', 'docker-image', image, '--name', cluster]);
    await kubectl([
      'taint',
      'node',
      `${cluster}-control-plane`,
      'node-role.kubernetes.io/control-plane:NoSchedule-',
    ]);
    await kubeWorkers(directory, kubectl, 2, 'kind');
  } finally {
    await kindCmd([
      'delete',
      'cluster',
      '--name',
      cluster,
      '--kubeconfig',
      kubeconfig,
    ]);
  }
}

async function minikube(directory) {
  const profile = `hive-${suffix}`;
  const kubeconfig = join(directory, 'kubeconfig');
  const env = {
    ...process.env,
    MINIKUBE_HOME: directory,
    KUBECONFIG: kubeconfig,
  };
  const minikubeCmd = (args) =>
    command('minikube', ['-p', profile, ...args], { env });
  const kubectl = (args) =>
    command('kubectl', ['--kubeconfig', kubeconfig, ...args]);
  try {
    await minikubeCmd([
      'start',
      '--driver=docker',
      '--listen-address=127.0.0.1',
      '--cpus=2',
      '--memory=2500',
      '--kubernetes-version=v1.35.0',
    ]);
    await minikubeCmd(['image', 'load', image]);
    await kubeWorkers(directory, kubectl, 1, 'Minikube');
  } finally {
    await minikubeCmd(['delete']);
  }
}

async function k3s(directory) {
  const cluster = `hive-${suffix}`;
  const kubeconfig = join(directory, 'kubeconfig');
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const k3dCmd = (args) => command('k3d', args, { env });
  const kubectl = (args) =>
    command('kubectl', ['--kubeconfig', kubeconfig, ...args]);
  try {
    await k3dCmd([
      'cluster',
      'create',
      cluster,
      '--kubeconfig-update-default=false',
      '--kubeconfig-switch-context=false',
      '--timeout=90s',
      '--api-port=127.0.0.1:6550',
      '--image=rancher/k3s:v1.35.0-k3s1@sha256:10464930d9bad0c06aef9830e84cd4019c24ed44d5eab594efb7416119097248',
      '--k3s-arg=--disable=traefik,servicelb,metrics-server@server:0',
    ]);
    await writeFile(kubeconfig, await k3dCmd(['kubeconfig', 'get', cluster]), {
      mode: 0o600,
    });
    await k3dCmd(['image', 'import', image, '--cluster', cluster]);
    await kubeWorkers(directory, kubectl, 1, 'k3s');
  } finally {
    await k3dCmd(['cluster', 'delete', cluster]);
  }
}

async function kubeWorkers(directory, kubectl, expectedNodes, distribution) {
  const { items } = JSON.parse(await kubectl(['get', 'nodes', '-o', 'json']));
  assert.equal(items.length, expectedNodes);
  const namespace = 'hive-smoke';
  await kubectl(['create', 'namespace', namespace]);
  await kubectl([
    'label',
    'namespace',
    namespace,
    'pod-security.kubernetes.io/enforce=restricted',
  ]);
  const placements = [];
  for (const [
    index,
    {
      metadata: { name: target, uid: identity },
    },
  ] of items.entries()) {
    const lease = { id: `hive-${suffix}-${index}` };
    await kubectl(['label', 'node', target, `${kubeNodeLabel}=${identity}`]);
    for (const spec of [
      kubeSecret(lease, suffix, ticket),
      kubeWorker({ arch, identity, target }, pool, lease, suffix),
    ]) {
      const file = join(directory, 'object.json');
      await writeFile(file, JSON.stringify(spec), { mode: 0o600 });
      await kubectl(['--namespace', namespace, 'create', '-f', file]);
    }
    placements.push({ lease, target });
  }
  for (const { lease, target } of placements) {
    let complete = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const pod = JSON.parse(
        await kubectl([
          '--namespace',
          namespace,
          'get',
          'pod',
          lease.id,
          '-o',
          'json',
        ])
      );
      assert.notEqual(
        pod.status.phase,
        'Failed',
        JSON.stringify(pod.status.containerStatuses)
      );
      if (pod.status.phase === 'Succeeded') {
        assert.equal(pod.spec.nodeName, target);
        complete = true;
        break;
      }
      await wait(1000);
    }
    assert.ok(complete, `${lease.id} did not finish on ${target}`);
  }
  console.log(
    `Bounded Kubernetes pods completed on ${distribution} nodes ${placements.map(({ target }) => target).join(', ')}`
  );
}

const exercise = {
  swarm,
  'swarm-distributed': distributedSwarm,
  kind,
  minikube,
  k3s,
}[process.argv[2]];
assert.ok(exercise, 'Expected swarm, swarm-distributed, kind, minikube or k3s');
const directory = await mkdtemp(join(tmpdir(), 'hive-orchestrator-smoke-'));
try {
  await docker([
    'build',
    '-t',
    image,
    fileURLToPath(new URL('.', import.meta.url)),
  ]);
  await exercise(directory);
} finally {
  await Promise.allSettled([
    docker(['image', 'rm', image]),
    rm(directory, { recursive: true, force: true }),
  ]);
}
