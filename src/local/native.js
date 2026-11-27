import { isAbsolute, join, resolve } from 'node:path';
import { httpsOrigin, requireValue } from '../config.js';

export function nativeRunnerSpec(config, request, platform = process.platform) {
  requireValue(
    ['darwin', 'win32'].includes(platform),
    'Native runners require a macOS or Windows guest'
  );
  requireValue(
    isAbsolute(config.workspace) && isAbsolute(config.runner),
    'Use absolute guest runner and workspace paths'
  );
  requireValue(
    request &&
      typeof request.ticket === 'string' &&
      /^[A-Za-z0-9_+/=.-]{1,32768}$/.test(request.ticket),
    'Invalid native worker ticket'
  );
  const workspace = resolve(config.workspace);
  if (request.platform === 'github') {
    requireValue(
      request.origin === 'https://github.com',
      'Unexpected GitHub origin'
    );
    return {
      cwd: workspace,
      program: config.runner,
      args: ['run', '--jitconfig', request.ticket],
    };
  }
  requireValue(request.platform === 'gitlab', 'Unsupported native CI platform');
  return {
    cwd: workspace,
    program: config.runner,
    args: [
      'run-single',
      '--url',
      httpsOrigin(request.origin, 'GitLab server'),
      '--token',
      request.ticket,
      '--executor',
      'shell',
      '--builds-dir',
      join(workspace, 'builds'),
      '--cache-dir',
      join(workspace, 'cache'),
      '--max-builds',
      '1',
      '--wait-timeout',
      '60',
      ...(platform === 'win32' ? ['--shell', 'powershell'] : []),
    ],
  };
}
