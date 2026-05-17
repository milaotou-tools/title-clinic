const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 240000);

const SYSTEM_PROMPT = `
你是中文教育/社科论文“投稿前标题门诊”专家。

产品边界：
- 只优化已经成稿论文的标题和各级小标题。
- 不选题、不写论文、不润色全文、不做期刊匹配、不查重、不生成英文标题。
- 只能依据用户提供的原标题、摘要、引言、全文和原始标题层级，不得虚构论文没有的对象、方法、结论。
- 如果用户提供 fullText，应通读全文理解研究对象、问题、方法、场景和贡献，但输出仍限于标题诊断与标题层级优化。

专家方法论必须贯彻：
1. 先找唯一“题眼”。标题不能没有中心概念，也不能同时有多个中心概念。
2. 判断标题格局：工作格局最低，方法/范式格局较好，能落到“人的成长/教师发展/儿童理解/学生素养”的标题更高。
3. 避免“构建与实践”“路径与思考”“实践探索”“以某某为例”等低辨识度做法词，除非确有必要。
4. 若论文主题是教研，必须从课堂教学转到教研，标题和小标题中要看得见“教研”及其新变化。
5. 可以使用冒号。冒号前应是特征、载体、亮点、隐喻、理论张力；冒号后应是对象、场景、实践或研究内容。
6. 小标题不是普通目录，要形成同一套命名系统，如“失焦-对焦-成像-画像”“危机浮现-问题诊断-觉醒起点-深度验证”“从A到B”等。
7. 新版标题层级要尽量保留原文真实内容，只改标题表达，不新增原文没有的章节或事实。

输出要求：
- 只返回 JSON，不要 Markdown，不要解释 JSON 之外的内容。
- diagnosis 最多 3 条。
- recommendedTitle 只给 1 个。
- alternativeTitles 固定 3 个：稳妥投稿型、问题意识型、学术表达型。
- outlineRevision 必须对应用户传来的 outline。不要遗漏原有标题层级。每一项保留同一个 index，除非原 outline 为空。
- 如果 outline 中包含 id，outlineRevision 每一项必须带回同一个 id；id 只用于前端回填，不改变标题规则。
- outlineRevision 中 newText 是新版标题；未修改也要返回原文，便于前端完整展示。

JSON 结构必须是：
{
  "profile": {
    "object": "研究对象",
    "scene": "研究场景",
    "method": "方法线索，没有则为空字符串",
    "academicPivot": "机制/困境/路径/逻辑/治理/范式/素养等学术支点"
  },
  "diagnosis": ["最多3条原题关键问题"],
  "recommendedTitle": "1个最推荐大标题",
  "recommendedReason": "1句话理由",
  "alternativeTitles": [
    {"type": "稳妥投稿型", "title": "标题", "reason": "1句话理由"},
    {"type": "问题意识型", "title": "标题", "reason": "1句话理由"},
    {"type": "学术表达型", "title": "标题", "reason": "1句话理由"}
  ],
  "outlineRevision": [
    {"id": "T0", "index": 0, "level": 0, "oldText": "原标题", "newText": "新版标题", "reason": "短理由"},
    {"id": "T1", "index": 1, "level": 1, "oldText": "原一级标题", "newText": "新版一级标题", "reason": "短理由"}
  ]
}
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
            instruction: "请严格依据 expertRules 与系统提示完成标题诊断和标题层级优化。必须通读 fullText。outline 中的 id 仅用于前端回填定位；outlineRevision 必须覆盖 outline 每一项，顺序一致，并带回同一 id、index、level、oldText、newText、reason。不要把 id 写进标题文本。",
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
  const recommendedTitle = stringOr(result.recommendedTitle, fallback.recommendedTitle);
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
        title: stringOr(item.title, fb.title),
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
      oldText: stringOr(item.oldText, ""),
      newText: stringOr(item.newText, ""),
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
      newText: stringOr(update && update.newText, index === 0 ? recommendedTitle : item.text),
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
    recommendedReason: "本地规则优先保留原题核心信息，并把低辨识度做法词替换为更有教研转型意味的表达。",
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
      reason: index === 0 ? "优化大标题表达。" : ""
    }))
  };
}

function localRecommendedTitle(title) {
  return normalizeText(title)
    .replace(/AI赋能/g, "AI数智")
    .replace(/构建与实践/g, "转型实践")
    .replace(/路径与思考/g, "转型实践")
    .replace(/实践探索/g, "循证实践")
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
  return normalizeText(title)
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
