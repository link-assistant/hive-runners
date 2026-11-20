export * from './index.js';

export interface RunnerResources {
  cpuMillis: number;
  memoryMiB: number;
  diskMiB: number;
  gpus: number;
}

export type HostHardware = Omit<RunnerResources, 'gpus'> & { gpus?: number };

export interface ProviderConfig {
  type: 'contabo' | 'hetzner';
  maxMachines?: number;
  tokenPrefix?: string;
  region: string;
  product: string;
  image: string;
  sshKeys: string[];
  monthlyCents: number;
  hardware?: HostHardware;
}

export interface PoolConfig {
  platform?: 'github' | 'gitlab';
  scope: string;
  gitlabUrl?: string;
  gitlabScopeType?: 'project' | 'group';
  gitlabRunnerId?: number;
  gitlabChartVersion?: string;
  gitlabEgressIPv4?: string[];
  gitlabCAEnv?: string;
  label?: string;
  provider?: string | null;
  maxMachines?: number;
  minMachines?: number;
  terraformMachines?: number;
  capacity?: number;
  warmRunners?: number;
  idleSeconds?: number;
  credentialsEnv?: string;
  groupTokenEnv?: string;
  webhookSecretEnv?: string;
  cpus?: number;
  memoryMiB?: number;
  diskMiB?: number;
  isolation?: 'machine' | 'job';
  job?: Partial<RunnerResources>;
  arcVersion?: string;
  containerMode?: 'process' | 'kubernetes-novolume' | 'dind';
  runnerImage?: string;
  selectedRepositories?: string[];
  spareHost?: {
    ip: string;
    user?: string;
    hostKey: string;
    hardware?: HostHardware;
  };
}

type NormalizedPool = Required<
  Omit<
    PoolConfig,
    | 'gitlabUrl'
    | 'gitlabScopeType'
    | 'gitlabRunnerId'
    | 'gitlabChartVersion'
    | 'gitlabEgressIPv4'
    | 'gitlabCAEnv'
    | 'spareHost'
    | 'job'
  >
> &
  Pick<
    PoolConfig,
    | 'gitlabUrl'
    | 'gitlabScopeType'
    | 'gitlabRunnerId'
    | 'gitlabChartVersion'
    | 'gitlabEgressIPv4'
    | 'gitlabCAEnv'
    | 'spareHost'
  > & { profile: string; job: RunnerResources };

type NormalizedProvider = Required<Omit<ProviderConfig, 'hardware'>> & {
  hardware?: RunnerResources;
};

export interface AccountConfig {
  pool: string;
  keyEnv: string;
  rate: number;
  initialCredit?: number;
  upstreams?: {
    origin: string;
    keyEnv: string;
    maxRate: number;
    notation?: 'lino' | 'json';
  }[];
}

export interface HiveConfig {
  version: 1;
  prefix?: string;
  providers?: Record<string, ProviderConfig>;
  pools?: Record<string, PoolConfig>;
  accounts?: Record<string, AccountConfig>;
}

export interface MachineTarget {
  ip: string;
  user?: string;
  group?: string;
  knownHosts?: string;
  minimum?: RunnerResources;
}

type Environment = Record<string, string | undefined>;
type Run = (
  program: string,
  args: string[],
  options?: { cwd?: string; env?: Environment; input?: string; maxMs?: number }
) => Promise<string>;
type FetchOptions = { env?: Environment; fetcher?: typeof fetch };
type RunnerMetrics = {
  runners: number;
  availableMemoryMiB: number;
  availableDiskMiB: number;
  load1: number;
};
type RunnerHost = (
  pool: NormalizedPool,
  machine: MachineTarget,
  operation?: 'deploy' | 'deploy-drained' | 'inspect' | 'drain' | 'park'
) => Promise<RunnerMetrics | null>;
type Machine = {
  id: string;
  name: string;
  ip?: string;
  status: string;
  cancelDate?: string;
};

export declare function validateConfig(input: unknown): {
  version: 1;
  prefix: string;
  providers: Record<string, NormalizedProvider>;
  pools: Record<string, NormalizedPool>;
  accounts: Record<string, Required<AccountConfig>>;
};
export declare function loadConfig(
  path: string
): Promise<ReturnType<typeof validateConfig>>;
export declare function githubClient(
  token: string,
  fetcher?: typeof fetch
): {
  requirePrivateRepo(scope: string): Promise<{ id: number; private: true }>;
  ensureGroup(
    org: string,
    name: string,
    repositories: string[]
  ): Promise<Record<string, unknown>>;
  listRunners(scope: string): Promise<Record<string, unknown>[]>;
  listGroups(org: string): Promise<Record<string, unknown>[]>;
  setLabels(
    scope: string,
    id: number,
    labels: string[]
  ): Promise<Record<string, unknown>>;
};
export declare function githubToken(
  env?: Environment,
  name?: string,
  run?: Run
): Promise<string>;
type GitLabScope = 'project' | 'group';
export declare function gitlabClient(
  origin: string,
  token: string,
  fetcher?: typeof fetch
): {
  privateScope(
    scope: string,
    type: GitLabScope
  ): Promise<{ id: number; visibility: 'private' }>;
  listRunners(
    scope: string,
    type?: GitLabScope
  ): Promise<Record<string, unknown>[]>;
  runner(id: number): Promise<Record<string, unknown>>;
  job(scope: string, id: number): Promise<Record<string, unknown>>;
  listProjects(scope: string): Promise<Record<string, unknown>[]>;
  verify(token: string, instance: string): Promise<{ id: number }>;
  createRunner(
    scope: string,
    type: GitLabScope,
    label: string
  ): Promise<{ id: number; token: string }>;
  configureRunner(id: number, label: string): Promise<Record<string, unknown>>;
};
export declare function providerClient(
  config: NormalizedProvider,
  options?: FetchOptions
): {
  list(): Promise<Machine[]>;
  create(name: string, userData: string, requestId: string): Promise<Machine>;
  retire(machine: Machine): Promise<void>;
};
export declare function arcValues(
  pool: NormalizedPool,
  group?: string,
  drained?: boolean
): Record<string, unknown>;
export declare function gitlabValues(
  pool: NormalizedPool,
  drained?: boolean
): Record<string, unknown>;
export declare function runnerHost(
  options?: FetchOptions & { run?: Run }
): RunnerHost;
export declare const arcHost: typeof runnerHost;
export declare function capacityPlan(config: HiveConfig): Record<
  string,
  {
    job: RunnerResources;
    runnersPerMachine: number;
    minimum: RunnerResources;
    recommended: RunnerResources;
  }
>;
export declare function capacityPlan(
  config: HiveConfig,
  sharedPools: string[]
): { minimum: RunnerResources; recommended: RunnerResources };
export declare function terraformPlan(
  config: HiveConfig
): Record<string, unknown>;
export declare function renderInfrastructure(
  config: HiveConfig,
  directory: string
): Promise<string[]>;
export declare function deploy(
  config: HiveConfig,
  options: {
    directory?: string;
    inventory?: Record<
      string,
      Omit<MachineTarget, 'group' | 'minimum'> & {
        pool: string;
        hardware?: HostHardware;
      }
    >;
    apply?: boolean;
    env?: Environment;
    fetcher?: typeof fetch;
    run?: Run;
    host?: RunnerHost;
  }
): Promise<number>;
export declare function propose(
  config: HiveConfig,
  options?: { cwd?: string; base?: string; branch?: string; run?: Run }
): Promise<string>;
export declare function runHiveCli(
  argv: string[],
  options?: FetchOptions & {
    run?: Run;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  }
): Promise<number>;
export declare function cliReference(): string;
export interface RunnerActivation {
  expires: number;
  route: 'local' | 'upstream';
  wholesale: boolean;
  rate?: number;
  maxCents?: number;
  profile?: RunnerProfile;
  capacity?: number;
}
export interface RunnerProfile extends RunnerResources {
  platform: 'github' | 'gitlab';
  origin: string;
  mode: NonNullable<PoolConfig['containerMode']>;
  isolation: NonNullable<PoolConfig['isolation']>;
  runnerId?: number;
}
export interface RunnerOffer {
  scope: string;
  label: string;
  capacity: number;
  profile: RunnerProfile;
  rate: number;
  currency: 'usd';
  available: boolean;
  activation: RunnerActivation | null;
  draining: boolean;
  credit: number;
  checkoutEnabled: boolean;
}
export declare function runnerAccount(
  origin: string,
  key: string,
  options?: { fetcher?: typeof fetch; notation?: boolean }
): {
  offer(): Promise<RunnerOffer>;
  activate(
    minutes: number,
    options?: { maxCents?: number; offer?: RunnerOffer }
  ): Promise<RunnerActivation>;
  stop(): Promise<{ active: false; draining: boolean }>;
  checkout(amount: number, requestId: string): Promise<{ url: string }>;
};
export declare function serve(
  config: HiveConfig,
  options?: { env?: Environment; state?: string; port?: number; host?: string }
): Promise<import('node:http').Server>;
export declare function migrateState(
  source: string,
  destination: string
): Promise<string>;
