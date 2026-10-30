
"use strict";

const crypto = require("node:crypto");
const {
  getStore,
  connectLambda
} = require("@netlify/blobs");

const ORDER_STORE = "print-commerce-orders";
const IMAGE_STORE = "print-commerce-images";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;

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

function isValidSessionId(value) {
  return (
    typeof value === "string" &&
    /^cs_test_[a-zA-Z0-9]+$/.test(value)
  );
}

function validateSourceURL(value) {
  if (typeof value !== "string") {
    throw new Error("Missing image URL");
  }

  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.hostname !== "app.snappic.com" ||
    url.port ||
    url.username ||
    url.password ||
    !(
  /^\/media\/download\/photo\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ||
  /^\/photo\/still\/[A-Za-z0-9_-]+\.jpe?g$/i.test(url.pathname)
)
  ) {
    console.error("[Image URL Validation]", {
  hostname: url.hostname,
  pathname: url.pathname,
  protocol: url.protocol
});

throw new Error("Unsupported Snappic image URL");
  }

  return url;
}

function validateRedirectURL(value) {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("Unsafe image redirect");
  }

  const allowedHosts = [
  "app.snappic.com",
  "photobooth-images.myboothpic.co",
  "photobooth-images.s3.amazonaws.com"
];

  if (!allowedHosts.includes(url.hostname)) {
  console.error("[Image Redirect Validation]", {
    hostname: url.hostname,
    protocol: url.protocol
  });

  throw new Error(
    "Image redirected to an unsupported host"
  );
}

  return url;
}

async function downloadImage(sourceURL) {
  let currentURL = validateSourceURL(sourceURL);

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount++
  ) {
    const response = await fetch(currentURL, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });

    if (
      [301, 302, 303, 307, 308].includes(
        response.status
      )
    ) {
      const location =
        response.headers.get("location");

      if (!location) {
        throw new Error(
          "Image redirect is missing a location"
        );
      }

      currentURL = validateRedirectURL(
        new URL(location, currentURL).toString()
      );

      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Image download returned HTTP ${response.status}`
      );
    }

    const declaredLength = Number(
      response.headers.get("content-length") || 0
    );

    if (declaredLength > MAX_IMAGE_BYTES) {
      throw new Error("Image exceeds 15 MB");
    }

    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("Missing image response body");
    }

    const chunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        totalBytes += value.byteLength;

        if (totalBytes > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new Error("Image exceeds 15 MB");
        }

        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    const buffer = Buffer.concat(chunks);

    // JPEG starts with FF D8 FF.
    const isJPEG =
      buffer.length > 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;

    if (!isJPEG) {
      throw new Error(
        "Downloaded file is not a JPEG"
      );
    }

    // JPEG normally ends with FF D9.
    const hasJPEGEnd =
      buffer[buffer.length - 2] === 0xff &&
      buffer[buffer.length - 1] === 0xd9;

    if (!hasJPEGEnd) {
      throw new Error(
        "Downloaded JPEG appears incomplete"
      );
    }

    return buffer;
  }

  throw new Error("Too many image redirects");
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return respond(405, {
      error: "Method not allowed"
    });
  }

  if (!authorized(event)) {
    return respond(401, {
      error: "Unauthorized"
    });
  }

  let sessionId;

  try {
    const payload = JSON.parse(
      event.body || "{}"
    );

    sessionId = payload.sessionId;
  } catch (_) {
    return respond(400, {
      error: "Invalid JSON body"
    });
  }

  if (!isValidSessionId(sessionId)) {
    return respond(400, {
      error: "Valid Stripe test session required"
    });
  }

  try {
    connectLambda(event);

    const orders = getStore(ORDER_STORE);
    const images = getStore(IMAGE_STORE);

    const order = await orders.get(
      `order-${sessionId}`,
      { type: "json" }
    );

    if (
      !order ||
      order.application !==
        "snappic-print-commerce" ||
      order.sessionId !== sessionId ||
      order.paymentStatus !== "paid"
    ) {
      return respond(422, {
        error: "Valid paid order not found"
      });
    }

    const items = order.manifest?.items;

    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 2
    ) {
      return respond(422, {
        error: "Invalid order manifest"
      });
    }

    const results = [];

    for (const item of items) {
      if (
        !["main", "original"].includes(item.id)
      ) {
        throw new Error(
          "Unsupported photo selection"
        );
      }

      const buffer = await downloadImage(
        item.url
      );

      const imageKey =
  `images/${sessionId}/${item.id}.jpg`;

const accessToken = crypto.randomBytes(32).toString("hex");

const accessTokenHash = crypto
  .createHash("sha256")
  .update(accessToken)
  .digest("hex");

await images.set(imageKey, buffer, {
  metadata: {
    contentType: "image/jpeg",
    sessionId,
    imageId: item.id,
    accessTokenHash,
    uploadedAt: new Date().toISOString()
  }
});

const deliveryURL =
  `https://${event.headers.host}` +
  `/.netlify/functions/serve-image` +
  `?sessionId=${encodeURIComponent(sessionId)}` +
  `&imageId=${encodeURIComponent(item.id)}` +
  `&token=${accessToken}`;

      results.push({
  imageId: item.id,
  stored: true,
  bytes: buffer.length,
  contentType: "image/jpeg",
  deliveryURL
});
    }

    return respond(200, {
      success: true,
      sessionId,
      imageCount: results.length,
      images: results
    });

  } catch (error) {
    console.error(
      "[Image Preparation] Failed:",
      error.message
    );

    return respond(502, {
      success: false,
      error: error.message
    });
  }
};
