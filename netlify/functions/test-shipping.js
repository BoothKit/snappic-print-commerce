
const API_URL = "https://api.sandbox.prodigi.com/v4.0/quotes";

const SKUS = {
  fourBySix: "GLOBAL-PHO-4X6",
  fiveBySeven: "GLOBAL-PHO-5X7-PRO"
};

const scenarios = [
  { name: "1 x 4x6", quantities: [[SKUS.fourBySix, 1]] },
  { name: "3 x 4x6", quantities: [[SKUS.fourBySix, 3]] },
  { name: "5 x 4x6", quantities: [[SKUS.fourBySix, 5]] },
  { name: "10 x 4x6", quantities: [[SKUS.fourBySix, 10]] },
  {
    name: "1 x 4x6 + 1 x 5x7",
    quantities: [
      [SKUS.fourBySix, 1],
      [SKUS.fiveBySeven, 1]
    ]
  }
];

exports.handler = async function () {
  const apiKey = process.env.PRODIGI_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing API key" })
    };
  }

  const results = [];

  for (const scenario of scenarios) {
    const payload = {
      shippingMethod: "Budget",
      destinationCountryCode: "US",
      currencyCode: "USD",
      items: scenario.quantities.map(([sku, copies]) => ({
        sku,
        copies,
        attributes: {},
        assets: [{ printArea: "default" }]
      }))
    };

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      const quote = data.quotes?.[0];

      results.push({
        scenario: scenario.name,
        status: response.status,
        outcome: data.outcome,
        itemsCost: quote?.costSummary?.items || null,
        shippingCost: quote?.costSummary?.shipping || null,
        tax: quote?.costSummary?.totalTax || null,
        totalCost: quote?.costSummary?.totalCost || null,
        shipments: quote?.shipments?.length ?? null,
        issues: data.issues || [],
        error: quote ? null : data
      });
    } catch (error) {
      results.push({
        scenario: scenario.name,
        error: "Quote request failed"
      });
    }
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({
      destination: "United States",
      sampleZipForFutureTesting: "34744",
      shippingMethod: "Budget",
      results
    }, null, 2)
  };
};
