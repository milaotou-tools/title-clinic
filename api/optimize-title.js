const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");

const SYSTEM_PROMPT = `
你是中文教育/社科论文“投稿前标题门诊”专家。
只优化已经成稿论文的大标题和各级小标题，不选题、不写论文、不润色全文、不做期刊匹配。
必须遵循专家方法论：先找唯一题眼；避免工作化、做法化标题；优先从工作格局提升到方法/范式格局，再尽量落到人的成长；不要虚构原文没有的对象、方法和结论。
如果诊断指出“以某某为例”这类案例副标题拉低格局，推荐标题和 outlineRevision 的大标题都必须默认去掉该副标题，除非该案例本身就是全文唯一方法论对象且理由明确说明。
输出只能是 JSON，不要 Markdown。
`.trim();

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }

  setCors(res);
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const input = req.body || {};
  const validation = validatePayload(input);
  if (validation) return sendJson(res, 400, { error: validation });

  if (!process.env.DEEPSEEK_API_KEY) {
    return sendJson(res, 200, {
      ...fallbackOptimize(input),
      meta: { mode: "fallback", reason: "DEEPSEEK_API_KEY is not configured" }
    });
  }

  try {
    const result = await optimizeWithDeepSeek(input);
    return sendJson(res, 200, {
      ...normalizeModelResult(result, input),
      meta: { mode: "api", provider: "deepseek", model: DEEPSEEK_MODEL }
    });
  } catch (error) {
    return sendJson(res, 502, {
      error: sanitizeErrorMessage(error),
      provider: "deepseek",
      model: DEEPSEEK_MODEL
    });
  }
};

async function optimizeWithDeepSeek(input) {
  const expertRules = await loadExpertRules();
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            expertRules,
            title: stringOr(input.title, ""),
            abstract: stringOr(input.abstract, ""),
            intro: stringOr(input.intro, ""),
            fullText: stringOr(input.fullText, "").slice(0, 45000),
            outline: normalizeOutline(input.outline),
            outputSchema: {
              profile: { object: "", scene: "", method: "", academicPivot: "" },
              diagnosis: ["最多3条"],
              recommendedTitle: "1个最推荐大标题",
              recommendedReason: "1句话理由",
              alternativeTitles: [
                { type: "稳妥投稿型", title: "", reason: "" },
                { type: "问题意识型", title: "", reason: "" },
                { type: "学术表达型", title: "", reason: "" }
              ],
              outlineRevision: [
                { index: 0, level: 0, oldText: "", newText: "", reason: "" }
              ]
            }
          })
        }
      ],
      temperature: 0.35
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : "DeepSeek API request failed";
    throw new Error(message);
  }

  const text = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : "";
  return parseJsonObject(text);
}

async function loadExpertRules() {
  try {
    const content = await fs.readFile(path.join(ROOT, "expert-methodology.md"), "utf8");
    return content.trim().slice(0, 30000);
  } catch {
    return "仅使用内置规则：唯一题眼、提升格局、避免做法化标题、标题层级成组命名。";
  }
}

function normalizeModelResult(result, input) {
  const fallback = fallbackOptimize(input);
  const recommendedTitle = stripCaseSubtitle(stringOr(result.recommendedTitle, fallback.recommendedTitle));
  const alternatives = Array.isArray(result.alternativeTitles) ? result.alternativeTitles : [];

  return {
    profile: {
      object: stringOr(result.profile && result.profile.object, fallback.profile.object),
      scene: stringOr(result.profile && result.profile.scene, fallback.profile.scene),
      method: stringOr(result.profile && result.profile.method, ""),
      academicPivot: stringOr(result.profile && result.profile.academicPivot, fallback.profile.academicPivot)
    },
    diagnosis: arrayOfStrings(result.diagnosis, fallback.diagnosis).slice(0, 3),
    recommendedTitle,
    recommendedReason: stringOr(result.recommendedReason, fallback.recommendedReason),
    alternativeTitles: ["稳妥投稿型", "问题意识型", "学术表达型"].map((type, index) => {
      const item = alternatives.find(entry => entry && entry.type === type) || alternatives[index] || {};
      const fb = fallback.alternativeTitles[index];
      return {
        type,
        title: stripCaseSubtitle(stringOr(item.title, fb.title)),
        reason: stringOr(item.reason, fb.reason)
      };
    }),
    outlineRevision: normalizeOutlineRevision(result.outlineRevision, input, recommendedTitle)
  };
}

function normalizeOutlineRevision(value, input, recommendedTitle) {
  const original = normalizeOutline(input.outline);
  const source = Array.isArray(value) ? value : [];
  const byIndex = new Map();
  const byOldText = new Map();

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const normalized = {
      index: Number.isInteger(item.index) ? item.index : null,
      level: normalizeLevel(item.level),
      oldText: stripCaseSubtitle(stringOr(item.oldText, "")),
      newText: stripCaseSubtitle(stringOr(item.newText, "")),
      reason: stringOr(item.reason, "")
    };
    if (normalized.index !== null) byIndex.set(normalized.index, normalized);
    if (normalized.oldText) byOldText.set(compactKey(normalized.oldText), normalized);
  }

  if (!original.length) {
    return [{ index: 0, level: 0, oldText: input.title || "", newText: recommendedTitle, reason: "优化大标题表达。" }];
  }

  return original.map((item, index) => {
    const update = byIndex.get(index) || byOldText.get(compactKey(item.text));
    return {
      index,
      level: normalizeLevel(update && update.level !== null ? update.level : item.level),
      oldText: item.text,
      newText: stripCaseSubtitle(stringOr(update && update.newText, index === 0 ? recommendedTitle : item.text)),
      reason: stringOr(update && update.reason, "")
    };
  });
}

function fallbackOptimize(input) {
  const outline = normalizeOutline(input.outline);
  const originalTitle = stringOr(input.title, outline[0] && outline[0].text) || "论文标题";
  const recommendedTitle = localRecommendedTitle(originalTitle);
  return {
    profile: { object: "教育/社科论文", scene: "投稿前标题优化", method: "", academicPivot: "问题意识" },
    diagnosis: [
      "原题需要进一步明确唯一题眼，避免多个概念并列导致主从关系不清。",
      "若标题停留在“构建与实践”“路径与思考”“以某某为例”，容易显得工作化，缺少方法论和理论张力。",
      "小标题应围绕同一核心概念成组展开，避免目录式罗列。"
    ],
    recommendedTitle,
    recommendedReason: "本地规则优先保留核心对象，并去除低格局案例副标题。",
    alternativeTitles: [
      { type: "稳妥投稿型", title: recommendedTitle, reason: "表达稳妥，保留研究对象和核心问题。" },
      { type: "问题意识型", title: `从问题呈现到结构转化：${compactSubject(originalTitle)}的教学研究`, reason: "突出问题意识和转化过程。" },
      { type: "学术表达型", title: `${compactSubject(originalTitle)}的结构化诊断与教学转化`, reason: "强化结构化诊断和学术表达。" }
    ],
    outlineRevision: outline.map((item, index) => ({
      index,
      level: item.level,
      oldText: item.text,
      newText: index === 0 ? recommendedTitle : item.text,
      reason: index === 0 ? "去除低格局案例副标题，聚焦主标题。" : ""
    }))
  };
}

function localRecommendedTitle(title) {
  return stripCaseSubtitle(title)
    .replace(/AI赋能/g, "AI数智")
    .replace(/构建与实践/g, "转型实践")
    .replace(/路径与思考/g, "转型实践")
    .replace(/实践探索/g, "循证实践")
    .trim();
}

function stripCaseSubtitle(text) {
  return normalizeText(text)
    .replace(/(?:——|—|-)?[（(]?\s*以["“『《]?[^"”』》]+["”』》]?\s*为例\s*[)）]?$/g, "")
    .replace(/(?:——|—|-)?[（(]?\s*以["“『《]?[^"”』》]+["”』》]?\s*教学为例\s*[)）]?$/g, "")
    .replace(/(?:——|—|-)?[（(]?\s*基于["“『《]?[^"”』》]+["”』》]?\s*为例\s*[)）]?$/g, "")
    .replace(/\s*[-—]*\s*以["“『《]?[^"”』》]+["”』》]?\s*为例$/, "")
    .trim();
}

function normalizeOutline(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => ({ level: normalizeLevel(item && item.level), text: normalizeText(item && item.text) }))
    .filter(item => item.text)
    .slice(0, 160);
}

function normalizeLevel(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, Math.round(n))) : 3;
}

function compactSubject(title) {
  return stripCaseSubtitle(title)
    .replace(/[：:].+$/, "")
    .replace(/[“”"《》]/g, "")
    .slice(0, 18) || "论文";
}

function arrayOfStrings(value, fallback) {
  const arr = Array.isArray(value) ? value : fallback;
  return arr.map(item => String(item || "").trim()).filter(Boolean);
}

function compactKey(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function normalizeText(value) {
  return String(value || "").replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : (fallback || "");
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON");
    return JSON.parse(match[0]);
  }
}

function validatePayload(body) {
  const hasTitle = typeof body.title === "string" && body.title.trim();
  const hasOutline = Array.isArray(body.outline) && body.outline.length;
  if (!hasTitle && !hasOutline) return "请提供标题或标题层级。";
  return "";
}

function sanitizeErrorMessage(error) {
  return error && error.message ? error.message.slice(0, 500) : "Unknown error";
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
