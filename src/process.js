import { spawn } from 'node:child_process';

export function runProcess(
  program,
  args,
  { cwd, env = process.env, input, maxMs = 600000 } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(maxMs),
    });
    const chunks = [];
    let size = 0;
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && size <= 4 * 1024 * 1024) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(
          new Error(
            `${program} ${args[0] ?? ''} failed (exit ${code ?? 'signal'}). Re-run the documented command for local diagnostics.`
          )
        );
      }
    });
  });
}
