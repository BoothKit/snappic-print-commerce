
"use strict";

const crypto = require("node:crypto");
const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const ORDER_STORE = "print-commerce-orders";
const IMAGE_STORE = "print-commerce-images";

// NEW: Separate store for execution diagnostics.
// This never modifies the actual order record.
const DIAGNOSTIC_STORE = "print-commerce-diagnostics";

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

function validSessionId(value) {
  return (
    typeof value === "string" &&
    /^cs_test_[A-Za-z0-9]+$/.test(value)
  );
}

// NEW: Save a timestamped diagnostic checkpoint.
//
// Diagnostics live in their own Netlify Blobs store,
// separate from payment and fulfillment records.
//
// Never store tokens, signed image URLs, or
// customer information in these records.
async function saveCheckpoint(
  sessionId,
  stage,
  details = {}
) {
  const diagnostics = getStore(
    DIAGNOSTIC_STORE
  );

  const key = `worker/${sessionId}`;

  const previous = await diagnostics.get(
    key,
    { type: "json" }
  );

  const history = Array.isArray(
    previous?.history
  )
    ? previous.history.slice(-29)
    : [];

  const entry = {
    stage,
    timestamp: new Date().toISOString(),
    ...details
  };

  history.push(entry);

  await diagnostics.setJSON(key, {
    sessionId,
    stage,
    updatedAt: entry.timestamp,
    history
  });

  console.log(
    "[Fulfillment Worker] Checkpoint",
    {
      sessionId,
      stage
    }
  );
}

// NEW: Record diagnostics without changing the
// original fulfillment flow if diagnostic storage
// temporarily fails.
async function recordCheckpoint(
  sessionId,
  stage,
  details = {}
) {
  try {
    await saveCheckpoint(
      sessionId,
      stage,
      details
    );
  } catch (error) {
    console.error(
      "[Fulfillment Worker] Diagnostic write failed",
      {
        sessionId,
        stage,
        error: error.message
      }
    );
  }
}

// NEW: Keep diagnostic errors concise and avoid
// storing URLs, tokens, or customer details.
function safeDiagnosticError(error) {
  const message = String(
    error?.message || "Unknown error"
  );

  if (
    message.includes("http") ||
    message.includes("token") ||
    message.includes("?")
  ) {
    return "Request or configuration error";
  }

  return message.slice(0, 180);
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

  if (
    !response.ok ||
    result.success !== true
  ) {
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

async function verifyHostedImages(
  sessionId,
  manifestItems
) {
  if (
    !Array.isArray(manifestItems) ||
    manifestItems.length < 1 ||
    manifestItems.length > 2
  ) {
    throw new Error("Invalid order image manifest");
  }

  const images = getStore(IMAGE_STORE);
  const seen = new Set();

  for (const item of manifestItems) {
    if (
      !item ||
      !["main", "original"].includes(item.id) ||
      seen.has(item.id)
    ) {
      throw new Error("Invalid manifest image ID");
    }

    seen.add(item.id);

    const delivery = await images.get(
      `delivery/${sessionId}/${item.id}`,
      { type: "json" }
    );

    if (
      !delivery ||
      typeof delivery.deliveryURL !== "string"
    ) {
      throw new Error(
        `Hosted image not prepared: ${item.id}`
      );
    }

    let url;

    try {
      url = new URL(delivery.deliveryURL);
    } catch (_) {
      throw new Error(
        `Invalid delivery URL: ${item.id}`
      );
    }

    if (
      url.origin !== getSiteURL() ||
      url.pathname !==
        "/.netlify/functions/serve-image" ||
      url.searchParams.get("sessionId") !==
        sessionId ||
      url.searchParams.get("imageId") !==
        item.id ||
      !/^[a-f0-9]{64}$/.test(
        url.searchParams.get("token") || ""
      )
    ) {
      throw new Error(
        `Invalid hosted image delivery record: ${item.id}`
      );
    }

    const response = await fetch(
      url.toString(),
      {
        method: "GET",
        signal: AbortSignal.timeout(15000)
      }
    );

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
        `Invalid hosted JPEG: ${item.id}`
      );
    }

    console.log(
      "[Fulfillment Worker] Verified hosted image",
      {
        sessionId,
        imageId: item.id,
        bytes: bytes.length
      }
    );
  }

  return seen.size;
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

  if (!validSessionId(sessionId)) {
    console.error(
      "[Fulfillment Worker] Invalid test session"
    );
    return;
  }

  connectLambda(event);

  // NEW: First persistent checkpoint.
  // Confirms the request passed authentication
  // and contained a valid test session ID.
  await recordCheckpoint(
    sessionId,
    "authenticated"
  );

  
  const orders = getStore(ORDER_STORE);

  let order = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    await recordCheckpoint(
      sessionId,
      "reading_order",
      { attempt }
    );

    try {
      // Use the original Netlify Blobs read format.
      order = await orders.get(
  `order-${sessionId}`,
  { type: "json" }
);
    } catch (error) {
      console.error(
        "[Fulfillment Worker] Order read failed",
        {
          sessionId,
          attempt,
          error: error.message
        }
      );

      await recordCheckpoint(
        sessionId,
        "order_read_failed",
        {
          attempt,
          error: safeDiagnosticError(error)
        }
      );

      // Do not treat a storage error as
      // proof that an order is missing.
      throw error;
    }

    const validOrder =
      order?.application === "snappic-print-commerce" &&
      order?.sessionId === sessionId &&
      order?.paymentStatus === "paid";

    if (validOrder) {
      console.log(
        "[Fulfillment Worker] Paid order found",
        { sessionId, attempt }
      );

      await recordCheckpoint(
        sessionId,
        "paid_order_verified",
        { attempt }
      );

      break;
    }

    console.warn(
  "[Fulfillment Worker] Paid order not visible yet",
  {
    sessionId,
    attempt,
    recordExists: !!order,
    application: order?.application || null,
    sessionMatches: order?.sessionId === sessionId,
    paymentStatus: order?.paymentStatus || null
  }
);
    await recordCheckpoint(
      sessionId,
      "order_not_visible",
      {
        attempt,
        recordExists: !!order
      }
    );

    if (attempt < 5) {
      await new Promise(resolve =>
        setTimeout(resolve, 2000)
      );
    }
  }

  if (
    !order ||
    order.application !==
      "snappic-print-commerce" ||
    order.sessionId !== sessionId ||
    order.paymentStatus !== "paid"
  ) {
    console.error(
      "[Fulfillment Worker] Valid paid order not found",
      { sessionId }
    );

    await recordCheckpoint(
      sessionId,
      "order_not_found_or_unpaid"
    );

    return;
  }


  const fulfillment = order.fulfillment || {};

  if (
    fulfillment.prodigiOrderId ||
    [
      "submitting",
      "needs_review"
    ].includes(fulfillment.status)
  ) {
    console.log(
      "[Fulfillment Worker] Skipping existing submission",
      {
        sessionId,
        status: fulfillment.status,
        prodigiOrderId:
          fulfillment.prodigiOrderId || null
      }
    );

    // NEW
    await recordCheckpoint(
      sessionId,
      "skipped_existing_submission",
      {
        fulfillmentStatus:
          fulfillment.status || null,
        prodigiOrderId:
          fulfillment.prodigiOrderId || null
      }
    );

    return;
  }

  console.log(
    "[Fulfillment Worker] Preparing images",
    { sessionId }
  );

  // NEW
  await recordCheckpoint(
    sessionId,
    "preparing_images"
  );

  try {
    await callFunction(
      "prepare-images",
      sessionId
    );

    // NEW
    await recordCheckpoint(
      sessionId,
      "images_prepared"
    );

    const verifiedCount =
      await verifyHostedImages(
        sessionId,
        order.manifest?.items
      );

    console.log(
      "[Fulfillment Worker] All images verified",
      {
        sessionId,
        verifiedCount
      }
    );

    // NEW
    await recordCheckpoint(
      sessionId,
      "images_verified",
      {
        verifiedCount
      }
    );
  } catch (error) {
    console.error(
      "[Fulfillment Worker] Image preparation or verification failed",
      {
        sessionId,
        error: error.message
      }
    );

    // NEW
    await recordCheckpoint(
      sessionId,
      "image_preparation_failed",
      {
        error: safeDiagnosticError(error),
        statusCode:
          error.statusCode || null
      }
    );

    // Original behavior: stop incomplete orders.
    throw error;
  }

  console.log(
    "[Fulfillment Worker] Submitting to Prodigi",
    { sessionId }
  );

  // NEW
  await recordCheckpoint(
    sessionId,
    "submitting_to_prodigi"
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

    // NEW
    await recordCheckpoint(
      sessionId,
      "submitted",
      {
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

    // NEW
    await recordCheckpoint(
      sessionId,
      "prodigi_submission_failed",
      {
        error: safeDiagnosticError(error),
        statusCode:
          error.statusCode || null,
        fulfillmentStatus:
          error.fulfillmentStatus || null
      }
    );

    // Original behavior: never blindly retry
    // an uncertain Prodigi submission.
    throw error;
  }
};
