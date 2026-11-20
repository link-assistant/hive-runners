export * from './index.js';

export interface ProviderConfig {
  type: 'contabo' | 'hetzner';
  maxMachines?: number;
  tokenPrefix?: string;
  region: string;
  product: string;
  image: string;
  sshKeys: string[];
  monthlyCents: number;
}

export interface PoolConfig {
  scope: string;
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
  arcVersion?: string;
  containerMode?: 'process' | 'kubernetes-novolume' | 'dind';
  runnerImage?: string;
  selectedRepositories?: string[];
  spareHost?: { ip: string; user?: string; hostKey: string };
}

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
  load1: number;
};
type ArcHost = (
  pool: Required<PoolConfig>,
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
  providers: Record<string, Required<ProviderConfig>>;
  pools: Record<string, Required<PoolConfig>>;
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
export declare function providerClient(
  config: Required<ProviderConfig>,
  options?: FetchOptions
): {
  list(): Promise<Machine[]>;
  create(name: string, userData: string, requestId: string): Promise<Machine>;
  retire(machine: Machine): Promise<void>;
};
export declare function arcValues(
  pool: Required<PoolConfig>,
  group?: string,
  drained?: boolean
): Record<string, unknown>;
export declare function arcHost(
  options?: FetchOptions & { run?: Run }
): ArcHost;
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
    inventory?: Record<string, Omit<MachineTarget, 'group'> & { pool: string }>;
    apply?: boolean;
    env?: Environment;
    run?: Run;
    host?: ArcHost;
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
}
export declare function runnerAccount(
  origin: string,
  key: string,
  options?: { fetcher?: typeof fetch; notation?: boolean }
): {
  offer(): Promise<{
    scope: string;
    label: string;
    capacity: number;
    rate: number;
    currency: 'usd';
    available: boolean;
    activation: RunnerActivation | null;
    draining: boolean;
    credit: number;
    checkoutEnabled: boolean;
  }>;
  activate(minutes: number): Promise<RunnerActivation>;
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
