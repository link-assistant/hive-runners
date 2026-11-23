import { blankEnv } from './helpers/env.js';
import { describe, expect } from 'test-anywhere';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { itUnless, sandboxed } from './helpers/skip.js';

const scriptPath = fileURLToPath(
  new URL('../scripts/detect-code-changes.mjs', import.meta.url)
);

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${
        result.stderr
      }`
    );
  }
}

function commit(root, message) {
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', message]);
}

function createMergeCommitFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'detect-code-changes-'));

  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.email', 'ci@example.com']);
  runGit(root, ['config', 'user.name', 'CI Test']);

  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  commit(root, 'Initial commit');

  runGit(root, ['checkout', '-b', 'feature']);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, 'src', 'index.mjs'),
    'export const value = 1;\n'
  );
  commit(root, 'Add source change');

  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'notes.md'), '# Notes\n');
  commit(root, 'Add docs change');

  runGit(root, ['checkout', 'main']);
  runGit(root, ['merge', '--no-ff', 'feature', '-m', 'Merge feature']);

  return root;
}

function createChangeFixture(filePath, eventName, options = {}) {
  const { packageRoot = '.' } = options;
  const root = mkdtempSync(path.join(tmpdir(), 'detect-code-changes-'));

  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.email', 'ci@example.com']);
  runGit(root, ['config', 'user.name', 'CI Test']);

  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  mkdirSync(path.join(root, packageRoot), { recursive: true });
  writeFileSync(
    path.join(root, packageRoot, 'package.json'),
    '{ "name": "fixture" }\n'
  );
  commit(root, 'Initial commit');

  if (eventName === 'pull_request') {
    runGit(root, ['checkout', '-b', 'feature']);
  }

  mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
  // Bun reads bunfig.toml from its working directory, so it must parse.
  const content = filePath.endsWith('.toml')
    ? '# Fixture change\n'
    : 'export const ignored = true;\n';
  writeFileSync(path.join(root, filePath), content);
  commit(root, 'Add excluded file');

  if (eventName === 'pull_request') {
    runGit(root, ['checkout', 'main']);
    runGit(root, ['merge', '--no-ff', 'feature', '-m', 'Synthetic PR merge']);
  }

  return root;
}

function runDetectCodeChanges(root, eventName, extraEnv = {}) {
  const outputFile = path.join(root, 'github-output.txt');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...blankEnv(process.env, (key) => /^(GITHUB_|CI$|JS_ROOT$)/.test(key)),
      GITHUB_EVENT_NAME: eventName,
      GITHUB_OUTPUT: outputFile,
      ...(eventName === 'push' && {
        GITHUB_BEFORE_SHA: spawnGit(root, ['rev-parse', 'HEAD^1']),
      }),
      ...extraEnv,
    },
  });

  return {
    outputs: readFileSync(outputFile, 'utf8'),
    result,
  };
}

describe('detect-code-changes CLI', () => {
  itUnless(sandboxed)(
    'detects code introduced by a real merge commit pushed to main',
    () => {
      const root = createMergeCommitFixture();

      try {
        const { outputs, result } = runDetectCodeChanges(root, 'push');

        expect(result.status).toBe(0);
        expect(outputs).toContain('js-changed=true\n');
        expect(outputs).toContain('docs-changed=true\n');
        expect(outputs).toContain('any-code-changed=true\n');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  );

  itUnless(sandboxed)(
    'checks the cumulative pull request merge diff after a docs-only tip',
    () => {
      const root = createMergeCommitFixture();

      try {
        const { outputs, result } = runDetectCodeChanges(root, 'pull_request');

        expect(result.status).toBe(0);
        expect(outputs).toContain('js-changed=true\n');
        expect(outputs).toContain('docs-changed=true\n');
        expect(outputs).toContain('any-code-changed=true\n');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  );

  for (const eventName of ['pull_request', 'push']) {
    for (const filePath of [
      'dev/log/repro.js',
      'docs/case-studies/issue-113/repro.md',
    ]) {
      itUnless(sandboxed)(`ignores ${filePath} changes on ${eventName}`, () => {
        const root = createChangeFixture(filePath, eventName);

        try {
          const { outputs, result } = runDetectCodeChanges(root, eventName);

          expect(result.status).toBe(0);
          expect(outputs).toContain('js-changed=false\n');
          expect(outputs).toContain('docs-changed=false\n');
          expect(outputs).toContain('any-code-changed=false\n');
          expect(outputs).not.toContain('mjs-changed=');
          expect(outputs).not.toContain('package-changed=');
          expect(outputs).not.toContain('workflow-changed=');
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      });
    }
  }

  for (const [filePath, expectedOutput] of [
    ['src/relevant.mjs', 'js-changed=true\n'],
    ['docs/relevant.md', 'docs-changed=true\n'],
  ]) {
    itUnless(sandboxed)(
      `keeps detecting non-ignored ${filePath} changes`,
      () => {
        const root = createChangeFixture(filePath, 'push');

        try {
          const { outputs, result } = runDetectCodeChanges(root, 'push');

          expect(result.status).toBe(0);
          expect(outputs).toContain(expectedOutput);
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      }
    );
  }

  // git prints repository-root-relative paths, so in the multi-language
  // layout (package.json in js/) the package-relative ignore list matches
  // only after the js/ prefix has been stripped.
  for (const eventName of ['pull_request', 'push']) {
    for (const filePath of [
      'js/.changeset/tidy-cats-shine.md',
      'js/dev/log/repro.js',
      'js/docs/case-studies/issue-141/repro.md',
    ]) {
      itUnless(sandboxed)(
        `ignores ${filePath} changes on ${eventName} in the multi-language layout`,
        () => {
          const root = createChangeFixture(filePath, eventName, {
            packageRoot: 'js',
          });

          try {
            const { outputs, result } = runDetectCodeChanges(root, eventName);

            expect(result.status).toBe(0);
            expect(outputs).toContain('js-changed=false\n');
            expect(outputs).toContain('docs-changed=false\n');
            expect(outputs).toContain('any-code-changed=false\n');
          } finally {
            rmSync(root, { force: true, recursive: true });
          }
        }
      );
    }
  }

  for (const [filePath, expectedOutputs] of [
    ['js/src/relevant.mjs', ['js-changed=true\n', 'any-code-changed=true\n']],
    ['js/docs/relevant.md', ['docs-changed=true\n']],
    ['.github/workflows/ci.yml', ['any-code-changed=true\n']],
  ]) {
    itUnless(sandboxed)(
      `keeps detecting ${filePath} changes in the multi-language layout`,
      () => {
        const root = createChangeFixture(filePath, 'push', {
          packageRoot: 'js',
        });

        try {
          const { outputs, result } = runDetectCodeChanges(root, 'push');

          expect(result.status).toBe(0);
          for (const expected of expectedOutputs) {
            expect(outputs).toContain(expected);
          }
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      }
    );
  }

  itUnless(sandboxed)(
    'ignores changes belonging to another language package',
    () => {
      const root = createChangeFixture('rust/Cargo.toml', 'push', {
        packageRoot: 'js',
      });

      try {
        const { outputs, result } = runDetectCodeChanges(root, 'push');

        expect(result.status).toBe(0);
        expect(outputs).toContain('js-changed=false\n');
        expect(outputs).toContain('any-code-changed=false\n');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  );
});

describe('detect-code-changes file types', () => {
  // The pipeline runs shell scripts, publishes type declarations and builds
  // the Dockerfile, so a change to any of them must run the checks.
  for (const eventName of ['pull_request', 'push']) {
    for (const filePath of [
      'scripts/check-pages.sh',
      'src/index.d.ts',
      'Dockerfile',
      'bunfig.toml',
      'tests/fixtures/pages-stub/gh',
    ]) {
      itUnless(sandboxed)(`counts ${filePath} as code on ${eventName}`, () => {
        const root = createChangeFixture(filePath, eventName);

        try {
          const { outputs, result } = runDetectCodeChanges(root, eventName);

          expect(result.status).toBe(0);
          expect(outputs).toContain('any-code-changed=true\n');
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      });
    }
  }

  itUnless(sandboxed)('does not count a .gitkeep placeholder as code', () => {
    const root = createChangeFixture('assets/.gitkeep', 'push');

    try {
      const { outputs, result } = runDetectCodeChanges(root, 'push');

      expect(result.status).toBe(0);
      expect(outputs).toContain('any-code-changed=false\n');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function spawnGit(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
}

describe('detect-code-changes push ranges', () => {
  itUnless(sandboxed)('checks every commit in a fast-forward push', () => {
    const root = createMergeCommitFixture();
    try {
      runGit(root, ['checkout', 'feature']);
      const before = spawnGit(root, ['rev-parse', 'HEAD~2']);
      const { result, outputs } = runDetectCodeChanges(root, 'push', {
        GITHUB_BEFORE_SHA: before,
      });
      expect(result.status).toBe(0);
      expect(outputs).toContain('js-changed=true\n');
      expect(outputs).toContain('docs-changed=true\n');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  itUnless(sandboxed)(
    'checks all tracked files if the push base is unavailable',
    () => {
      const root = createMergeCommitFixture();
      try {
        runGit(root, ['checkout', 'feature']);
        const { result, outputs } = runDetectCodeChanges(root, 'push', {
          GITHUB_BEFORE_SHA: '0'.repeat(40),
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('checking all tracked files');
        expect(outputs).toContain('js-changed=true\n');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  );
});

describe('example and experiment syntax triggers', () => {
  for (const eventName of ['pull_request', 'push']) {
    for (const packageRoot of ['.', 'js']) {
      for (const file of [
        'examples/demo.js',
        'examples/demo.mjs',
        'examples/nested/demo.cjs',
        'experiments/repro.mjs',
      ]) {
        itUnless(sandboxed)(
          `syntax checks ${file} on ${eventName} in ${packageRoot}`,
          () => {
            const filePath =
              packageRoot === '.' ? file : `${packageRoot}/${file}`;
            const root = createChangeFixture(filePath, eventName, {
              packageRoot,
            });
            try {
              const { outputs, result } = runDetectCodeChanges(root, eventName);
              expect(result.status).toBe(0);
              expect(outputs).toContain('js-changed=true\n');
              expect(outputs).toContain('docs-changed=false\n');
              expect(outputs).toContain('any-code-changed=false\n');
            } finally {
              rmSync(root, { force: true, recursive: true });
            }
          }
        );
      }
    }
  }
});
