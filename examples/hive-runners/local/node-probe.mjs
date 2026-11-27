import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { runProcess } from '../../../src/process.js';
import { hostSample } from '../../../src/local/telemetry.js';

// Run under the trusted node operator on the physical runtime host. This
// assumes cgroup v2, configured Kubernetes cgroups, and tested tmpfs mounts.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!['swarm', 'kubernetes'].includes(config.backend)) {
  throw new Error('Expected a Swarm or Kubernetes node probe');
}
const input = [];
for await (const chunk of process.stdin) {
  input.push(chunk);
}
const { nonce } = JSON.parse(Buffer.concat(input).toString('utf8'));
const runtime =
  config.backend === 'swarm'
    ? JSON.parse(
        await runProcess('docker', ['info', '--format', '{{json .}}'], {
          maxMs: 2000,
        })
      )
    : JSON.parse(
        await runProcess(
          'kubectl',
          [
            '--context',
            config.context,
            'get',
            'node',
            config.node,
            '-o',
            'json',
          ],
          { maxMs: 2000 }
        )
      );
const runtimeIdentity =
  config.backend === 'swarm' ? runtime.Swarm.NodeID : runtime.metadata.uid;
if (
  !runtimeIdentity ||
  (config.backend === 'swarm'
    ? runtime.Name
    : runtime.status.addresses.find(({ type }) => type === 'Hostname')
        ?.address) !== hostname()
) {
  throw new Error('Runtime node does not match the host running the probe');
}
const sample = await hostSample(config.storage, nonce);
const [controllers, swaps] = await Promise.all([
  readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8'),
  readFile('/proc/swaps', 'utf8'),
]);
const cgroup = new Set(controllers.split(/\s+/));
const images = [];
for (const image of config.images) {
  if (config.backend === 'swarm') {
    const [record] = JSON.parse(
      await runProcess('docker', ['image', 'inspect', image], { maxMs: 2000 })
    );
    if (
      !record.RepoDigests.includes(image) ||
      Object.keys(record.Config.Volumes ?? {}).length
    ) {
      throw new Error('Expected a preloaded digest with no declared volumes');
    }
  } else if (
    !runtime.status.images?.some(({ names }) => names.includes(image))
  ) {
    throw new Error('Expected a preloaded image on the Kubernetes node');
  }
  images.push(image);
}
console.log(
  JSON.stringify({
    ...sample,
    runtimeIdentity,
    checks: {
      cgroupV2: true,
      cpuLimits:
        cgroup.has('cpu') &&
        (config.backend === 'swarm'
          ? runtime.CpuCfsQuota === true
          : config.cpuLimitsVerified === true),
      memoryLimits:
        cgroup.has('memory') &&
        (config.backend === 'swarm'
          ? runtime.MemoryLimit === true
          : config.memoryLimitsVerified === true),
      workspaceLimits:
        config.workspaceLimitsVerified === true && cgroup.has('pids'),
      swapDisabled: swaps.trim().split('\n').length === 1,
      images,
    },
  })
);
