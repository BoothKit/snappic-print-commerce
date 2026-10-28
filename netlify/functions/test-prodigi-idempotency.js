
"use strict";

const crypto = require("node:crypto");

const PRODIGI_API =
  "https://api.sandbox.prodigi.com/v4.0/orders";

// One fixed key so repeated tests use the same order.
const TEST_KEY =
  "print-commerce-sandbox-idempotency-v1";

const TEST_IMAGE =
  "https://picsum.photos/id/1018/1200/1800.jpg";

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

  if (!process.env.PRODIGI_API_KEY) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({
        error: "Prodigi API key is missing"
      })
    };
  }

  const order = {
    merchantReference: "PC-SANDBOX-DUPLICATE-TEST",
    idempotencyKey: TEST_KEY,
    shippingMethod: "Budget",

    recipient: {
      name: "Print Commerce Test",
      email: "test@example.com",
      address: {
        line1: "3175 Corporate Center Parkway",
        line2: "",
        postalOrZipCode: "34744",
        countryCode: "US",
        townOrCity: "Kissimmee",
        stateOrCounty: "FL"
      }
    },

    items: [
      {
        sku: "GLOBAL-PHO-4X6",
        copies: 1,
        sizing: "fillPrintArea",
        attributes: {
          finish: "gloss"
        },
        assets: [
          {
            printArea: "default",
            url: TEST_IMAGE
          }
        ]
      }
    ]
  };

  try {
    const response = await fetch(PRODIGI_API, {
      method: "POST",
      headers: {
        "X-API-Key": process.env.PRODIGI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(order)
    });

    const result = await response.json();

    return {
      statusCode: response.ok ? 200 : 502,
      headers: HEADERS,
      body: JSON.stringify({
        success: response.ok,
        prodigiStatus: response.status,
        outcome: result.outcome,
        orderId: result.order?.id || null,
        message:
          result.outcome === "AlreadyExists"
            ? "Duplicate prevented successfully!"
            : result.outcome === "Created"
              ? "Sandbox order created. Run again."
              : "Review Prodigi response.",
        issues:
          result.order?.status?.issues ||
          result.issues ||
          []
      })
    };

  } catch (error) {
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
