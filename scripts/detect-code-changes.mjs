#!/usr/bin/env node

// Detect code changes for CI/CD pipeline
//
// Detects what types of files changed and outputs results for use in
// GitHub Actions workflow conditions.
//
// Pull requests compare the tested merge commit with its first parent. Pushes
// compare the complete before/after range. An unavailable push base widens
// the check to all tracked files, so a multi-commit push cannot hide changes.
//
// Paths are compared package-relative: in a multi-language repository
// (package.json in js/) the js/ prefix is stripped first and files belonging
// to other languages are ignored, so the lists below match in both layouts.
//
// Ignored for code/changeset gating (syntax still checks examples/experiments):
// - .changeset/ folder (changeset metadata)
// - docs/case-studies/ folder (research documents)
// - dev/log/ folder (development logs)
// - experiments/ folder (experimental scripts)
// - examples/ folder (example scripts)
//
// Additionally excluded from code changes (don't require changesets):
// - Markdown files in any folder
// - docs/ folder (documentation)
//
// Outputs (written to GITHUB_OUTPUT):
//   js-changed, docs-changed, any-code-changed

import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';

import { getJsRoot, parseJsRootConfig } from './js-paths.mjs';

const ignoredPathPrefixes = [
  '.changeset/',
  'dev/log/',
  'docs/case-studies/',
  'examples/',
  'experiments/',
];

const workflowPathPrefix = '.github/workflows/';

/**
 * Path prefix of the JavaScript package relative to the repository root:
 * `js/` in a multi-language repository, `''` in a single-package one.
 *
 * `git diff --name-only` prints repository-root-relative paths, while the
 * ignore list is package-relative, so this prefix has to be stripped before
 * the two are compared.
 *
 * @returns {string} Prefix ending with `/`, or an empty string.
 */
function getPackagePathPrefix() {
  let jsRoot;
  try {
    jsRoot = getJsRoot({ jsRoot: parseJsRootConfig() });
  } catch {
    // No package.json anywhere: treat the repository root as the package root.
    return '';
  }
  return !jsRoot || jsRoot === '.' ? '' : `${jsRoot.replace(/\/+$/, '')}/`;
}

/**
 * Re-express repository-root-relative paths as package-relative ones.
 *
 * Files belonging to another language's package (`rust/Cargo.toml`) are
 * dropped, since they are not JavaScript code changes. Workflow files are
 * genuinely repository-root-relative and are kept as they are.
 *
 * @param {string[]} changedFiles Repository-root-relative paths.
 * @param {string} prefix Package prefix from {@link getPackagePathPrefix}.
 * @returns {string[]} Package-relative paths plus root-level workflow files.
 */
function toPackagePaths(changedFiles, prefix) {
  if (!prefix) {
    return changedFiles;
  }

  return changedFiles
    .filter(
      (file) => file.startsWith(prefix) || file.startsWith(workflowPathPrefix)
    )
    .map((file) =>
      file.startsWith(prefix) ? file.slice(prefix.length) : file
    );
}

function execGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function hasCommit(revision) {
  try {
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`],
      {
        stdio: 'ignore',
      }
    );
    return true;
  } catch {
    return false;
  }
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
  console.log(`${name}=${value}`);
}

function getChangedFiles() {
  const event = process.env.GITHUB_EVENT_NAME;
  const before = process.env.GITHUB_BEFORE_SHA ?? '';
  let base;

  if (event === 'pull_request' && hasCommit('HEAD^2')) {
    base = 'HEAD^1';
  } else if (event === 'push') {
    if (/^[a-f0-9]{40}$/i.test(before) && hasCommit(before)) {
      base = before;
    }
  } else if (!event && hasCommit('HEAD^1')) {
    base = 'HEAD^1';
  }

  if (base) {
    console.log(`Comparing ${base} to HEAD`);
    return execGit([
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      base,
      'HEAD',
      '--',
    ])
      .split('\0')
      .filter(Boolean);
  }

  console.log('Comparison base unavailable, checking all tracked files');
  return execGit(['ls-tree', '--name-only', '-r', '-z', 'HEAD'])
    .split('\0')
    .filter(Boolean);
}

/**
 * Everything else counts as code, so a file type nobody listed (a shell
 * script, a type declaration, the Dockerfile) still runs the checks.
 *
 * @param {string} filePath package-relative path
 * @returns {boolean}
 */
function isExcludedFromCodeChanges(filePath) {
  if (filePath.endsWith('.md') || filePath.endsWith('/.gitkeep')) {
    return true;
  }

  return filePath.startsWith('docs/') || filePath === '.gitkeep';
}

async function detectChanges() {
  console.log('Detecting file changes for CI/CD...\n');

  const changedFiles = await getChangedFiles();

  console.log('Changed files:');
  if (changedFiles.length === 0) {
    console.log('  (none)');
  } else {
    changedFiles.forEach((file) => console.log(`  ${file}`));
  }
  console.log('');

  const packageChangedFiles = toPackagePaths(
    changedFiles,
    getPackagePathPrefix()
  );

  const relevantChangedFiles = packageChangedFiles.filter(
    (file) => !ignoredPathPrefixes.some((prefix) => file.startsWith(prefix))
  );

  const jsChanged = packageChangedFiles.some(
    (file) =>
      !/^(?:docs\/case-studies|dev\/log)\//.test(file) &&
      /\.(mjs|cjs|js)$/.test(file)
  );
  setOutput('js-changed', jsChanged ? 'true' : 'false');

  const docsChanged = relevantChangedFiles.some((file) => file.endsWith('.md'));
  setOutput('docs-changed', docsChanged ? 'true' : 'false');

  const codeChangedFiles = relevantChangedFiles.filter(
    (file) => !isExcludedFromCodeChanges(file)
  );

  console.log('\nFiles considered as code changes:');
  if (codeChangedFiles.length === 0) {
    console.log('  (none)');
  } else {
    codeChangedFiles.forEach((file) => console.log(`  ${file}`));
  }
  console.log('');

  const anyCodeChanged = codeChangedFiles.length > 0;
  setOutput('any-code-changed', anyCodeChanged ? 'true' : 'false');

  console.log('\nChange detection completed.');
}

// Run the detection
detectChanges().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
