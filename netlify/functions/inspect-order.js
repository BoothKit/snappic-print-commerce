
"use strict";

const { getStore, connectLambda } = require("@netlify/blobs");

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({
        error: "Method not allowed"
      })
    };
  }

  // Protect this temporary debugging endpoint.
  const expectedToken = process.env.ORDER_INSPECT_TOKEN;
  const suppliedToken =
    event.headers?.["x-inspect-token"] ||
    event.headers?.["X-Inspect-Token"];

  if (!expectedToken || suppliedToken !== expectedToken) {
    return {
      statusCode: 401,
      headers: HEADERS,
      body: JSON.stringify({
        error: "Unauthorized"
      })
    };
  }

  try {
    connectLambda(event);

    const store = getStore("print-commerce-orders");

    const sessionId =
      event.queryStringParameters?.session;

    if (
      !sessionId ||
      !/^cs_(test_)?[a-zA-Z0-9]+$/.test(sessionId)
    ) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({
          error: "Invalid session ID"
        })
      };
    }

    const record = await store.get(
      `order-${sessionId}`,
      { type: "json" }
    );

    if (!record) {
      return {
        statusCode: 404,
        headers: HEADERS,
        body: JSON.stringify({
          error: "Order not found"
        })
      };
    }

    // Return a privacy-safe summary only.
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        success: true,
        sessionId: record.sessionId,
        paymentStatus: record.paymentStatus,
        amountTotal: record.amountTotal,
        currency: record.currency,
        shipping: {
          hasName: !!record.shipping?.name,
          hasEmail: !!record.shipping?.email,
          hasAddressLine1:
            !!record.shipping?.address?.line1,
          hasAddressLine2:
            !!record.shipping?.address?.line2,
          hasCity: !!record.shipping?.address?.city,
          hasState: !!record.shipping?.address?.state,
          hasPostalCode:
            !!record.shipping?.address?.postal_code,
          country: record.shipping?.address?.country
        },
        items: (record.manifest?.items || []).map(
  item => ({
    imageId: item.id,
    printSize: item.size,
    quantity: item.qty,
    finish: item.finish,
    hasImageUrl: !!item.url
  })
),
        fulfillment: record.fulfillment
      }, null, 2)
    };

  } catch (error) {
    console.error(
      "Order inspection failed:",
      error.message
    );

    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({
        error: "Order inspection failed"
      })
    };
  }
};
