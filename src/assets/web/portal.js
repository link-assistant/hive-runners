const element = (id) => globalThis.document.getElementById(id);
let key;
let checkout;
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

async function api(path, options = {}) {
  const response = await fetch(`/v1/${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error);
  }
  return result;
}

async function refresh() {
  const offer = await api('offer');
  element('summary').textContent =
    `${offer.scope} · ${dollars.format(offer.rate / 100)} per runner-minute · ${dollars.format(offer.credit / 100)} available credit`;
  element('example').textContent = `runs-on: ${offer.label}`;
  element('activation').textContent = offer.activation
    ? `Activation ends at ${new Date(offer.activation.expires).toLocaleTimeString()}. Submit your GitHub workflow to use the pool.`
    : 'No runner activation is currently scheduled.';
  element('account').hidden = false;
}

function action(id, event, work) {
  element(id).addEventListener(event, async (e) => {
    e.preventDefault();
    const button = e.submitter ?? e.currentTarget;
    button.disabled = true;
    try {
      element('status').textContent = 'Working…';
      await work();
      element('status').textContent = '';
    } catch (error) {
      element('status').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

action('login', 'submit', async () => {
  element('account').hidden = true;
  key = element('key').value.trim();
  checkout = null;
  await refresh();
  element('key').value = '';
});
action('activate', 'submit', async () => {
  await api('activation', {
    method: 'PUT',
    body: JSON.stringify({ minutes: element('minutes').valueAsNumber }),
  });
  await refresh();
});
action('stop', 'click', async () => {
  await api('activation', { method: 'DELETE' });
  await refresh();
});
action('checkout', 'submit', async () => {
  const amount = Math.round(element('amount').valueAsNumber * 100);
  if (checkout?.amount !== amount) {
    checkout = { amount, id: globalThis.crypto.randomUUID() };
  }
  const { url } = await api('checkout', {
    method: 'POST',
    body: JSON.stringify({ amount }),
    headers: { 'idempotency-key': checkout.id },
  });
  globalThis.location.assign(url);
});
