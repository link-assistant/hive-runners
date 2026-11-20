// CPU uses millicores, and memory and disk use binary MiB throughout.
export const resourceKeys = ['cpuMillis', 'memoryMiB', 'diskMiB', 'gpus'];

export function sumResources(items) {
  return Object.fromEntries(
    resourceKeys.map((key) => [
      key,
      items.reduce((total, item) => total + item[key], 0),
    ])
  );
}

export function fits(available, required) {
  return resourceKeys.every((key) => available[key] >= required[key]);
}

export function machineResources(pool) {
  return {
    cpuMillis: pool.cpus * 1000,
    memoryMiB: pool.memoryMiB,
    diskMiB: pool.diskMiB,
    gpus: pool.job.gpus * pool.capacity,
  };
}

export function sizing(pools) {
  const cluster = sumResources(pools.map(machineResources));
  const minimum = sumResources([
    cluster,
    { cpuMillis: 1000, memoryMiB: 1024, diskMiB: 4096, gpus: 0 },
  ]);
  const recommended = {
    cpuMillis: Math.max(6000, minimum.cpuMillis + 1000),
    memoryMiB: Math.max(12288, minimum.memoryMiB + 2048),
    diskMiB: Math.max(204800, minimum.diskMiB + 8192),
    gpus: minimum.gpus,
  };
  return { minimum, recommended };
}

export function jobOverhead(containerMode, platform) {
  // Budget for GitLab helpers and Kubernetes runner managers, and reserve
  // room for service containers. The admission limits also cover sidecars.
  return platform === 'gitlab' || containerMode !== 'process'
    ? { cpuMillis: 300, memoryMiB: 448, diskMiB: 768, gpus: 0 }
    : { cpuMillis: 0, memoryMiB: 0, diskMiB: 0, gpus: 0 };
}

export function k8sResources(job) {
  const quantities = {
    cpu: `${job.cpuMillis}m`,
    memory: `${job.memoryMiB}Mi`,
    'ephemeral-storage': `${job.diskMiB}Mi`,
    ...(job.gpus ? { 'nvidia.com/gpu': String(job.gpus) } : {}),
  };
  return { requests: quantities, limits: { ...quantities } };
}

export function offerProfile(pool) {
  return {
    platform: pool.platform,
    origin: pool.gitlabUrl ?? 'https://github.com',
    mode: pool.containerMode,
    isolation: pool.isolation,
    ...pool.job,
    ...(pool.platform === 'gitlab' ? { runnerId: pool.gitlabRunnerId } : {}),
  };
}

export function sameOfferProfile(provided, expected) {
  return (
    provided !== null &&
    typeof provided === 'object' &&
    Object.keys(provided).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => provided[key] === value)
  );
}

export function allocation(pool) {
  return JSON.stringify([
    pool.profile,
    pool.cpus,
    pool.memoryMiB,
    pool.diskMiB,
    pool.capacity,
    pool.runnerImage,
    offerProfile(pool),
  ]);
}
