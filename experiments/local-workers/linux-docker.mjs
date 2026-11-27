import { strict as assert } from 'node:assert';
import { URL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { runProcess } from '../../src/process.js';
import { dockerWorkerArgs } from '../../src/local/spec.js';
import { probeDockerContext } from '../../src/local/telemetry.js';

const suffix = randomBytes(6).toString('hex');
const image = `hive-local-pressure:${suffix}`;
const nodes = ['a', 'b'].map((name) => ({
  id: `hive-pressure-${suffix}-${name}`,
}));
const monitor =
  'alpine@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2';
const docker = (args, maxMs = 12000) => runProcess('docker', args, { maxMs });

try {
  await docker(['pull', monitor], 60000);
  const info = await probeDockerContext('default', monitor, runProcess, {
    env: process.env,
  });
  assert.equal(info.os, 'linux');
  assert.ok(info.sample.resources.cpu.total > 0);
  assert.ok(info.sample.resources.memory.total > 0);
  assert.ok(info.sample.resources['fs-build'].total > 0);
  await docker(
    ['build', '-t', image, fileURLToPath(new URL('.', import.meta.url))],
    60000
  );
  for (const lease of nodes) {
    await docker(
      dockerWorkerArgs(
        { arch: process.arch === 'arm64' ? 'arm64' : 'amd64' },
        {
          platform: 'github',
          origin: 'https://github.com',
          image,
          limits: { cpuMillis: 200, memoryMiB: 128, diskMiB: 64 },
        },
        lease,
        suffix
      )
    );
  }
  await docker(['start', ...nodes.map(({ id }) => id)]);
  for (const { id } of nodes) {
    assert.equal(
      (await docker(['wait', id])).trim(),
      '0',
      `Bounded containment probe ${id} exit status`
    );
  }
  console.log(
    'Docker sampled the engine and ran two bounded CPU, memory and filesystem probes'
  );
} finally {
  await Promise.allSettled(nodes.map(({ id }) => docker(['rm', '-f', id])));
  await Promise.allSettled([docker(['image', 'rm', image])]);
}
