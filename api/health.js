module.exports = function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }

  setCors(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    ok: true,
    provider: "deepseek",
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
    keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    expertRulesPath: "expert-methodology.md",
    version: "2026-05-17-vercel-api-v1"
  }));
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
