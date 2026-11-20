import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { renderPage } from './page.js';

const codec = new URL(import.meta.resolve('lino-objects-codec'));
const parser = new URL(import.meta.resolve('links-notation'));
const importMap = JSON.stringify({
  imports: { 'links-notation': '/lino/parser.js' },
});
const importMapHash = createHash('sha256').update(importMap).digest('base64');
export const portalScriptPolicy = `'sha256-${importMapHash}'`;
const portalScripts = `<script type="importmap">${importMap}</script><script type="module" src="/portal.js"></script>`;
const html = 'text/html; charset=utf-8';
const markdown = 'text/plain; charset=utf-8';
const script = 'text/javascript; charset=utf-8';
const css = 'text/css; charset=utf-8';
const aliases = new Map([
  ['/', '/index.html'],
  ['/portal', '/portal.html'],
  ['/docs', '/guide.html'],
]);
const assets = new Map([
  ['/portal.js', [new URL('../assets/web/portal.js', import.meta.url), script]],
  [
    '/runner-hardware.webp',
    [
      new URL('../assets/web/runner-hardware.webp', import.meta.url),
      'image/webp',
    ],
  ],
  [
    '/docs/hive-runners.md',
    [new URL('../../docs/hive-runners.md', import.meta.url), markdown],
  ],
  [
    '/docs/generated-cli.md',
    [new URL('../../docs/generated-cli.md', import.meta.url), markdown],
  ],
  ['/lino/parser.js', [parser, script]],
]);
for (const name of [
  'index',
  'base64',
  'codec',
  'debug',
  'format',
  'fuzzy-match',
  'readable',
]) {
  assets.set(`/lino/${name}.js`, [new URL(`${name}.js`, codec), script]);
}

function readOverride(directory, file) {
  if (directory) {
    try {
      return readFileSync(join(directory, file), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return readFileSync(
    new URL(`../assets/web/${file}`, import.meta.url),
    'utf8'
  );
}

export function publicPages(directory) {
  const pages = new Map();
  for (const name of ['index', 'portal', 'guide']) {
    try {
      const source = readOverride(directory, `${name}.lino`);
      pages.set(`/${name}.html`, [
        Buffer.from(renderPage(source, name === 'portal' ? portalScripts : '')),
        html,
      ]);
    } catch (error) {
      throw new Error(`Unable to render ${name}.lino: ${error.message}`, {
        cause: error,
      });
    }
  }
  pages.set('/hive.css', [
    Buffer.from(readOverride(directory, 'hive.css')),
    css,
  ]);
  return async (path, response) => {
    const resolved = aliases.get(path) ?? path;
    const asset = pages.get(resolved) ?? assets.get(resolved);
    if (!asset) {
      return false;
    }
    const [file, type] = asset;
    const bytes = Buffer.isBuffer(file) ? file : await readFile(file);
    response.writeHead(200, { 'content-type': type }).end(bytes);
    return true;
  };
}
