
"use strict";

const crypto = require("node:crypto");
const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const STORE_NAME = "print-commerce-orders";

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

  if (order.application !== "snappic-print-commerce") {
    throw new Error("Invalid order application");
  }

  if (order.sessionId !== sessionId) {
    throw new Error("Session ID mismatch");
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
    throw new Error("Invalid order items");
  }

  let totalPrints = 0;

  for (const item of items) {
    if (!Object.hasOwn(PRODUCTS, item.size)) {
      throw new Error("Unsupported print size");
    }

    if (
      typeof item.url !== "string" ||
      !item.url.startsWith("https://")
    ) {
      throw new Error("Missing or invalid photo URL");
    }

    if (
      !Number.isInteger(item.qty) ||
      item.qty < 1 ||
      item.qty > 50
    ) {
      throw new Error("Invalid print quantity");
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

exports.handler = async function(event) {
  if (event.httpMethod !== "GET") {
    return respond(405, {
      error: "Method not allowed"
    });
  }

  if (!authorized(event)) {
    return respond(401, {
      error: "Unauthorized"
    });
  }

  const sessionId =
    event.queryStringParameters?.session;

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

    const store = getStore(STORE_NAME);

    const order = await store.get(
      `order-${sessionId}`,
      { type: "json" }
    );

    if (!order) {
      return respond(404, {
        error: "Order not found"
      });
    }

    const validated = validateOrder(
      order,
      sessionId
    );

    const shipping = order.shipping;

    // Prepare the recipient information.
    // Omit line2 when absent.
    const recipient = {
      name: shipping.name,
      email: shipping.email || undefined,
      phone: shipping.phone || undefined,
      address: {
        line1: validated.address.line1,
        city: validated.address.city,
        state: validated.address.state,
        postalCode: validated.address.postal_code,
        countryCode: validated.address.country
      }
    };

    if (validated.address.line2?.trim()) {
      recipient.address.line2 =
        validated.address.line2.trim();
    }

    // Prepare print specifications.
    const printItems = validated.items.map(
      item => ({
        imageId: item.id,
        sku: PRODUCTS[item.size],
        copies: item.qty,
        finish: item.finish,
        imageUrl: item.url
      })
    );

    // This is a preview of the information
    // needed for the Prodigi order.
    // No Prodigi API request is made.
    const prepared = {
      environment: "sandbox",
      idempotencyKey: sessionId,
      shippingMethod: "Budget",
      recipient,
      items: printItems
    };

    console.log(
      "Prodigi dry run validated:",
      {
        sessionId,
        itemCount: printItems.length,
        totalPrints: validated.totalPrints
      }
    );

    // Return a privacy-safe summary.
    // Do not expose customer details or URLs.
    return respond(200, {
      success: true,
      dryRun: true,
      readyForProdigi: true,
      sessionId,
      idempotencyKey: sessionId,
      shippingMethod: prepared.shippingMethod,
      recipient: {
        hasName: !!recipient.name,
        hasEmail: !!recipient.email,
        hasAddressLine1: !!recipient.address.line1,
        hasAddressLine2: !!recipient.address.line2,
        hasCity: !!recipient.address.city,
        hasState: !!recipient.address.state,
        hasPostalCode: !!recipient.address.postalCode,
        countryCode: recipient.address.countryCode
      },
      items: printItems.map(item => ({
        imageId: item.imageId,
        sku: item.sku,
        copies: item.copies,
        finish: item.finish,
        hasImageUrl: !!item.imageUrl
      })),
      totalPrints: validated.totalPrints,
      fulfillmentStatus:
        order.fulfillment?.status || null
    });

  } catch (error) {
    console.error(
      "Prodigi preparation error:",
      error.message
    );

    return respond(422, {
      success: false,
      error: error.message
    });
  }
};
