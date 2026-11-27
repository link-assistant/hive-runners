import { randomUUID } from 'node:crypto';
import { stat, statfs, readFile, realpath } from 'node:fs/promises';
import { cpus, freemem, hostname, totalmem } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { integer, requireValue } from '../validation.js';

const mib = 1024 ** 2;
const cpuWindowMs = 500;

function idleCapacity(before, after, count) {
  const elapsed = after.total - before.total;
  const idle = after.idle - before.idle;
  requireValue(
    elapsed > 0 && idle >= 0 && idle <= elapsed && count >= 1,
    'Invalid CPU counters'
  );
  return {
    total: count * 1000,
    available: Math.floor((idle / elapsed) * count * 1000),
  };
}

function cpuTimes() {
  const cores = cpus();
  const times = cores.reduce(
    (result, { times }) => ({
      total:
        result.total +
        times.user +
        times.nice +
        times.sys +
        times.idle +
        times.irq,
      idle: result.idle + times.idle,
    }),
    { total: 0, idle: 0 }
  );
  return { ...times, count: cores.length };
}

async function localMemory() {
  const total = totalmem();
  const available =
    process.platform === 'linux'
      ? Number(
          /^MemAvailable:\s+(\d+) kB$/m.exec(
            await readFile('/proc/meminfo', 'utf8')
          )?.[1]
        ) * 1024
      : freemem();
  const constrained = process.constrainedMemory?.();
  const usable = process.availableMemory?.();
  return {
    total: Math.floor(Math.min(total, constrained || total) / mib),
    available: Math.floor(Math.min(available, usable ?? available) / mib),
  };
}

async function localDisk(path) {
  const resolved = await realpath(path);
  const [{ dev }, fs] = await Promise.all([
    stat(resolved),
    statfs(resolved, { bigint: true }),
  ]);
  return {
    identity: `fs:${dev}:${fs.type}`,
    total: Number((fs.blocks * fs.bsize) / BigInt(mib)),
    available: Number((fs.bavail * fs.bsize) / BigInt(mib)),
  };
}

export async function hostSample(paths, nonce) {
  const before = cpuTimes();
  await wait(cpuWindowMs);
  const after = cpuTimes();
  requireValue(
    before.count === after.count,
    'CPU count changed while sampling'
  );
  const identity = `host:${hostname()}`;
  const [memory, storage] = await Promise.all([
    localMemory(),
    Promise.all(
      Object.entries(paths).map(async ([key, path]) => [
        key,
        await localDisk(path),
      ])
    ),
  ]);
  return {
    identity,
    nonce,
    observedAt: Date.now(),
    resources: {
      cpu: { identity, ...idleCapacity(before, after, before.count) },
      memory: { identity, ...memory },
      ...Object.fromEntries(storage),
    },
  };
}

// The daemon supplies the bind source and the immutable monitor supplies the readings.
const engineProbe = `
set -eu
test -r /sys/fs/cgroup/cpu.max
test -r /sys/fs/cgroup/memory.max
test -r /sys/fs/cgroup/memory.swap.max
head -n 1 /proc/stat
sleep 0.5
head -n 1 /proc/stat
awk '/^MemAvailable:/ { print $2 }' /proc/meminfo
stat -c %d /engine
df -Pk /engine | tail -1 | awk '{print $2, $4}'
`;

function parseCPU(line) {
  const [name, ...fields] = line.trim().split(/\s+/);
  requireValue(
    name === 'cpu' &&
      fields.length >= 8 &&
      fields.every((field) => /^\d+$/.test(field)),
    'Invalid Docker CPU telemetry'
  );
  const counters = fields.slice(0, 8).map(Number);
  return {
    total: counters.reduce((sum, value) => sum + value, 0),
    idle: counters[3],
  };
}

export async function dockerSample(node, scoped, docker, info, now) {
  requireValue(
    info.CgroupVersion === '2' &&
      info.CpuCfsQuota === true &&
      info.MemoryLimit === true &&
      info.SwapLimit === true &&
      info.PidsLimit === true,
    'Docker engine lacks required CPU, memory, swap or PID limits'
  );
  requireValue(
    typeof info.DockerRootDir === 'string' &&
      /^\/[^,\r\n]+$/.test(info.DockerRootDir),
    'Invalid Docker data root'
  );
  const storage = Object.keys(scoped.resources).filter((key) =>
    key.startsWith('fs-')
  );
  requireValue(
    storage.length === 1,
    'Built-in Docker monitor measures the engine data filesystem'
  );
  const [first, last, memory, device, blocks, extra] = (
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--cpus=0.125',
      '--memory=32m',
      '--memory-swap=32m',
      '--pids-limit=32',
      '--mount',
      `type=bind,src=${info.DockerRootDir},dst=/engine,readonly,bind-recursive=disabled`,
      '--entrypoint=/bin/sh',
      node.monitorImage,
      '-c',
      engineProbe,
    ])
  )
    .trim()
    .split('\n');
  requireValue(
    !extra &&
      /^\d+$/.test(memory) &&
      /^\d+$/.test(device) &&
      /^\d+ \d+$/.test(blocks),
    'Invalid Docker memory or storage telemetry'
  );
  const [total, available] = blocks
    .split(' ')
    .map((value) => Math.floor(Number(value) / 1024));
  const identity = `docker:${info.ID}`;
  return {
    identity,
    observedAt: now(),
    resources: {
      cpu: {
        identity,
        ...idleCapacity(
          parseCPU(first),
          parseCPU(last),
          integer(info.NCPU, 1, 1024, 'Docker CPU count')
        ),
      },
      memory: {
        identity,
        total: Math.floor(info.MemTotal / mib),
        available: Math.floor(Number(memory) / 1024),
      },
      [storage[0]]: { identity: `fs:${device}`, total, available },
    },
  };
}

export async function commandSample(scope, leases, run, env = {}) {
  const nonce = randomUUID();
  const [program, ...args] = scope.probe;
  const result = JSON.parse(
    await run(program, args, {
      env,
      input: JSON.stringify({ nonce, leases }),
      maxMs: 3500,
    })
  );
  requireValue(
    result?.nonce === nonce,
    'Probe returned stale or unbound telemetry'
  );
  return result;
}

export async function probeDockerContext(
  context,
  monitorImage,
  run,
  { env, now = Date.now } = {}
) {
  requireValue(
    /^[a-z0-9][a-z0-9.-]{0,62}$/.test(context) &&
      /^[a-z0-9][a-z0-9./_:-]+@sha256:[a-f0-9]{64}$/.test(monitorImage),
    'Pass a Docker context and a preloaded monitor image digest'
  );
  const runtimeEnv = { ...env };
  delete runtimeEnv.DOCKER_HOST;
  delete runtimeEnv.DOCKER_CONTEXT;
  delete runtimeEnv.DOCKER_API_VERSION;
  const docker = (args) =>
    run('docker', ['--context', context, ...args], {
      env: runtimeEnv,
      maxMs: 12000,
    });
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
  requireValue(
    info.OSType === 'linux' && typeof info.ID === 'string' && info.ID,
    'Expected an identified Docker engine in Linux-container mode'
  );
  const sample = await dockerSample(
    { monitorImage },
    { resources: { 'fs-build': null } },
    docker,
    info,
    now
  );
  return {
    engine: info.ID,
    os: info.OSType,
    architecture: info.Architecture,
    sample,
  };
}
