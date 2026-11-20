import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { decode, encode, encodeLine } from 'lino-objects-codec';

export const linoMediaType = 'text/vnd.links-notation';

export function formatNotation(value) {
  return `${encode({ obj: value })}\n`;
}

export function formatRecord(value) {
  return encodeLine({ obj: value });
}

export function parseNotation(notation) {
  return decode({ notation });
}

export async function readData(path) {
  const text = await readFile(path, 'utf8');
  return extname(path).toLowerCase() === '.json'
    ? JSON.parse(text)
    : parseNotation(text);
}
