import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { nativeRunnerSpec } from '../../../src/local/native.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const input = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 65536) {
    throw new Error('The native worker registration request is too large');
  }
  input.push(chunk);
}
const request = JSON.parse(Buffer.concat(input).toString('utf8'));
const { cwd, program, args } = nativeRunnerSpec(config, request);
process.exitCode = await new Promise((resolve) => {
  const child = spawn(program, args, { cwd, stdio: 'ignore' });
  child.once('error', () => {
    console.error('Could not start the configured native runner executable');
    resolve(1);
  });
  child.once('close', (code) => resolve(code ?? 1));
});
