
exports.handler = async function () {
  const apiKey = process.env.PRODIGI_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "PRODIGI_API_KEY is missing."
      })
    };
  }

  try {
    const response = await fetch(
      "https://api.sandbox.prodigi.com/v4.0/orders?top=1",
      {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
          "Accept": "application/json"
        }
      }
    );

    return {
      statusCode: response.ok ? 200 : 502,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: response.ok,
        prodigiStatus: response.status,
        message: response.ok
          ? "Connected to Prodigi Sandbox successfully!"
          : "Prodigi connection failed. Check your sandbox API key."
      })
    };
  } catch (error) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        message: "Unable to reach Prodigi Sandbox."
      })
    };
  }
};
