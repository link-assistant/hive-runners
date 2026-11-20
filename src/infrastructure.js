import { URL } from 'node:url';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { arcHost, arcValues, playbook } from './arc.js';
import { integer, match, requireValue, validateConfig } from './config.js';
import { runProcess } from './process.js';

const credentials = {
  contabo: {
    oauth2_client_id: 'CLIENT_ID',
    oauth2_client_secret: 'CLIENT_SECRET',
    oauth2_user: 'USERNAME',
    oauth2_pass: 'PASSWORD',
  },
  hetzner: { token: 'TOKEN' },
};

export function machineName(prefix, pool, slot) {
  return `${prefix}-${pool}-${slot}`;
}

function terraformServer(config, name, key) {
  if (config.type === 'hetzner') {
    return [
      'hcloud_server',
      {
        name,
        location: config.region,
        server_type: config.product,
        image: config.image,
        ssh_keys: config.sshKeys,
        labels: { 'managed-by': 'terraform' },
        provider: `hcloud.${key}`,
      },
      'ipv4_address',
    ];
  }
  return [
    'contabo_instance',
    {
      display_name: name,
      region: config.region,
      product_id: config.product,
      image_id: config.image,
      ssh_keys: config.sshKeys.map(Number),
      period: 1,
      provider: `contabo.${key}`,
    },
    'ip_config[0].v4[0].ip',
  ];
}

const source = {
  hcloud: { source: 'hetznercloud/hcloud', version: '~> 1.60' },
  contabo: { source: 'contabo/contabo', version: '~> 0.1' },
};

function format(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function terraformPlan(input) {
  const config = validateConfig(input);
  const required = {};
  const provider = {};
  const variable = {};
  const resource = {};
  const inventory = {};
  for (const [key, pool] of Object.entries(config.pools)) {
    const cloud = pool.provider && config.providers[pool.provider];
    if (!cloud || pool.terraformMachines === 0) {
      continue;
    }
    const type = cloud.type === 'hetzner' ? 'hcloud' : cloud.type;
    const alias = pool.provider;
    required[type] = source[type];
    provider[type] ??= [];
    const settings = { alias };
    for (const [attribute, suffix] of Object.entries(credentials[cloud.type])) {
      const name = `${cloud.tokenPrefix}_${suffix}`;
      variable[name] = { type: 'string', sensitive: true };
      settings[attribute] = `\${var.${name}}`;
    }
    if (provider[type].every((entry) => entry.alias !== alias)) {
      provider[type].push(settings);
    }
    for (let index = 1; index <= pool.terraformMachines; index++) {
      const name = machineName(config.prefix, key, `tf${index}`);
      const [resourceType, options, ip] = terraformServer(cloud, name, alias);
      resource[resourceType] ??= {};
      resource[resourceType][name] = options;
      inventory[name] = {
        pool: key,
        ip: `\${${resourceType}.${name}.${ip}}`,
      };
    }
  }
  return {
    terraform: { required_version: '>= 1.6', required_providers: required },
    ...(Object.keys(provider).length ? { provider, variable, resource } : {}),
    output: {
      hive_inventory: {
        value: Object.keys(inventory).length ? inventory : '${tomap({})}',
      },
    },
  };
}

async function ensureDirectory(target) {
  await mkdir(target, { recursive: true });
  requireValue(
    (await realpath(target)) === target,
    `Directory uses a symlink: ${target}`
  );
}

async function writeManaged(path, content) {
  const current = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return null;
  });
  requireValue(
    !current || (current.isFile() && current.nlink === 1),
    `Unsafe generated file: ${path}`
  );
  await writeFile(path, content, { flag: current ? 'w' : 'wx' });
}

export async function renderInfrastructure(input, directory) {
  const config = validateConfig(input);
  await mkdir(directory, { recursive: true });
  const target = await realpath(directory);
  const managed = join(target, 'hive-managed');
  await ensureDirectory(managed);
  const hosts = Object.fromEntries(
    Object.keys(config.pools).map((key) => [key, { hosts: {} }])
  );
  const files = {
    'fleet.tf.json': format(terraformPlan(config)),
    'config.json': format(config),
    'inventory.example.json': format({ all: { children: hosts } }),
    'arc.yml': await readFile(playbook, 'utf8'),
    'runner-network.yml': await readFile(
      new URL('./assets/ansible/runner-network.yml', import.meta.url),
      'utf8'
    ),
    'arc-values.json': format(
      Object.fromEntries(
        Object.entries(config.pools).map(([key, pool]) => [
          key,
          arcValues(pool, undefined),
        ])
      )
    ),
    '.gitignore':
      '.terraform/\n*.tfstate\n*.tfstate.*\n*.tfplan\n*.tfvars\ncrash.log\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await writeManaged(join(managed, name), content);
  }
  return Object.keys(files).map((name) => join(managed, name));
}

export async function deploy(
  input,
  {
    directory = '.',
    inventory,
    apply = false,
    env = process.env,
    run = runProcess,
    host,
  } = {}
) {
  const config = validateConfig(input);
  requireValue(
    Boolean(inventory) !== apply,
    'Provide an inventory or explicitly apply Terraform'
  );
  let machines = inventory;
  if (apply) {
    await renderInfrastructure(config, directory);
    const plan = terraformPlan(config);
    const terraformEnv = { ...env, TF_IN_AUTOMATION: '1' };
    for (const name of Object.keys(plan.variable ?? {})) {
      if (Object.hasOwn(env, name)) {
        terraformEnv[`TF_VAR_${name}`] = env[name];
      }
    }
    const cwd = join(resolve(directory), 'hive-managed');
    await run('terraform', ['init', '-input=false'], {
      cwd,
      env: terraformEnv,
    });
    await run('terraform', ['apply', '-input=false', '-auto-approve'], {
      cwd,
      env: terraformEnv,
    });
    machines = JSON.parse(
      await run('terraform', ['output', '-json', 'hive_inventory'], {
        cwd,
        env: terraformEnv,
      })
    );
  }
  const applyHost = host ?? arcHost({ env, run });
  const entries = Object.entries(machines);
  requireValue(entries.length > 0, 'Inventory is empty');
  const counts = new Map();
  const targets = entries.map(([machine, metadata]) => {
    match(machine, /^[a-z][a-z0-9-]{0,61}$/, 'machine name');
    const { pool: name, ip, user } = metadata;
    requireValue(
      Object.hasOwn(config.pools, name),
      `Unknown pool for machine ${machine}`
    );
    const pool = config.pools[name];
    requireValue(
      typeof ip === 'string' &&
        (isIP(ip) || /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(ip)),
      `Invalid SSH host for ${machine}`
    );
    counts.set(name, (counts.get(name) ?? 0) + 1);
    integer(counts.get(name), 1, pool.maxMachines, 'machines per pool');
    return {
      pool,
      ip,
      user,
      group: pool.scope.includes('/') ? undefined : machine,
    };
  });
  for (const { pool, ...machine } of targets) {
    await applyHost(pool, machine);
  }
  return targets.length;
}
