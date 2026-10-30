
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
  if (!process.env.URL) {
    throw new Error("Netlify URL is missing");
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
    throw new Error("Invalid Netlify URL");
  }

  return url.origin;
}

async function callFunction(name, sessionId) {
  const url =
    `${getSiteURL()}/.netlify/functions/${name}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inspect-token":
        process.env.ORDER_INSPECT_TOKEN
    },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(90000)
  });

  let result = {};

  try {
    result = await response.json();
  } catch (_) {}

  if (!response.ok || result.success !== true) {
    const error = new Error(
      `${name} failed with HTTP ${response.status}`
    );

    error.statusCode = response.status;
    error.fulfillmentStatus =
      result.fulfillmentStatus || null;

    throw error;
  }

  return result;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    console.warn(
      "[Fulfillment Worker] Invalid method"
    );
    return;
  }

  const expected =
    process.env.FULFILLMENT_WORKER_TOKEN;

  const supplied =
    event.headers?.["x-fulfillment-token"] ||
    event.headers?.["X-Fulfillment-Token"];

  if (
    !expected ||
    !safeEqual(supplied, expected)
  ) {
    console.warn(
      "[Fulfillment Worker] Unauthorized"
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
    sessionId = JSON.parse(
      event.body || "{}"
    ).sessionId;
  } catch (_) {
    console.error(
      "[Fulfillment Worker] Invalid JSON"
    );
    return;
  }

  if (
    typeof sessionId !== "string" ||
    !/^cs_test_[A-Za-z0-9]+$/.test(sessionId)
  ) {
    console.error(
      "[Fulfillment Worker] Invalid test session"
    );
    return;
  }

  connectLambda(event);

  const store = getStore(ORDER_STORE);

  const order = await store.get(
    `order-${sessionId}`,
    { type: "json" }
  );

  if (
    !order ||
    order.application !== "snappic-print-commerce" ||
    order.sessionId !== sessionId ||
    order.paymentStatus !== "paid"
  ) {
    console.error(
      "[Fulfillment Worker] Valid paid order not found",
      { sessionId }
    );
    return;
  }

  const fulfillment = order.fulfillment || {};

  if (
    fulfillment.prodigiOrderId ||
    ["submitting", "needs_review"].includes(
      fulfillment.status
    )
  ) {
    console.log(
      "[Fulfillment Worker] Skipping existing submission",
      {
        sessionId,
        status: fulfillment.status
      }
    );
    return;
  }

  console.log(
    "[Fulfillment Worker] Preparing images",
    { sessionId }
  );

  try {
    await callFunction(
      "prepare-images",
      sessionId
    );

    console.log(
      "[Fulfillment Worker] Images ready",
      { sessionId }
    );
  } catch (error) {
    console.error(
      "[Fulfillment Worker] Image preparation failed",
      {
        sessionId,
        error: error.message
      }
    );
    throw error;
  }

  console.log(
    "[Fulfillment Worker] Submitting to Prodigi",
    { sessionId }
  );

  try {
    const result = await callFunction(
      "fulfill-prodigi",
      sessionId
    );

    console.log(
      "[Fulfillment Worker] Prodigi result",
      {
        sessionId,
        prodigiOrderId:
          result.prodigiOrderId || null,
        fulfillmentStatus:
          result.fulfillmentStatus || null,
        alreadySubmitted:
          result.alreadySubmitted || false
      }
    );

  } catch (error) {
    console.error(
      "[Fulfillment Worker] Prodigi submission needs attention",
      {
        sessionId,
        error: error.message,
        fulfillmentStatus:
          error.fulfillmentStatus
      }
    );

    // Do not automatically retry an uncertain
    // Prodigi submission.
    throw error;
  }
};
