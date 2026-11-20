import { URL, URLSearchParams } from 'node:url';
import { integer, match, requireValue, uuid } from '../config.js';
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
const disputeEvents = new Set([
  'charge.dispute.created',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
]);

function updateDispute(disputes, event, amount) {
  const dispute = event.data.object;
  const id = match(dispute.id, /^dp_[A-Za-z0-9]+$/, 'Stripe dispute ID');
  const time = integer(
    event.created,
    1,
    Number.MAX_SAFE_INTEGER,
    'Stripe event timestamp'
  );
  const old = disputes[id];
  const restored = event.type === 'charge.dispute.funds_reinstated';
  if (
    (old && (old.time > time || (old.time === time && old.restored))) ||
    (event.type === 'charge.dispute.created' &&
      dispute.status?.startsWith('warning_'))
  ) {
    return false;
  }
  disputes[id] = { time, restored, amount: restored ? 0 : amount };
  return true;
}

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
    match(request, uuid, 'checkout request ID');
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
      ...existing,
      account: order.account,
      amount: order.amount,
      reversed,
    });
  }

  function reverse(event) {
    const charge = event.data.object;
    if (typeof charge.payment_intent !== 'string') {
      return;
    }
    const payment = store.get('payment', charge.payment_intent) ?? {
      reversed: 0,
    };
    const refunded = payment.refunded ?? 0;
    const legacyReversed =
      payment.legacyReversed ??
      (payment.refunded === undefined ? payment.reversed : 0);
    const disputes = payment.disputes ?? {};
    const isRefund = event.type === 'charge.refunded';
    const reported = integer(
      isRefund ? charge.amount_refunded : charge.amount,
      0,
      Number.MAX_SAFE_INTEGER,
      'reversal cents'
    );
    if (!isRefund && !updateDispute(disputes, event, reported)) {
      return;
    }
    const nextRefunded = isRefund ? Math.max(refunded, reported) : refunded;
    const reversed = Math.min(
      payment.amount ?? Number.MAX_SAFE_INTEGER,
      Math.max(
        legacyReversed,
        nextRefunded +
          Object.values(disputes).reduce(
            (sum, dispute) => sum + dispute.amount,
            0
          )
      )
    );
    if (payment.account) {
      ledger.adjust(payment.account, payment.reversed - reversed);
    }
    store.put('payment', charge.payment_intent, {
      ...payment,
      reversed,
      legacyReversed,
      refunded: nextRefunded,
      disputes,
    });
  }

  function ingest(event) {
    store.transaction(() => {
      if (checkoutEvents.has(event.type)) {
        settle(event.data.object);
      }
      if (event.type === 'charge.refunded' || disputeEvents.has(event.type)) {
        reverse(event);
      }
    });
  }
  return { checkout, ingest };
}
