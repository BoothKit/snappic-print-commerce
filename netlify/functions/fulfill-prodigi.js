
"use strict";

const crypto = require("node:crypto");
const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const PRODIGI_API =
  "https://api.sandbox.prodigi.com/v4.0/orders";

const SITE_URL =
  "https://snappic-print-commerce.netlify.app";

const ORDER_STORE = "print-commerce-orders";
const IMAGE_STORE = "print-commerce-images";

const PRODUCTS = {
  "4x6": "GLOBAL-PHO-4X6",
  "5x7": "GLOBAL-PHO-5X7-PRO"
};

function respond(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  };
}

function authorized(event) {
  const expected = process.env.ORDER_INSPECT_TOKEN;

  const supplied =
    event.headers?.["x-inspect-token"] ||
    event.headers?.["X-Inspect-Token"];

  if (!expected || !supplied) return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

function validateOrder(order, sessionId) {
  if (!order) {
    throw new Error("Order not found");
  }

  if (
    order.application !== "snappic-print-commerce" ||
    order.sessionId !== sessionId
  ) {
    throw new Error("Invalid order record");
  }

  if (order.paymentStatus !== "paid") {
    throw new Error("Order has not been paid");
  }

  const address = order.shipping?.address;

  if (
    !order.shipping?.name ||
    !address?.line1 ||
    !address?.city ||
    !address?.state ||
    !address?.postal_code ||
    address.country !== "US"
  ) {
    throw new Error("Incomplete shipping address");
  }

  const items = order.manifest?.items;

  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > 2
  ) {
    throw new Error("Invalid print items");
  }

  const seenIds = new Set();
  let totalPrints = 0;

  for (const item of items) {
    if (
      !["main", "original"].includes(item.id) ||
      seenIds.has(item.id)
    ) {
      throw new Error("Invalid photo selection");
    }

    seenIds.add(item.id);

    if (!Object.hasOwn(PRODUCTS, item.size)) {
      throw new Error("Unsupported print size");
    }

    if (
      typeof item.url !== "string" ||
      !item.url.startsWith("https://")
    ) {
      throw new Error("Invalid source photo URL");
    }

    if (
      !Number.isInteger(item.qty) ||
      item.qty < 1 ||
      item.qty > 50
    ) {
      throw new Error("Invalid quantity");
    }

    if (item.finish !== "gloss") {
      throw new Error("Unsupported finish");
    }

    totalPrints += item.qty;
  }

  if (totalPrints > 50) {
    throw new Error("Maximum 50 prints per order");
  }

  return {
    address,
    items,
    totalPrints
  };
}

async function getHostedImages(sessionId, items) {
  const images = getStore(IMAGE_STORE);
  const hostedURLs = new Map();

  for (const item of items) {
    const delivery = await images.get(
      `delivery/${sessionId}/${item.id}`,
      { type: "json" }
    );

    if (!delivery?.deliveryURL) {
      throw new Error(
        `Hosted image not prepared: ${item.id}`
      );
    }

    const url = new URL(delivery.deliveryURL);
    const expectedPrefix =
      "/.netlify/functions/serve-image";

    if (
      url.origin !== SITE_URL ||
      url.pathname !== expectedPrefix ||
      url.searchParams.get("sessionId") !== sessionId ||
      url.searchParams.get("imageId") !== item.id ||
      !/^[a-f0-9]{64}$/.test(
        url.searchParams.get("token") || ""
      )
    ) {
      throw new Error(
        `Invalid hosted image URL: ${item.id}`
      );
    }

    // Check that our public delivery endpoint
    // can actually return the JPEG.
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(15000)
    });

    if (
      !response.ok ||
      !(
        response.headers.get("content-type") || ""
      ).toLowerCase().startsWith("image/jpeg")
    ) {
      throw new Error(
        `Hosted image unavailable: ${item.id} (HTTP ${response.status})`
      );
    }

    const bytes = Buffer.from(
      await response.arrayBuffer()
    );

    if (
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      throw new Error(
        `Hosted image is not JPEG: ${item.id}`
      );
    }

    hostedURLs.set(item.id, url.toString());
  }

  return hostedURLs;
}

function buildProdigiOrder(
  order,
  sessionId,
  validated,
  hostedURLs
) {
  const address = validated.address;
  const shipping = order.shipping;

  const recipientAddress = {
    line1: address.line1,
    postalOrZipCode: address.postal_code,
    countryCode: address.country,
    townOrCity: address.city,
    stateOrCounty: address.state
  };

  if (
    typeof address.line2 === "string" &&
    address.line2.trim()
  ) {
    recipientAddress.line2 =
      address.line2.trim();
  }

  const recipient = {
    name: shipping.name,
    address: recipientAddress
  };

  if (shipping.email) {
    recipient.email = shipping.email;
  }

  if (shipping.phone) {
    recipient.phone = shipping.phone;
  }

  const items = validated.items.map(item => ({
    sku: PRODUCTS[item.size],
    copies: item.qty,
    sizing: "fillPrintArea",
    attributes: {
      finish: "gloss"
    },
    assets: [
      {
        printArea: "default",
        url: hostedURLs.get(item.id)
      }
    ]
  }));

  return {
    merchantReference:
      `PC-${sessionId.slice(-24)}`,
    idempotencyKey: sessionId,
    shippingMethod: "Budget",
    recipient,
    items
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return respond(405, {
      error: "Method not allowed"
    });
  }

  if (!authorized(event)) {
    return respond(401, {
      error: "Unauthorized"
    });
  }

  if (!process.env.PRODIGI_API_KEY) {
    return respond(500, {
      error: "Prodigi API key is missing"
    });
  }

  let sessionId;

  try {
    const payload = JSON.parse(event.body || "{}");
    sessionId = payload.sessionId;
  } catch (_) {
    return respond(400, {
      error: "Invalid JSON body"
    });
  }

  if (
    typeof sessionId !== "string" ||
    !/^cs_test_[a-zA-Z0-9]+$/.test(sessionId)
  ) {
    return respond(400, {
      error: "Valid Stripe test session required"
    });
  }

  try {
    connectLambda(event);

    const store = getStore(ORDER_STORE);
    const orderKey = `order-${sessionId}`;

    const order = await store.get(orderKey, {
      type: "json"
    });

    if (!order) {
      return respond(404, {
        error: "Order not found"
      });
    }

    // Never resubmit an order that was already
    // accepted by Prodigi.
    if (
      order.fulfillment?.prodigiOrderId &&
      [
        "submitted",
        "needs_review"
      ].includes(order.fulfillment?.status)
    ) {
      return respond(200, {
        success: true,
        alreadySubmitted: true,
        sessionId,
        prodigiOrderId:
          order.fulfillment.prodigiOrderId,
        fulfillmentStatus:
          order.fulfillment.status
      });
    }

    const validated = validateOrder(
      order,
      sessionId
    );

    // Hosted images are mandatory.
    // Never fall back to original Snappic URLs.
    const hostedURLs = await getHostedImages(
      sessionId,
      validated.items
    );

    const prodigiOrder = buildProdigiOrder(
      order,
      sessionId,
      validated,
      hostedURLs
    );

    console.log(
      "[Prodigi Fulfillment] Submitting hosted images:",
      {
        sessionId,
        imageCount: hostedURLs.size,
        totalPrints: validated.totalPrints
      }
    );

    const response = await fetch(PRODIGI_API, {
      method: "POST",
      headers: {
        "X-API-Key": process.env.PRODIGI_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(prodigiOrder),
      signal: AbortSignal.timeout(20000)
    });

    const rawResponse = await response.text();

    let result;

    try {
      result = JSON.parse(rawResponse);
    } catch (_) {
      result = {};
    }

    const outcome = result.outcome || null;

    const prodigiOrderId =
      result.order?.id ||
      result.id ||
      null;

    const accepted =
      response.ok &&
      [
        "Created",
        "AlreadyExists",
        "CreatedWithIssues"
      ].includes(outcome) &&
      !!prodigiOrderId;

    const now = new Date().toISOString();

    const fulfillment = {
      ...order.fulfillment,
      provider: "prodigi",
      attempts:
        (order.fulfillment?.attempts || 0) + 1,
      lastAttemptAt: now,
      lastOutcome: outcome
    };

    if (accepted) {
      fulfillment.status =
        outcome === "CreatedWithIssues"
          ? "needs_review"
          : "submitted";

      fulfillment.prodigiOrderId =
        prodigiOrderId;

      fulfillment.lastError = null;
      fulfillment.submittedAt =
        order.fulfillment?.submittedAt || now;

    } else {
      fulfillment.status = "failed";
      fulfillment.lastError =
        `Prodigi HTTP ${response.status}; outcome: ${
          outcome || "unknown"
        }`;
    }

    await store.setJSON(orderKey, {
      ...order,
      fulfillment,
      updatedAt: now
    });

    console.log(
      "[Prodigi Fulfillment] Result:",
      {
        sessionId,
        prodigiStatus: response.status,
        outcome,
        prodigiOrderId,
        fulfillmentStatus: fulfillment.status
      }
    );

    return respond(
      accepted ? 200 : 502,
      {
        success: accepted,
        sessionId,
        prodigiStatus: response.status,
        outcome,
        prodigiOrderId,
        fulfillmentStatus: fulfillment.status,
        totalPrints: validated.totalPrints
      }
    );

  } catch (error) {
    console.error(
      "[Prodigi Fulfillment] Error:",
      error.message
    );

    return respond(500, {
      success: false,
      error: error.message
    });
  }
};
