#!/usr/bin/env node

/**
 * Decide whether the pull-request Docker build check should run.
 *
 * The publish path (scripts/check-docker-publish.mjs) requires registry
 * credentials, which fork pull requests never have. The build check only
 * needs a Dockerfile: when the repository ships one, every pull request
 * builds it, so a Dockerfile regression fails the pull request before the
 * package is published.
 *
 * - DOCKERFILE: Dockerfile path (optional, defaults to ./Dockerfile)
 * - DOCKER_CONTEXT: build context path (optional, defaults to .)
 */

import { appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONTEXT = '.';
const DEFAULT_DOCKERFILE = './Dockerfile';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function evaluateDockerBuildConfig({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const context = clean(env.DOCKER_CONTEXT) || DEFAULT_CONTEXT;
  const configuredDockerfile = clean(env.DOCKERFILE);
  const dockerfile = configuredDockerfile || DEFAULT_DOCKERFILE;
  const errors = [];

  const recipe = statSync(path.resolve(cwd, dockerfile), {
    throwIfNoEntry: false,
  });
  if (recipe?.isFile() !== true) {
    if (recipe || configuredDockerfile) {
      errors.push(
        `Dockerfile is missing or is not a regular file: ${dockerfile}`
      );
    }
    return { context, dockerfile, enabled: false, errors };
  }

  const buildContext = statSync(path.resolve(cwd, context), {
    throwIfNoEntry: false,
  });
  if (buildContext?.isDirectory() !== true) {
    errors.push(`Docker context is missing or is not a directory: ${context}`);
  }

  return {
    context,
    dockerfile,
    enabled: errors.length === 0,
    errors,
  };
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
  console.log(`Output: ${name}=${value}`);
}

function isCliEntryPoint() {
  return (
    typeof process !== 'undefined' &&
    process.argv?.[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  );
}

export function main({ env = process.env, stderr = console.error } = {}) {
  const config = evaluateDockerBuildConfig({ env });

  setOutput('enabled', config.enabled ? 'true' : 'false');
  setOutput('context', config.context);
  setOutput('dockerfile', config.dockerfile);

  if (config.errors.length > 0) {
    for (const error of config.errors) {
      stderr(`::error::${error}`);
    }
    return 1;
  }

  if (!config.enabled) {
    console.log(
      `Docker build check is skipped: no Dockerfile at ${config.dockerfile}`
    );
    return 0;
  }

  console.log(`Docker build check is enabled for ${config.dockerfile}`);
  return 0;
}

if (isCliEntryPoint()) {
  process.exitCode = main();
}
