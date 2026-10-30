
"use strict";

const crypto = require("node:crypto");

const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const IMAGE_STORE = "print-commerce-images";

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({ error: message })
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }

  const {
    sessionId,
    imageId,
    token
  } = event.queryStringParameters || {};

  if (
    typeof sessionId !== "string" ||
    !/^cs_test_[a-zA-Z0-9]+$/.test(sessionId) ||
    !["main", "original"].includes(imageId) ||
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return errorResponse(400, "Invalid image request");
  }

  try {
    connectLambda(event);

    const images = getStore(IMAGE_STORE);

    const imageKey =
      `images/${sessionId}/${imageId}.jpg`;

    const result = await images.getWithMetadata(
      imageKey,
      { type: "arrayBuffer" }
    );

    if (!result) {
      return errorResponse(404, "Image not found");
    }

    const {
      data,
      metadata
    } = result;

    if (!data || !metadata?.accessTokenHash) {
      return errorResponse(404, "Image unavailable");
    }

    const suppliedHash = crypto
      .createHash("sha256")
      .update(token)
      .digest();

    const expectedHash = Buffer.from(
      metadata.accessTokenHash,
      "hex"
    );

    if (
      suppliedHash.length !== expectedHash.length ||
      !crypto.timingSafeEqual(
        suppliedHash,
        expectedHash
      )
    ) {
      return errorResponse(403, "Access denied");
    }

    const imageBuffer = Buffer.from(data);

    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      },
      body: imageBuffer.toString("base64")
    };

  } catch (error) {
    console.error(
      "[Serve Image] Error:",
      error.message
    );

    return errorResponse(
      500,
      "Unable to retrieve image"
    );
  }
};
