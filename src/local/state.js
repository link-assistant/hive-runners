import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { requireValue } from '../config.js';

export async function stateDirectory(path) {
  const directory = resolve(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  requireValue(
    info.isDirectory() &&
      (await realpath(directory)) === directory &&
      (process.platform === 'win32' ||
        ((info.mode & 0o077) === 0 && info.uid === process.getuid())),
    'Use a private local state directory owned by the controller'
  );
  return directory;
}

async function readDocument(directory, name, fallback) {
  try {
    return JSON.parse(await readFile(join(directory, name), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return fallback;
  }
}

async function writeDocument(directory, name, value) {
  const temporary = join(
    directory,
    `.write-${randomBytes(12).toString('hex')}`
  );
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
    if (process.platform !== 'win32') {
      const parent = await open(directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function controllerLock() {
  const port = 32764;
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (error) {
    throw new Error(
      `Cannot acquire the local controller on loopback port ${port}: ${error.code}`,
      { cause: error }
    );
  }
  return () => new Promise((resolve) => server.close(resolve));
}

export function desiredMode(directory) {
  return readDocument(directory, 'desired.json', 'running');
}

export function setDesiredMode(directory, mode) {
  requireValue(
    ['running', 'draining', 'stopped'].includes(mode),
    'Invalid local controller mode'
  );
  return writeDocument(directory, 'desired.json', mode);
}

export function readState(directory) {
  return readDocument(directory, 'controller.json', null);
}

export async function openState(directory, config) {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        config.controllerScope,
        config.controllerStorage,
        config.scopes,
        config.nodes,
        config.pools,
      ])
    )
    .digest('hex');
  const original = await readState(directory);
  requireValue(
    !original || (original.version === 1 && original.key === key),
    'Local configuration changed. Drain and stop with the original configuration before using a new state directory.'
  );
  const state = original ?? {
    version: 1,
    key,
    owner: randomBytes(6).toString('hex'),
    leases: [],
  };
  const save = () => writeDocument(directory, 'controller.json', state);
  if (!original) {
    await save();
  }
  return { state, save };
}
