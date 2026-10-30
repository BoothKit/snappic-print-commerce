
"use strict";

const crypto = require("node:crypto");
const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const PRODIGI_API =
  "https://api.sandbox.prodigi.com/v4.0/orders";

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
      url.origin !== getSiteURL() ||
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

    // Verify that Prodigi can retrieve the JPEG.
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
    sessionId = JSON.parse(
      event.body || "{}"
    ).sessionId;
  } catch (_) {
    return respond(400, {
      error: "Invalid JSON body"
    });
  }

  // Test mode only. Do not enable live
  // payments in this step.
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

    const fulfillmentStatus =
      order.fulfillment?.status;

    const prodigiOrderId =
      order.fulfillment?.prodigiOrderId || null;

    // An existing Prodigi ID means we should
    // never submit this order again.
    if (prodigiOrderId) {
      return respond(200, {
        success: true,
        alreadySubmitted: true,
        sessionId,
        prodigiOrderId,
        fulfillmentStatus
      });
    }

    // An uncertain previous attempt must be
    // reconciled before retrying.
    //
    // Blobs are not an atomic lock.
    // Prodigi's idempotency key remains the
    // final duplicate-submission safeguard.
    if (
      ["submitting", "needs_review"].includes(
        fulfillmentStatus
      )
    ) {
      return respond(409, {
        success: false,
        sessionId,
        fulfillmentStatus,
        error:
          "Previous submission may have reached Prodigi. Reconcile before retrying."
      });
    }

    const validated = validateOrder(
      order,
      sessionId
    );

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

    const now = new Date().toISOString();

    const attempting = {
      ...order.fulfillment,
      provider: "prodigi",
      status: "submitting",
      attempts:
        (order.fulfillment?.attempts || 0) + 1,
      lastAttemptAt: now,
      lastError: null,
      idempotencyKey: sessionId
    };

    // Record the attempt BEFORE contacting Prodigi.
    await store.setJSON(orderKey, {
      ...order,
      fulfillment: attempting,
      updatedAt: now
    });

    let response;
    let rawResponse;

    try {
      response = await fetch(PRODIGI_API, {
        method: "POST",
        headers: {
          "X-API-Key":
            process.env.PRODIGI_API_KEY,
          "Content-Type":
            "application/json",
          "Accept":
            "application/json"
        },
        body: JSON.stringify(prodigiOrder),
        signal: AbortSignal.timeout(20000)
      });

      rawResponse = await response.text();

    } catch (error) {
      // A timeout does not prove Prodigi
      // rejected the order.
      const reviewedAt =
        new Date().toISOString();

      await store.setJSON(orderKey, {
        ...order,
        fulfillment: {
          ...attempting,
          status: "needs_review",
          lastError:
            `Prodigi response unknown: ${error.message}`
        },
        updatedAt: reviewedAt
      });

      console.error(
        "[Prodigi] Uncertain submission",
        {
          sessionId,
          error: error.message
        }
      );

      return respond(502, {
        success: false,
        sessionId,
        fulfillmentStatus: "needs_review",
        error:
          "Prodigi submission outcome unknown; reconcile before retrying"
      });
    }

    let result = {};

    try {
      result = JSON.parse(rawResponse);
    } catch (_) {}

    const outcome =
      typeof result.outcome === "string"
        ? result.outcome
        : null;

    const normalized =
      (outcome || "").toLowerCase();

    const returnedId =
      result.order?.id ||
      result.id ||
      null;

    const acceptedOutcomes = [
      "created",
      "alreadyexists",
      "createdwithissues",
      "onhold"
    ];

    const accepted =
      response.ok &&
      acceptedOutcomes.includes(normalized) &&
      !!returnedId;

    const reviewRequired = [
      "createdwithissues",
      "onhold"
    ].includes(normalized);

    const finishedAt =
      new Date().toISOString();

    const updatedFulfillment = {
      ...attempting,
      lastOutcome: outcome,
      lastHttpStatus: response.status,

      status: accepted
        ? (
            reviewRequired
              ? "needs_review"
              : "submitted"
          )
        : "needs_review",

      prodigiOrderId:
        accepted ? returnedId : null,

      submittedAt:
        accepted ? finishedAt : null,

      lastError:
        accepted
          ? null
          : `Prodigi HTTP ${response.status}; outcome: ${
              outcome || "unknown"
            }. Reconcile before retrying.`
    };

    await store.setJSON(orderKey, {
      ...order,
      fulfillment: updatedFulfillment,
      updatedAt: finishedAt
    });

    console.log(
      "[Prodigi] Submission result",
      {
        sessionId,
        httpStatus: response.status,
        outcome,
        prodigiOrderId: returnedId,
        fulfillmentStatus:
          updatedFulfillment.status
      }
    );

    return respond(
      accepted ? 200 : 502,
      {
        success: accepted,
        sessionId,
        prodigiStatus: response.status,
        outcome,
        prodigiOrderId:
          accepted ? returnedId : null,
        fulfillmentStatus:
          updatedFulfillment.status,
        totalPrints:
          validated.totalPrints
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
