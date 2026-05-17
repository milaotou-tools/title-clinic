const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 240000);

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
    return sendJson(res, 503, { error: "DeepSeek API key is not configured" });
  }

  try {
    if (wantsEventStream(req)) {
      return streamOptimization(req, res, input);
    }
    const result = await optimizeWithDeepSeek(input);
    return sendJson(res, 200, withApiMeta(normalizeModelResult(result, input)));
  } catch (error) {
    return sendJson(res, 504, {
      error: sanitizeErrorMessage(error),
      provider: "deepseek",
      model: DEEPSEEK_MODEL
    });
  }
};

async function streamOptimization(req, res, input) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  const send = (event, payload) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    send("progress", { message: "AI 正在通读全文并套用专家规则..." });
  }, 8000);

  try {
    send("progress", { message: "已连接 AI，开始通读全文..." });
    const result = await optimizeWithDeepSeek(input, message => send("progress", { message }));
    send("result", withApiMeta(normalizeModelResult(result, input)));
    clearInterval(heartbeat);
    return res.end();
  } catch (error) {
    clearInterval(heartbeat);
    send("error", { error: sanitizeErrorMessage(error), provider: "deepseek", model: DEEPSEEK_MODEL });
    return res.end();
  }
}

async function optimizeWithDeepSeek(input, onProgress) {
  const expertRules = await loadExpertRules();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
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
            fullText: stringOr(input.fullText, ""),
            outline: normalizeOutline(input.outline).map((item, index) => ({ id: `T${index}`, index, ...item })),
            instruction: "必须通读 fullText，并在专家规则约束下修改大标题和各级小标题。只能依据全文已有信息判断研究对象、问题、场景、方法和贡献；不得虚构全文未出现的信息。必须逐条审视 outline 中的每一个标题，不要只修改总题目和少数一级标题。outlineRevision 必须覆盖 outline 的每一项，顺序与 outline 完全一致；每条都必须带回对应 id，例如 T0、T1；oldText 必须复制对应标题原文；newText 是新版标题，确实无需修改时才允许等于 oldText。绝对不要新增、删除或重排标题。",
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
                { id: "T0", index: 0, level: 0, oldText: "", newText: "", reason: "" }
              ]
            }
          })
        }
      ],
      temperature: 0.25,
      max_tokens: 12000,
      stream: true
    })
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let message = "DeepSeek API request failed";
    try {
      const payload = JSON.parse(errorText);
      message = payload && payload.error && payload.error.message ? payload.error.message : message;
    } catch {
      if (errorText) message = errorText.slice(0, 500);
    }
    throw new Error(message);
  }

  const text = await readDeepSeekStream(response, onProgress);
  return parseJsonObject(text);
}

async function readDeepSeekStream(response, onProgress) {
  if (!response.body) throw new Error("DeepSeek stream is empty");
  if (onProgress) onProgress("DeepSeek 已开始返回，正在生成新版标题结构...");
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const payload = JSON.parse(data);
        const delta = payload && payload.choices && payload.choices[0] && payload.choices[0].delta;
        if (delta && typeof delta.content === "string") content += delta.content;
      } catch {
        // Ignore malformed stream keep-alive lines.
      }
    }
  }

  if (!content.trim()) throw new Error("DeepSeek stream did not return content");
  return content;
}

function withApiMeta(result) {
  return {
    ...result,
    meta: { mode: "api", provider: "deepseek", model: DEEPSEEK_MODEL }
  };
}

function wantsEventStream(req) {
  return String(req.headers.accept || "").includes("text/event-stream");
}

async function loadExpertRules() {
  try {
    const content = await fs.readFile(path.join(ROOT, "expert-methodology.md"), "utf8");
    return content.trim();
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
  const revisions = [];

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const normalized = {
      id: typeof item.id === "string" ? item.id.trim() : "",
      index: Number.isInteger(item.index) ? item.index : null,
      level: normalizeLevel(item.level),
      oldText: stripCaseSubtitle(stringOr(item.oldText, "")),
      newText: stripCaseSubtitle(stringOr(item.newText, "")),
      reason: stringOr(item.reason, "")
    };
    revisions.push(normalized);
    if (normalized.index !== null) byIndex.set(normalized.index, normalized);
    if (/^T\d+$/.test(normalized.id)) byIndex.set(Number(normalized.id.slice(1)), normalized);
    if (normalized.oldText) byOldText.set(compactKey(normalized.oldText), normalized);
  }

  if (!original.length) {
    return [{ index: 0, level: 0, oldText: input.title || "", newText: recommendedTitle, reason: "优化大标题表达。" }];
  }

  const used = new Set();
  return original.map((item, index) => {
    const update = takeUnused(byOldText.get(compactKey(item.text)), used)
      || takeUnused(getTrustedIndexUpdate(byIndex, original, index), used)
      || takeUnused(findNearbyRevision(revisions, original, index, used), used);
    return {
      index,
      level: normalizeLevel(update && update.level !== null ? update.level : item.level),
      oldText: item.text,
      newText: stripCaseSubtitle(stringOr(update && update.newText, index === 0 ? recommendedTitle : item.text)),
      reason: stringOr(update && update.reason, "")
    };
  });
}

function getTrustedIndexUpdate(byIndex, original, index) {
  const update = byIndex.get(index);
  if (!update) return null;
  if (/^T\d+$/.test(update.id || "") && Number(update.id.slice(1)) === index) return update;
  if (!update.oldText) return update;
  const originalText = original[index] && original[index].text;
  return compactKey(update.oldText) === compactKey(originalText) ? update : null;
}

function findNearbyRevision(revisions, original, index, used) {
  const target = original[index];
  if (!target) return null;
  let best = null;
  let bestScore = 0;
  for (const item of revisions) {
    if (!item || used.has(item) || !item.oldText) continue;
    if (item.index !== null && Math.abs(item.index - index) > 3) continue;
    if (Math.abs(normalizeLevel(item.level) - normalizeLevel(target.level)) > 1) continue;
    const score = looseSimilarity(item.oldText, target.text);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.42 ? best : null;
}

function takeUnused(item, used) {
  if (!item || used.has(item)) return null;
  used.add(item);
  return item;
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

function looseKey(value) {
  return compactKey(value).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

function looseSimilarity(a, b) {
  const left = Array.from(new Set(looseKey(a)));
  const right = new Set(looseKey(b));
  if (!left.length || !right.size) return 0;
  let common = 0;
  for (const char of left) {
    if (right.has(char)) common++;
  }
  return common / Math.max(left.length, right.size);
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
