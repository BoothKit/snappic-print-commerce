
"use strict";

const STRIPE_API = "https://api.stripe.com/v1/checkout/sessions/";

function respond(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(data)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return respond(405, {
      error: "Method not allowed."
    });
  }

  const sessionId = event.queryStringParameters?.session_id;

  if (
    typeof sessionId !== "string" ||
    !/^cs_(test_|live_)[A-Za-z0-9]{10,200}$/.test(sessionId)
  ) {
    return respond(400, {
      error: "Invalid checkout session."
    });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return respond(500, {
      error: "Payment verification is unavailable."
    });
  }

  try {
    const response = await fetch(
      STRIPE_API + encodeURIComponent(sessionId),
      {
        headers: {
          Authorization: "Bearer " + secretKey
        }
      }
    );

    if (!response.ok) {
      console.error(
        "Stripe session verification failed:",
        response.status
      );

      return respond(
        response.status === 404 ? 404 : 502,
        { error: "Unable to verify this order." }
      );
    }

    const session = await response.json();

    if (
      session.metadata?.source !==
      "snappic-print-commerce"
    ) {
      return respond(404, {
        error: "Order not found."
      });
    }

    const paid =
      session.status === "complete" &&
      session.payment_status === "paid";

    return respond(200, {
      status: paid
        ? "paid"
        : session.status === "expired"
          ? "expired"
          : "processing"
    });

  } catch (error) {
    console.error(
      "Checkout verification error:",
      error.message
    );

    return respond(502, {
      error: "Payment verification is temporarily unavailable."
    });
  }
};
