
"use strict";

const { getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({
        error: "Method not allowed"
      })
    };
  }

  try {
    const store = getStore("print-commerce-orders");

    const key = "setup-test";

    const value = {
      status: "connected",
      application: "print-commerce",
      testedAt: new Date().toISOString()
    };

    await store.setJSON(key, value);

    const saved = await store.get(key, {
      type: "json",
      consistency: "strong"
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: true,
        message: "Netlify Blobs is working!",
        saved
      })
    };

  } catch (error) {
    console.error(
      "Order storage test failed:",
      error.message
    );

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
