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
async function command(program, args) {
  try {
    const { stdout } = await execute(program, args, {
      maxBuffer: 1024 * 1024,
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
  const leases = ['a', 'b'].map((suffixPart) => ({
    id: `hive-${suffix}-${suffixPart}`,
  }));
  const ticketPath = join(directory, 'ticket');
  try {
    await writeFile(ticketPath, ticket, { mode: 0o600 });
    const identity = await docker(['info', '--format', '{{.Swarm.NodeID}}']);
    const target = await docker([
      'node',
      'inspect',
      identity,
      '--format',
      '{{.Description.Hostname}}',
    ]);
    for (const lease of leases) {
      await docker(['secret', 'create', lease.id, ticketPath]);
      await docker(swarmWorkerArgs({ arch, identity }, pool, lease, suffix));
    }
    for (const lease of leases) {
      let complete = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const rows = await docker([
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
    console.log('Two bounded Swarm tasks completed on their pinned node');
  } finally {
    await docker(['swarm', 'leave', '--force']);
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
    const { items } = JSON.parse(await kubectl(['get', 'nodes', '-o', 'json']));
    assert.equal(items.length, 2);
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
      'Two bounded Kubernetes pods completed on their respective pinned kind nodes'
    );
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

const exercise = { swarm, kind }[process.argv[2]];
assert.ok(exercise, 'Expected swarm or kind');
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
