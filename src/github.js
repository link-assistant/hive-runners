import {
  arcCredentials,
  githubScope,
  integer,
  match,
  repositoryName,
  requireValue,
} from './config.js';
import { sign } from 'node:crypto';
import { httpClient } from './http.js';
import { runProcess } from './process.js';

export async function githubToken(
  env = process.env,
  name = 'HIVE_GITHUB_TOKEN',
  run = runProcess
) {
  for (const key of name === 'HIVE_GITHUB_TOKEN'
    ? [name, 'GH_TOKEN', 'GITHUB_TOKEN']
    : [name]) {
    if (Object.hasOwn(env, key) && env[key]?.trim()) {
      return env[key].trim();
    }
  }
  requireValue(
    name === 'HIVE_GITHUB_TOKEN',
    `Missing environment variable ${name}`
  );
  const token = (
    await run('gh', ['auth', 'token', '--hostname', 'github.com'], { env })
  ).trim();
  requireValue(
    token,
    'Authenticate with gh auth login or supply a GitHub token'
  );
  return token;
}

async function installationToken(credentials, fetcher) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + 480,
    iss: credentials.github_app_id,
  })}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(jwt),
    credentials.github_app_private_key
  );
  const api = httpClient('https://api.github.com', {
    headers: {
      authorization: `Bearer ${jwt}.${signature.toString('base64url')}`,
      accept: 'application/vnd.github+json',
    },
    fetcher,
  });
  const id = match(
    credentials.github_app_installation_id,
    /^[1-9][0-9]*$/,
    'GitHub App installation ID'
  );
  const result = await api(`/app/installations/${id}/access_tokens`, {
    method: 'POST',
  });
  requireValue(
    typeof result.token === 'string' && result.token,
    'GitHub App installation did not issue a token'
  );
  return result.token;
}

export async function githubRunnerAuth(pool, { env, run, fetcher }) {
  const {
    credentialsEnv = 'HIVE_ARC_CREDENTIALS',
    groupTokenEnv = 'HIVE_GITHUB_TOKEN',
  } = pool;
  const credentials = env[credentialsEnv]?.trim()
    ? arcCredentials(credentialsEnv, env)
    : { github_token: await githubToken(env, groupTokenEnv, run) };
  const token =
    groupTokenEnv !== 'HIVE_GITHUB_TOKEN' || env[groupTokenEnv]?.trim()
      ? await githubToken(env, groupTokenEnv, run)
      : (credentials.github_token ??
        (await installationToken(credentials, fetcher)));
  return { credentials, client: githubClient(token, fetcher) };
}

export function githubClient(token, fetcher) {
  const api = httpClient('https://api.github.com', {
    headers: {
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      accept: 'application/vnd.github+json',
    },
    fetcher,
  });
  const pathFor = (scope) => {
    match(scope, githubScope, 'GitHub scope');
    return scope.includes('/') ? `/repos/${scope}` : `/orgs/${scope}`;
  };

  async function list(path, field) {
    const records = [];
    for (let page = 1; page <= 100; page++) {
      const response = await api(`${path}?per_page=100&page=${page}`);
      requireValue(
        Array.isArray(response[field]),
        `Unexpected GitHub ${field} response`
      );
      records.push(...response[field]);
      if (response[field].length < 100) {
        return records;
      }
    }
    throw new Error('GitHub pagination limit reached');
  }

  async function ensureGroup(org, name, repositories) {
    match(org, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, 'GitHub organization');
    match(name, /^[a-z][a-z0-9-]{0,61}$/, 'runner group name');
    requireValue(
      repositories.length > 0,
      'Select at least one private repository'
    );
    const selected = await Promise.all(
      repositories.map(async (repository) => {
        match(repository, repositoryName, 'repository name');
        const record = await api(`/repos/${org}/${repository}`);
        requireValue(
          record.private === true,
          `Repository ${org}/${repository} must be private`
        );
        return integer(record.id, 1, Number.MAX_SAFE_INTEGER, 'repository id');
      })
    );
    const path = `${pathFor(org)}/actions/runner-groups`;
    const groups = await list(path, 'runner_groups');
    const existing = groups.find(
      (group) => group.name.toLowerCase() === name.toLowerCase()
    );
    const policy = {
      visibility: 'selected',
      allows_public_repositories: false,
    };
    if (!existing) {
      return api(path, {
        method: 'POST',
        body: { name, ...policy, selected_repository_ids: selected },
      });
    }
    requireValue(
      !existing.inherited && !existing.default,
      'Cannot manage inherited or default groups'
    );
    const target = `${path}/${integer(existing.id, 1, Number.MAX_SAFE_INTEGER, 'group ID')}`;
    await api(target, { method: 'PATCH', body: policy });
    await api(`${target}/repositories`, {
      method: 'PUT',
      body: { selected_repository_ids: selected },
    });
    return existing;
  }

  async function requirePrivateRepo(scope) {
    requireValue(scope.includes('/'), 'Expected a GitHub repository');
    const repo = await api(pathFor(scope));
    requireValue(repo.private === true, `Repository ${scope} must be private`);
    return repo;
  }

  return {
    requirePrivateRepo,
    ensureGroup,
    listRunners: (scope) =>
      list(`${pathFor(scope)}/actions/runners`, 'runners'),
    listGroups: (org) =>
      list(`${pathFor(org)}/actions/runner-groups`, 'runner_groups'),
    setLabels(scope, id, labels) {
      const runner = integer(id, 1, Number.MAX_SAFE_INTEGER, 'runner ID');
      return api(`${pathFor(scope)}/actions/runners/${runner}/labels`, {
        method: 'PUT',
        body: { labels },
      });
    },
  };
}
