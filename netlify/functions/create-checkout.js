
const SITE_URL = "https://snappic-print-commerce.netlify.app";

// Allow the Snappic Microsite to communicate with Netlify.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://app.snappic.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

exports.handler = async function (event) {

  // Handle browser CORS preflight requests.
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  // Only allow POST requests.
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        ...CORS_HEADERS,
        Allow: "POST, OPTIONS"
      },
      body: JSON.stringify({
        error: "Method not allowed"
      })
    };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey || !secretKey.startsWith("sk_test_")) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Stripe test key is missing or invalid"
      })
    };
  }

  try {
    const params = new URLSearchParams();

    params.set("mode", "payment");
    params.set("payment_method_types[0]", "card");

    // Print product
    params.set(
      "line_items[0][price_data][currency]",
      "usd"
    );

    params.set(
      "line_items[0][price_data][product_data][name]",
      "Print Commerce - 4x6 Gloss Photo"
    );

    params.set(
      "line_items[0][price_data][unit_amount]",
      "499"
    );

    params.set(
      "line_items[0][quantity]",
      "1"
    );

    // Budget shipping
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

    // Collect guest shipping address
    params.set(
      "shipping_address_collection[allowed_countries][0]",
      "US"
    );

    // Identify Print Commerce transactions
    params.set(
      "metadata[source]",
      "snappic-print-commerce"
    );

    params.set(
      "metadata[environment]",
      "test"
    );

    params.set(
      "metadata[print_size]",
      "4x6"
    );

    params.set(
      "metadata[finish]",
      "gloss"
    );

    // Checkout redirects
    params.set(
      "success_url",
      `${SITE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
    );

    params.set(
      "cancel_url",
      `${SITE_URL}/?checkout=cancelled`
    );

    // Create Stripe Checkout Session
    const response = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );

    const data = await response.json();

    // Stripe returned an error
    if (!response.ok) {
      console.error("Stripe Checkout error:", {
        type: data.error?.type,
        code: data.error?.code
      });

      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error:
            data.error?.message ||
            "Stripe Checkout failed"
        })
      };
    }

    // Checkout Session created successfully
    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        success: true,
        checkoutUrl: data.url,
        sessionId: data.id
      })
    };

  } catch (error) {
    console.error(
      "Checkout connection error:",
      error.message
    );

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: "Unable to create checkout session"
      })
    };
  }
};
