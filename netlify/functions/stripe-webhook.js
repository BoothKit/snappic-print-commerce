
"use strict";

const crypto = require("node:crypto");
const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const ORDER_STORE = "print-commerce-orders";

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function respond(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(data)
  };
}

function verifyStripeSignature(
  payload,
  signatureHeader,
  secret
) {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(",");
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }

  if (!timestamp || !signatures.length) {
    return false;
  }

  const timestampNumber = Number(timestamp);

  if (!Number.isSafeInteger(timestampNumber)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestampNumber) > 300) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest();

  return signatures.some(signature => {
    if (!/^[0-9a-f]{64}$/i.test(signature)) {
      return false;
    }

    const received = Buffer.from(
      signature,
      "hex"
    );

    return (
      received.length === expected.length &&
      crypto.timingSafeEqual(received, expected)
    );
  });
}

function getSiteURL() {
  if (!process.env.URL) {
    throw new Error(
      "Netlify URL is not configured"
    );
  }

  const url = new URL(process.env.URL);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Invalid Netlify URL"
    );
  }

  return url.origin;
}

async function retrieveStripeSession(sessionId) {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is missing"
    );
  }

  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions/" +
      encodeURIComponent(sessionId),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      "Stripe session retrieval failed: " +
      (result.error?.message || response.status)
    );
  }

  return result;
}

function reconstructManifest(metadata) {
  const chunkCount = Number(
    metadata?.manifest_chunks
  );

  if (
    !Number.isInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > 20
  ) {
    throw new Error(
      "Invalid order manifest chunk count"
    );
  }

  let serialized = "";

  for (let i = 0; i < chunkCount; i++) {
    const chunk = metadata[`manifest_${i}`];

    if (typeof chunk !== "string") {
      throw new Error(
        `Missing order manifest chunk ${i}`
      );
    }

    serialized += chunk;
  }

  const manifest = JSON.parse(serialized);

  if (
    !manifest ||
    !Array.isArray(manifest.items) ||
    manifest.items.length < 1 ||
    manifest.items.length > 2
  ) {
    throw new Error(
      "Invalid order manifest"
    );
  }

  return manifest;
}

function getShippingDetails(session) {
  const customer = session.customer_details || {};
  const shipping = session.shipping_details || {};

  const address =
    customer.address ||
    shipping.address ||
    null;

  const name =
    shipping.name ||
    customer.name ||
    null;

  return {
    name,
    email:
      customer.email ||
      session.customer_email ||
      null,
    phone: customer.phone || null,
    address: address
      ? {
          line1: address.line1 || null,
          line2: address.line2 || null,
          city: address.city || null,
          state: address.state || null,
          postal_code:
            address.postal_code || null,
          country: address.country || null
        }
      : null
  };
}

function shouldDispatch(order) {
  if (
    !order ||
    order.paymentStatus !== "paid"
  ) {
    return false;
  }

  const fulfillment = order.fulfillment || {};

  // Never dispatch an order already known
  // to exist in Prodigi.
  if (fulfillment.prodigiOrderId) {
    return false;
  }

  // Do not retry uncertain submissions.
  // They require reconciliation first.
  if (
    [
      "submitting",
      "submitted",
      "needs_review"
    ].includes(fulfillment.status)
  ) {
    return false;
  }

  // Only untouched pending orders may be
  // automatically dispatched.
  return (
    fulfillment.status === "pending" &&
    (fulfillment.attempts || 0) === 0
  );
}

async function dispatchFulfillment(sessionId) {
  const token =
    process.env.FULFILLMENT_WORKER_TOKEN;

  if (!token) {
    throw new Error(
      "FULFILLMENT_WORKER_TOKEN is missing"
    );
  }

  const endpoint =
    getSiteURL() +
    "/.netlify/functions/fulfill-order-background";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fulfillment-token": token
    },
    body: JSON.stringify({
      sessionId
    }),
    signal: AbortSignal.timeout(15000)
  });

  // Netlify background functions acknowledge
  // accepted jobs with HTTP 202.
  //
  // This does NOT mean Prodigi fulfillment
  // has finished.
  if (response.status !== 202) {
    throw new Error(
      "Background worker dispatch failed: HTTP " +
      response.status
    );
  }

  console.log(
    "[Stripe Webhook] Fulfillment job accepted",
    { sessionId }
  );

  return true;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return {
      ...respond(405, {
        error: "Method not allowed"
      }),
      headers: {
        ...HEADERS,
        Allow: "POST"
      }
    };
  }

  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error(
      "Stripe webhook secret is missing"
    );

    return respond(500, {
      error: "Webhook not configured"
    });
  }

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(
          event.body || "",
          "base64"
        ).toString("utf8")
      : event.body || "";

    const signature =
      event.headers?.["stripe-signature"] ||
      event.headers?.["Stripe-Signature"];

    if (
      !verifyStripeSignature(
        rawBody,
        signature,
        webhookSecret
      )
    ) {
      console.warn(
        "Invalid Stripe webhook signature"
      );

      return respond(400, {
        error: "Invalid webhook signature"
      });
    }

    const stripeEvent = JSON.parse(rawBody);

    const supportedEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed"
    ];

    if (
      !supportedEvents.includes(
        stripeEvent.type
      )
    ) {
      return respond(200, {
        received: true,
        ignored: true
      });
    }

    const webhookSession =
      stripeEvent.data?.object;

    if (
      webhookSession?.metadata?.source !==
      "snappic-print-commerce"
    ) {
      return respond(200, {
        received: true,
        ignored: true,
        reason:
          "Not a Print Commerce transaction"
      });
    }

    if (
      typeof webhookSession.id !== "string" ||
      !/^cs_test_[A-Za-z0-9]+$/.test(
        webhookSession.id
      )
    ) {
      throw new Error(
        "Valid Stripe test session required"
      );
    }

    // Always retrieve authoritative details.
    const session = await retrieveStripeSession(
      webhookSession.id
    );

    if (
      session.metadata?.source !==
      "snappic-print-commerce"
    ) {
      return respond(200, {
        received: true,
        ignored: true
      });
    }

    if (
      session.id !== webhookSession.id ||
      session.livemode !== false
    ) {
      throw new Error(
        "Stripe session verification failed"
      );
    }

    const paymentSucceeded =
      session.payment_status === "paid";

    const paymentFailed =
      stripeEvent.type ===
      "checkout.session.async_payment_failed";

    connectLambda(event);

    const store = getStore(ORDER_STORE);
    const orderKey = `order-${session.id}`;

    const existing = await store.get(
      orderKey,
      { type: "json" }
    );

    // An already-paid order may have been
    // fulfilled or may still be pending.
    //
    // Never overwrite its fulfillment state.
    if (existing?.paymentStatus === "paid") {
      let dispatched = false;

      if (shouldDispatch(existing)) {
        await dispatchFulfillment(session.id);
        dispatched = true;
      }

      console.log(
        "[Stripe Webhook] Existing paid order",
        {
          sessionId: session.id,
          fulfillmentStatus:
            existing.fulfillment?.status || null,
          dispatched
        }
      );

      return respond(200, {
        received: true,
        printCommerce: true,
        alreadyRecorded: true,
        dispatched,
        sessionId: session.id
      });
    }

    if (!paymentSucceeded && !paymentFailed) {
      return respond(200, {
        received: true,
        printCommerce: true,
        awaitingPayment: true,
        sessionId: session.id
      });
    }

    let manifest = null;

    if (paymentSucceeded) {
      manifest = reconstructManifest(
        session.metadata
      );
    }

    const shipping = getShippingDetails(
      session
    );

    if (paymentSucceeded) {
      if (
        !shipping.name ||
        !shipping.address?.line1 ||
        !shipping.address?.city ||
        !shipping.address?.state ||
        !shipping.address?.postal_code ||
        shipping.address?.country !== "US"
      ) {
        throw new Error(
          "Paid order is missing required US shipping details"
        );
      }
    }

    const now = new Date().toISOString();

    const record = {
      application: "snappic-print-commerce",
      version: 1,

      sessionId: session.id,
      paymentIntentId:
        session.payment_intent || null,

      stripeEventId: stripeEvent.id,
      stripeEventType: stripeEvent.type,

      paymentStatus: paymentSucceeded
        ? "paid"
        : "failed",

      amountTotal: session.amount_total,
      currency: session.currency,

      shipping,
      manifest,

      fulfillment: {
        status: paymentSucceeded
          ? "pending"
          : "not_required",
        provider: "prodigi",
        prodigiOrderId: null,
        attempts: 0,
        lastError: null
      },

      createdAt:
        existing?.createdAt || now,
      updatedAt: now
    };

    // Save payment details before dispatch.
    await store.setJSON(
      orderKey,
      record
    );

    console.log(
      "[Stripe Webhook] Order recorded",
      {
        sessionId: session.id,
        paymentStatus:
          record.paymentStatus,
        itemCount:
          manifest?.items?.length || 0,
        fulfillmentStatus:
          record.fulfillment.status
      }
    );

    let dispatched = false;

    if (shouldDispatch(record)) {
      await dispatchFulfillment(session.id);
      dispatched = true;
    }

    return respond(200, {
      received: true,
      printCommerce: true,
      paymentSucceeded,
      paymentFailed,
      orderRecorded: true,
      dispatched,
      sessionId: session.id
    });

  } catch (error) {
    console.error(
      "[Stripe Webhook] Processing error",
      error.message
    );

    // Stripe may retry webhook delivery
    // when this endpoint returns non-2xx.
    return respond(500, {
      error: "Webhook processing failed"
    });
  }
};
