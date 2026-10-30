
"use strict";

const crypto = require("node:crypto");
const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const ORDER_STORE = "print-commerce-orders";

function safeEqual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) {
    return false;
  }

  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return (
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

function getSiteURL() {
  const configured = process.env.URL;

  if (!configured) {
    throw new Error("Netlify URL is not configured");
  }

  const url = new URL(configured);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Invalid Netlify URL");
  }

  return url.origin;
}

async function prepareImages(sessionId) {
  const url =
    getSiteURL() +
    "/.netlify/functions/prepare-images";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inspect-token":
        process.env.ORDER_INSPECT_TOKEN
    },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(
      `Image preparation failed: HTTP ${response.status}`
    );
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error("Image preparation unsuccessful");
  }

  return result.imageCount;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    console.warn("Background worker: invalid method");
    return;
  }

  const suppliedToken =
    event.headers?.["x-fulfillment-token"] ||
    event.headers?.["X-Fulfillment-Token"];

  const expectedToken =
    process.env.FULFILLMENT_WORKER_TOKEN;

  if (
    !expectedToken ||
    !safeEqual(suppliedToken, expectedToken)
  ) {
    console.warn(
      "Background worker: unauthorized request"
    );
    return;
  }

  if (!process.env.ORDER_INSPECT_TOKEN) {
    throw new Error(
      "ORDER_INSPECT_TOKEN is missing"
    );
  }

  let sessionId;

  try {
    const payload = JSON.parse(
      event.body || "{}"
    );

    sessionId = payload.sessionId;
  } catch (_) {
    console.error(
      "Background worker: invalid JSON"
    );
    return;
  }

  if (
    typeof sessionId !== "string" ||
    !/^cs_test_[A-Za-z0-9]+$/.test(sessionId)
  ) {
    console.warn(
      "Background worker: invalid session ID"
    );
    return;
  }

  connectLambda(event);

  const orders = getStore(ORDER_STORE);

  const order = await orders.get(
    `order-${sessionId}`,
    { type: "json" }
  );

  if (
    !order ||
    order.application !== "snappic-print-commerce" ||
    order.sessionId !== sessionId ||
    order.paymentStatus !== "paid"
  ) {
    console.warn(
      "Background worker: paid order not found"
    );
    return;
  }

  if (
    order.fulfillment?.status === "submitted" ||
    order.fulfillment?.status === "needs_review" ||
    order.fulfillment?.prodigiOrderId
  ) {
    console.log(
      "Background worker: order already submitted"
    );
    return;
  }

  console.log(
    "[Fulfillment Worker] Starting image preparation",
    { sessionId }
  );

  try {
    const imageCount =
      await prepareImages(sessionId);

    console.log(
      "[Fulfillment Worker] Images prepared",
      { sessionId, imageCount }
    );

    // Prodigi submission is intentionally not
    // enabled yet. We must add an atomic order
    // claim and duplicate-submission protection
    // before allowing unattended fulfillment.

  } catch (error) {
    console.error(
      "[Fulfillment Worker] Preparation failed",
      {
        sessionId,
        error: error.message
      }
    );

    throw error;
  }
};
