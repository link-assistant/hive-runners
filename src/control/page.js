import { parse } from '@link-foundation/ui-core';
import { escapeHtml, renderToHTML } from '@link-foundation/ui-dom/html';

const tags = [
  'a',
  'article',
  'br',
  'button',
  'code',
  'copy',
  'div',
  'em',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'header',
  'hr',
  'i',
  'img',
  'input',
  'label',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'span',
  'strong',
  'ul',
];
const attributes = [
  'alt',
  'aria-describedby',
  'aria-hidden',
  'aria-label',
  'aria-labelledby',
  'autocomplete',
  'class',
  'for',
  'height',
  'href',
  'id',
  'max',
  'maxlength',
  'min',
  'minlength',
  'role',
  'src',
  'step',
  'type',
  'value',
  'width',
];
const toggles = ['hidden', 'required', 'disabled'];
const names = [...attributes, ...toggles, 'content'];
const propertySpecs = (properties) =>
  new Map(properties.map((name) => [name, { type: 'string' }]));
const element = {
  positional: [],
  properties: propertySpecs(names),
  children: 'any',
};
const vocabulary = {
  kinds: new Map(tags.map((tag) => [tag, element])),
  actions: new Map(),
  multiValued: new Set(),
};
vocabulary.kinds.set('page', {
  ...element,
  properties: propertySpecs(['title', 'description']),
});

function atom(properties, name) {
  const values = properties.get(name);
  if (!values) {
    return undefined;
  }
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new Error(`Expected one text value for ${name}`);
  }
  return values[0];
}

function setUrl(node, name, value) {
  if (!/^\/(?![\s\\/])/.test(value) && !/^https:\/\//i.test(value)) {
    throw new Error(`Expected a local path or HTTPS URL for ${name}`);
  }
  node.setAttribute(name, value);
}

const kinds = new Map(
  tags.map((tag) => [
    tag,
    {
      tag: 'ui-hive-html',
      create({ props }, { document }) {
        const node = document.createElement(tag === 'copy' ? 'span' : tag);
        const content = atom(props, 'content');
        if (content !== undefined) {
          node.appendChild(document.createTextNode(content));
        }
        for (const name of attributes) {
          const value = atom(props, name);
          if (value !== undefined) {
            if (name === 'href' || name === 'src') {
              setUrl(node, name, value);
            } else {
              node.setAttribute(name, value);
            }
          }
        }
        for (const name of toggles) {
          if (atom(props, name) === 'true') {
            node.setAttribute(name, '');
          }
        }
        return node;
      },
    },
  ])
);

const portalElements = {
  login: 'form',
  key: 'input',
  status: 'p',
  account: 'section',
  summary: 'p',
  activation: 'p',
  example: 'pre',
  activate: 'form',
  minutes: 'input',
  stop: 'button',
  payment: 'div',
  checkout: 'form',
  amount: 'input',
};

function validateElements(children, ids = new Map()) {
  for (const child of children) {
    const id = child.properties.find(({ name }) => name === 'id')?.values[0];
    if (id !== undefined) {
      if (ids.has(id)) {
        throw new Error(`Duplicate HTML id ${id}`);
      }
      ids.set(id, child.kind);
    }
    if (child.kind === 'page' || child.positional.length > 0) {
      throw new Error('Use elements with named properties inside the page');
    }
    validateElements(child.children, ids);
  }
  return ids;
}

export function renderPage(source, script = '') {
  const { roots, diagnostics } = parse(source, { vocabulary });
  const [page] = roots;
  const invalid = diagnostics.find(({ code }) => code !== 'reserved-sigil');
  if (invalid) {
    throw new Error(invalid.message);
  }
  if (roots.length !== 1 || page.kind !== 'page' || page.positional.length) {
    throw new Error('Expected one page with named properties');
  }
  const props = new Map(
    page.properties.map(({ name, values }) => [name, values])
  );
  const title = atom(props, 'title');
  if (!title) {
    throw new Error('The page needs a title');
  }
  const description = atom(props, 'description');
  const ids = validateElements(page.children);
  if (script) {
    for (const [id, tag] of Object.entries(portalElements)) {
      if (ids.get(id) !== tag) {
        throw new Error(`Portal needs a ${tag} with id ${id}`);
      }
    }
  }
  const body = renderToHTML(page.children, {
    kinds,
    onDiagnostic: (diagnostic) => {
      throw new Error(diagnostic.message);
    },
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/hive.css">
<link rel="icon" type="image/webp" href="/runner-hardware.webp">
${script}</head><body>${body}</body></html>`;
}
