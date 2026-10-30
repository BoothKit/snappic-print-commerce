
"use strict";
const crypto = require("node:crypto");
const { getStore, connectLambda } = require("@netlify/blobs");

function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

exports.handler = async function(event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const reply = (statusCode, data) => ({ statusCode, headers, body: JSON.stringify(data) });
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  if (!process.env.ORDER_INSPECT_TOKEN || !equal(event.headers?.["x-inspect-token"] || event.headers?.["X-Inspect-Token"], process.env.ORDER_INSPECT_TOKEN)) {
    return reply(401, { error: "Unauthorized" });
  }
  let sessionId;
  try { sessionId = JSON.parse(event.body || "{}").sessionId; }
  catch (_) { return reply(400, { error: "Invalid JSON" }); }
  if (typeof sessionId !== "string" || !/^cs_test_[A-Za-z0-9]+$/.test(sessionId)) {
    return reply(400, { error: "Invalid session ID" });
  }
  try {
    connectLambda(event);
    const record = await getStore("print-commerce-diagnostics").get(`worker/${sessionId}`, { type: "json" });
    return reply(200, { found: !!record, diagnostic: record || null });
  } catch (error) {
    console.error("Diagnostic lookup failed", error.message);
    return reply(500, { error: "Diagnostic lookup failed" });
  }
};
