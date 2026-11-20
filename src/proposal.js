import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  match,
  repositoryName,
  requireValue,
  validateConfig,
} from './config.js';
import { renderInfrastructure } from './infrastructure.js';
import { runProcess } from './process.js';
import { withWorkspace } from './workspace.js';

export async function propose(
  input,
  {
    cwd = process.cwd(),
    base = 'main',
    branch = `hive/config-${randomUUID().slice(0, 12)}`,
    run = runProcess,
  } = {}
) {
  const config = validateConfig(input);
  match(base, repositoryName, 'base branch');
  match(branch, /^hive\/[a-z0-9][a-z0-9-]{0,59}$/, 'proposal branch');
  requireValue(
    Object.keys(config.pools).length,
    'Configure at least one pool before proposing changes'
  );
  const git = (args, options = {}) => run('git', args, { cwd, ...options });
  await git([
    'fetch',
    'origin',
    `refs/heads/${base}:refs/remotes/origin/${base}`,
  ]);
  return withWorkspace(async ({ directory, save }) => {
    const checkout = resolve(directory, 'checkout');
    await git([
      'worktree',
      'add',
      '--detach',
      checkout,
      `refs/remotes/origin/${base}`,
    ]);
    try {
      await renderInfrastructure(config, checkout);
      const work = { cwd: checkout };
      await git(['add', '--', 'hive-managed'], work);
      const summary = await git(
        ['diff', '--cached', '--stat', '--', 'hive-managed'],
        work
      );
      requireValue(
        summary.trim(),
        'The generated configuration already matches the base branch'
      );
      const description = [
        'Update the managed Terraform, Ansible and ARC configuration.',
        '',
        ...Object.entries(config.pools).map(
          ([name, pool]) =>
            `- \`${name}\` targets \`${pool.scope}\` with label \`${pool.label}\`, ${pool.minMachines} minimum machine(s) and ${pool.capacity} runners per machine.`
        ),
        '',
        'Changed files',
        '',
        '~~~text',
        summary.trimEnd(),
        '~~~',
        '',
        'Review the Terraform plan and verify SSH host keys before deploying.',
      ].join('\n');
      const bodyFile = await save('proposal.md', description);
      await git(
        ['commit', '-m', 'chore: update managed Hive Runners configuration'],
        work
      );
      await git(['push', 'origin', `HEAD:refs/heads/${branch}`], work);
      return (
        await run(
          'gh',
          [
            'pr',
            'create',
            '--draft',
            '--base',
            base,
            '--head',
            branch,
            '--title',
            'chore: update Hive Runners configuration',
            '--body-file',
            bodyFile,
          ],
          { cwd }
        )
      ).trim();
    } finally {
      await git(['worktree', 'remove', '--force', checkout]);
    }
  });
}
