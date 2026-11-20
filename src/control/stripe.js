import { URL, URLSearchParams } from 'node:url';
import { integer, requireValue } from '../config.js';
import { httpClient } from '../http.js';
import { digest, secureEqual } from './usage.js';

export function verifyStripe(body, header, secret, now = Date.now) {
  const fields = Array.isArray(header) ? [] : String(header ?? '').split(',');
  const timestamp = fields.find((entry) => entry.startsWith('t='))?.slice(2);
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(now() / 1000 - seconds) > 300
  ) {
    return false;
  }
  const expected = digest(secret, timestamp, '.', body);
  return fields.some(
    (entry) => entry.startsWith('v1=') && secureEqual(entry.slice(3), expected)
  );
}

const checkoutEvents = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);
const reversalEvents = new Set(['charge.refunded', 'charge.dispute.created']);

export function stripePayments(store, ledger, { token, origin, fetcher }) {
  const stripe = httpClient('https://api.stripe.com', {
    headers: {
      authorization: `Bearer ${token}`,
      // eslint-disable-next-line local/no-changelog-comments -- Stripe API version identifier
      'stripe-version': '2025-06-30.basil',
    },
    fetcher,
  });

  async function checkout(account, request, amount) {
    integer(amount, 500, 100000, 'top-up cents');
    requireValue(
      /^[0-9a-f-]{36}$/.test(request),
      'Provide a UUID for checkout'
    );
    const order = `${account}:${request}`;
    store.transaction(() => {
      const previous = store.get('order', order);
      requireValue(
        !previous || previous.amount === amount,
        'Checkout ID was used for a different amount'
      );
      if (!previous) {
        store.put('order', order, { amount, account });
      }
    });
    const form = new URLSearchParams({
      mode: 'payment',
      'payment_method_types[0]': 'card',
      success_url: `${origin}/portal?checkout=success`,
      cancel_url: `${origin}/portal?checkout=cancelled`,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]':
        'Hive Runners execution credit',
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][quantity]': '1',
      'metadata[hive_order]': order,
    });
    const result = await stripe('/v1/checkout/sessions', {
      method: 'POST',
      body: form.toString(),
      extraHeaders: {
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': order,
      },
    });
    const url = new URL(result.url);
    requireValue(
      url.origin === 'https://checkout.stripe.com',
      'Unexpected Checkout URL'
    );
    return result.url;
  }

  function settle(session) {
    const orderId = session.metadata?.hive_order;
    const order = typeof orderId === 'string' && store.get('order', orderId);
    if (!order || order.paid || session.payment_status !== 'paid') {
      return;
    }
    requireValue(
      session.amount_total === order.amount &&
        session.currency === 'usd' &&
        typeof session.payment_intent === 'string',
      'Checkout amount or currency differs from the order'
    );
    const existing = store.get('payment', session.payment_intent);
    requireValue(!existing?.account, 'Payment intent already credited');
    const reversed = Math.min(order.amount, existing?.reversed ?? 0);
    ledger.adjust(order.account, order.amount - reversed);
    store.put('order', orderId, { ...order, paid: true });
    store.put('payment', session.payment_intent, {
      account: order.account,
      amount: order.amount,
      reversed,
    });
  }

  function reverse(event) {
    if (typeof event.payment_intent !== 'string') {
      return;
    }
    const payment = store.get('payment', event.payment_intent) ?? {
      reversed: 0,
    };
    const reported = integer(
      event.amount_refunded ?? event.amount,
      0,
      Number.MAX_SAFE_INTEGER,
      'reversal cents'
    );
    const reversed = Math.min(
      payment.amount ?? Number.MAX_SAFE_INTEGER,
      Math.max(payment.reversed, reported)
    );
    if (payment.account) {
      ledger.adjust(payment.account, payment.reversed - reversed);
    }
    store.put('payment', event.payment_intent, { ...payment, reversed });
  }

  function ingest(event) {
    store.transaction(() => {
      if (checkoutEvents.has(event.type)) {
        settle(event.data.object);
      }
      if (reversalEvents.has(event.type)) {
        reverse(event.data.object);
      }
    });
  }
  return { checkout, ingest };
}
