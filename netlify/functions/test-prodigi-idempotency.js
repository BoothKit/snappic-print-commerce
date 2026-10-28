
"use strict";

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

function respond(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(data, null, 2)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return respond(405, {
      success: false,
      error: "Method not allowed"
    });
  }

  if (!process.env.PRODIGI_API_KEY) {
    return respond(500, {
      success: false,
      error: "Prodigi API key is missing"
    });
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
    console.log(
      "[Prodigi Test] Submitting sandbox order"
    );

    const response = await fetch(PRODIGI_API, {
      method: "POST",
      headers: {
        "X-API-Key": process.env.PRODIGI_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(order)
    });

    const rawResponse = await response.text();

    let result;

    try {
      result = JSON.parse(rawResponse);
    } catch (error) {
      result = {
        rawResponse: rawResponse
      };
    }

    // Log the complete response for debugging.
    console.log(
      "[Prodigi Test] HTTP Status:",
      response.status
    );

    console.log(
      "[Prodigi Test] Full response:",
      JSON.stringify(result, null, 2)
    );

    const outcome = result.outcome || null;

    const orderId =
      result.order?.id ||
      result.id ||
      null;

    const issues =
      result.order?.status?.issues ||
      result.issues ||
      result.validationErrors ||
      result.errors ||
      [];

    let message = "Review Prodigi response.";

    if (outcome === "AlreadyExists") {
      message =
        "Duplicate prevented successfully!";
    } else if (
      outcome === "Created" ||
      outcome === "CreatedWithIssues"
    ) {
      message =
        "Sandbox order created. Run again to test duplicate protection.";
    } else if (outcome === "ValidationFailed") {
      message =
        "Prodigi rejected the order. Check details for the validation errors.";
    }

    return respond(
      response.ok ? 200 : 502,
      {
        success: response.ok,
        prodigiStatus: response.status,
        outcome: outcome,
        orderId: orderId,
        message: message,
        issues: issues,

        // Include the complete Prodigi response
        // temporarily for debugging.
        details: result
      }
    );

  } catch (error) {
    console.error(
      "[Prodigi Test] Request failed:",
      error
    );

    return respond(502, {
      success: false,
      error: error.message
    });
  }
};
