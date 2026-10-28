
const crypto = require("node:crypto");

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function verifyStripeSignature(payload, signatureHeader, secret) {
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

  if (!timestamp || !signatures.length) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber)) return false;

  // Reject signatures older than five minutes.
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestampNumber) > 300) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest();

  return signatures.some(signature => {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

    const received = Buffer.from(signature, "hex");

    return (
      received.length === expected.length &&
      crypto.timingSafeEqual(received, expected)
    );
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        ...HEADERS,
        Allow: "POST"
      },
      body: JSON.stringify({
        error: "Method not allowed"
      })
    };
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("Stripe webhook secret is missing");

    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({
        error: "Webhook not configured"
      })
    };
  }

  try {
    // Netlify provides the request body as a string.
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
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
      console.warn("Invalid Stripe webhook signature");

      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({
          error: "Invalid webhook signature"
        })
      };
    }

    const stripeEvent = JSON.parse(rawBody);

    const supportedEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed"
    ];

    if (!supportedEvents.includes(stripeEvent.type)) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          received: true,
          ignored: true
        })
      };
    }

    const session = stripeEvent.data?.object;

    // Ignore transactions unrelated to Print Commerce.
    if (
      session?.metadata?.source !== "snappic-print-commerce"
    ) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          received: true,
          ignored: true,
          reason: "Not a Print Commerce transaction"
        })
      };
    }

    const paymentSucceeded =
      stripeEvent.type ===
        "checkout.session.async_payment_succeeded" ||
      (
        stripeEvent.type ===
          "checkout.session.completed" &&
        session.payment_status === "paid"
      );

    const paymentFailed =
      stripeEvent.type ===
      "checkout.session.async_payment_failed";

    console.log("Print Commerce webhook received:", {
      eventId: stripeEvent.id,
      eventType: stripeEvent.type,
      sessionId: session.id,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentSucceeded,
      paymentFailed
    });

    // TEST PHASE ONLY:
    // No order records or Prodigi fulfillment yet.

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        received: true,
        printCommerce: true,
        paymentSucceeded,
        paymentFailed
      })
    };

  } catch (error) {
    console.error("Webhook processing error:", error.message);

    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({
        error: "Webhook processing failed"
      })
    };
  }
};
