import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';

const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/portal', ['portal.html', 'text/html; charset=utf-8']],
  ['/docs', ['guide.html', 'text/html; charset=utf-8']],
  ['/hive.css', ['hive.css', 'text/css; charset=utf-8']],
  ['/portal.js', ['portal.js', 'text/javascript; charset=utf-8']],
  ['/runner-hardware.webp', ['runner-hardware.webp', 'image/webp']],
]);

export async function publicPage(path, response) {
  const asset = routes.get(path);
  if (!asset) {
    return false;
  }
  const [file, type] = asset;
  const bytes = await readFile(
    new URL(`../assets/web/${file}`, import.meta.url)
  );
  response.writeHead(200, { 'content-type': type }).end(bytes);
  return true;
}
