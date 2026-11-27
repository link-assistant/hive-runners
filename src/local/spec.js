export const controllerLabel = 'hive.local.controller';
export const kubeNodeLabel =
  'hive-runners.node-restriction.kubernetes.io/node-uid';

export function memoryLimit({ memoryMiB, diskMiB }) {
  return memoryMiB + diskMiB + 16;
}

export function workerEnv(pool) {
  return {
    HOME: '/hive',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: '/hive/.cache',
    XDG_RUNTIME_DIR: '/hive/.runtime',
    HIVE_PROVIDER: pool.platform,
    HIVE_PROJECT_ORIGIN: pool.origin,
  };
}

export function dockerWorkerArgs(node, pool, lease, owner) {
  const { cpuMillis, diskMiB } = pool.limits;
  const memory = `${memoryLimit(pool.limits)}m`;
  return [
    'create',
    '--pull=never',
    '--name',
    lease.id,
    '--label',
    `${controllerLabel}=${owner}`,
    '--platform',
    `linux/${node.arch}`,
    '--restart=no',
    '--read-only',
    '--cpus',
    String(cpuMillis / 1000),
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--pids-limit=512',
    '--ipc=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--log-driver=none',
    '--init',
    '--user=1000:1000',
    '--workdir=/hive',
    '--tmpfs',
    `/hive:rw,nosuid,nodev,exec,uid=1000,gid=1000,mode=0700,size=${diskMiB}m`,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,exec,mode=1777,size=16m',
    ...Object.entries(workerEnv(pool)).flatMap(([name, value]) => [
      '--env',
      `${name}=${value}`,
    ]),
    '--env',
    'HIVE_WORKER_TICKET',
    '--entrypoint=/opt/hive-worker',
    pool.image,
  ];
}

export function swarmWorkerArgs(node, pool, lease, owner) {
  const { cpuMillis, diskMiB } = pool.limits;
  const memory = `${memoryLimit(pool.limits)}m`;
  return [
    'service',
    'create',
    '--detach=true',
    '--name',
    lease.id,
    '--label',
    `${controllerLabel}=${owner}`,
    '--no-resolve-image',
    '--constraint',
    `node.id==${node.identity}`,
    '--replicas=1',
    '--restart-condition=none',
    '--read-only',
    '--limit-pids=512',
    '--limit-cpu',
    String(cpuMillis / 1000),
    '--reserve-cpu',
    String(cpuMillis / 1000),
    '--limit-memory',
    memory,
    '--reserve-memory',
    memory,
    '--cap-drop=ALL',
    '--log-driver=none',
    '--init',
    '--user=1000:1000',
    '--workdir=/hive',
    '--mount',
    `type=tmpfs,dst=/hive,tmpfs-size=${diskMiB * 1024 ** 2},tmpfs-mode=1777`,
    '--mount',
    'type=tmpfs,dst=/tmp,tmpfs-size=8388608,tmpfs-mode=1777',
    '--mount',
    'type=tmpfs,dst=/dev/shm,tmpfs-size=8388608,tmpfs-mode=1777',
    ...Object.entries(workerEnv(pool)).flatMap(([name, value]) => [
      '--env',
      `${name}=${value}`,
    ]),
    '--secret',
    `source=${lease.id},target=hive-ticket,uid=1000,gid=1000,mode=0400`,
    '--entrypoint=/opt/hive-worker',
    pool.image,
  ];
}

function metadata(name, owner) {
  return { name, labels: { [controllerLabel]: owner } };
}

export function kubeSecret(lease, owner, ticket) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: metadata(lease.id, owner),
    type: 'Opaque',
    stringData: { ticket },
  };
}

export function kubeWorker(node, pool, lease, owner) {
  const limits = {
    cpu: `${pool.limits.cpuMillis}m`,
    memory: `${memoryLimit(pool.limits)}Mi`,
    'ephemeral-storage': '32Mi',
  };
  const ephemeral = [
    ['workspace', '/hive', pool.limits.diskMiB],
    ['temporary', '/tmp', 8],
    ['shared-memory', '/dev/shm', 8],
  ];
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: metadata(lease.id, owner),
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      nodeSelector: {
        'kubernetes.io/os': 'linux',
        'kubernetes.io/arch': node.arch,
        [kubeNodeLabel]: node.identity,
      },
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
              {
                matchFields: [
                  {
                    key: 'metadata.name',
                    operator: 'In',
                    values: [node.target],
                  },
                ],
              },
            ],
          },
        },
      },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'worker',
          image: pool.image,
          imagePullPolicy: 'Never',
          command: ['/opt/hive-worker'],
          workingDir: '/hive',
          // Kubelet mounts a writable host file here. The worker cannot traverse /root.
          terminationMessagePath: '/root/hive-termination-log',
          env: Object.entries(workerEnv(pool)).map(([name, value]) => ({
            name,
            value,
          })),
          resources: { limits, requests: limits },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [
            ...ephemeral.map(([name, mountPath]) => ({ name, mountPath })),
            { name: 'ticket', mountPath: '/run/secrets', readOnly: true },
          ],
        },
      ],
      volumes: [
        ...ephemeral.map(([name, , size]) => ({
          name,
          emptyDir: { medium: 'Memory', sizeLimit: `${size}Mi` },
        })),
        {
          name: 'ticket',
          secret: {
            secretName: lease.id,
            defaultMode: 0o440,
            items: [{ key: 'ticket', path: 'hive-ticket' }],
          },
        },
      ],
    },
  };
}
