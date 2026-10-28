
"use strict";

const STRIPE_API =
  "https://api.stripe.com/v1/checkout/sessions";

const SITE_URL =
  process.env.URL ||
  "https://snappic-print-commerce.netlify.app";

const PRICES = {
  "4x6": 499,
  "5x7": 699
};

const MAX_QUANTITY = 50;
const MAX_TOTAL_PRINTS = 50;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function respond(statusCode, data) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data)
  };
}

function validateImageURL(value) {
  if (typeof value !== "string") return null;

  if (value.length > 1800) return null;

  try {
    const url = new URL(value);

    if (url.protocol !== "https:") {
      return null;
    }

    // The photo URL must resemble a supported
    // Snappic image endpoint.
    const validPath =
      url.pathname.includes("/photo/still/") ||
      url.pathname.includes(
        "/media/download/photo/"
      );

    if (!validPath) return null;

    if (
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }

    return url.toString();

  } catch (_) {
    return null;
  }
}

function validateItems(items) {
  if (!Array.isArray(items)) {
    throw new Error("Invalid print items.");
  }

  if (items.length < 1 || items.length > 2) {
    throw new Error(
      "Select one or two photos."
    );
  }

  const normalized = items.map(item => {
    if (!item || typeof item !== "object") {
      throw new Error("Invalid print item.");
    }

    const imageUrl =
      validateImageURL(item.imageUrl);

    const printSize = item.printSize;
    const quantity = item.quantity;

    if (!imageUrl) {
      throw new Error(
        "Invalid or unsupported photo URL."
      );
    }

    if (!Object.hasOwn(PRICES, printSize)) {
      throw new Error(
        "Unsupported print size."
      );
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      throw new Error(
        "Invalid print quantity."
      );
    }

    if (item.finish !== "gloss") {
      throw new Error(
        "Unsupported print finish."
      );
    }

    const imageId =
      item.imageId === "original"
        ? "original"
        : "main";

    return {
      imageId,
      imageUrl,
      printSize,
      quantity,
      finish: "gloss"
    };
  });

  const totalPrints = normalized.reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  if (totalPrints > MAX_TOTAL_PRINTS) {
    throw new Error(
      "Maximum 50 prints per order."
    );
  }

  if (
    new Set(
      normalized.map(item => item.imageId)
    ).size !== normalized.length
  ) {
    throw new Error(
      "Duplicate photo selections."
    );
  }

  return normalized;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return respond(405, {
      error: "Method not allowed."
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error(
      "Missing STRIPE_SECRET_KEY."
    );

    return respond(500, {
      error: "Checkout is not configured."
    });
  }

  let items;

  try {
    if (
      !event.body ||
      event.body.length > 12000
    ) {
      throw new Error(
        "Invalid request size."
      );
    }

    const payload = JSON.parse(event.body);

    if (
      payload.source !==
      "snappic-print-commerce"
    ) {
      throw new Error(
        "Invalid checkout source."
      );
    }

    items = validateItems(payload.items);

  } catch (error) {
    return respond(400, {
      error: error.message
    });
  }

  // Compact order manifest for Stripe metadata.
  // Full image URLs are retained for later fulfillment.
  const manifest = JSON.stringify({
    version: 1,
    items: items.map(item => ({
      id: item.imageId,
      url: item.imageUrl,
      size: item.printSize,
      qty: item.quantity,
      finish: item.finish
    }))
  });

  // Stripe metadata values have a 500-character limit.
  // Split the manifest into indexed chunks.
  const chunks = manifest.match(/.{1,450}/gs) || [];

  if (chunks.length > 12) {
    return respond(400, {
      error: "Photo URLs are too long."
    });
  }

  const params = new URLSearchParams();

  params.set("mode", "payment");

  params.set(
    "payment_method_types[0]",
    "card"
  );

  params.set(
    "shipping_address_collection[allowed_countries][0]",
    "US"
  );

  params.set(
    "shipping_options[0][shipping_rate_data][type]",
    "fixed_amount"
  );

  params.set(
    "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
    "699"
  );

  params.set(
    "shipping_options[0][shipping_rate_data][fixed_amount][currency]",
    "usd"
  );

  params.set(
    "shipping_options[0][shipping_rate_data][display_name]",
    "Budget Shipping - Test"
  );

  items.forEach((item, index) => {
    const prefix = `line_items[${index}]`;

    params.set(
      `${prefix}[price_data][currency]`,
      "usd"
    );

    params.set(
      `${prefix}[price_data][unit_amount]`,
      String(PRICES[item.printSize])
    );

    params.set(
      `${prefix}[price_data][product_data][name]`,
      `${item.printSize.replace("x", "×")} Gloss Photo Print`
    );

    params.set(
      `${prefix}[quantity]`,
      String(item.quantity)
    );
  });

  params.set(
    "metadata[source]",
    "snappic-print-commerce"
  );

  params.set(
    "metadata[environment]",
    "test"
  );

  params.set(
    "metadata[manifest_chunks]",
    String(chunks.length)
  );

  chunks.forEach((chunk, index) => {
    params.set(
      `metadata[manifest_${index}]`,
      chunk
    );
  });

  params.set(
    "success_url",
    SITE_URL +
      "/?checkout=success&session_id=" +
      "{CHECKOUT_SESSION_ID}"
  );

  params.set(
    "cancel_url",
    SITE_URL + "/?checkout=cancelled"
  );

  try {
    const response = await fetch(
      STRIPE_API,
      {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " +
            process.env.STRIPE_SECRET_KEY,
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Stripe checkout creation failed:",
        data.error?.message
      );

      return respond(502, {
        error:
          "Unable to create Stripe Checkout."
      });
    }

    return respond(200, {
      success: true,
      checkoutUrl: data.url,
      sessionId: data.id
    });

  } catch (error) {
    console.error(
      "Stripe request error:",
      error.message
    );

    return respond(502, {
      error:
        "Checkout service is temporarily unavailable."
    });
  }
};
