import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';

const html = 'text/html; charset=utf-8';
const markdown = 'text/plain; charset=utf-8';
const assets = new Map([
  ['/index.html', ['../assets/web/index.html', html]],
  ['/portal.html', ['../assets/web/portal.html', html]],
  ['/guide.html', ['../assets/web/guide.html', html]],
  ['/hive.css', ['../assets/web/hive.css', 'text/css; charset=utf-8']],
  ['/portal.js', ['../assets/web/portal.js', 'text/javascript; charset=utf-8']],
  [
    '/runner-hardware.webp',
    ['../assets/web/runner-hardware.webp', 'image/webp'],
  ],
  ['/docs/hive-runners.md', ['../../docs/hive-runners.md', markdown]],
  ['/docs/generated-cli.md', ['../../docs/generated-cli.md', markdown]],
]);
const aliases = new Map([
  ['/', '/index.html'],
  ['/portal', '/portal.html'],
  ['/docs', '/guide.html'],
]);

export async function publicPage(path, response) {
  const asset = assets.get(aliases.get(path) ?? path);
  if (!asset) {
    return false;
  }
  const [file, type] = asset;
  const bytes = await readFile(new URL(file, import.meta.url));
  response.writeHead(200, { 'content-type': type }).end(bytes);
  return true;
}
