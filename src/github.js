import {
  githubScope,
  integer,
  match,
  repositoryName,
  requireValue,
} from './config.js';
import { httpClient } from './http.js';

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
