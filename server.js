const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = __dirname;
loadLocalEnv(path.join(ROOT, ".env"));
loadLocalEnv(path.join(ROOT, ".env.local"));

const PORT = Number(process.env.PORT || 3000);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const EXPERT_RULES_PATH = process.env.EXPERT_RULES_PATH || path.join(ROOT, "expert-methodology.md");

const SYSTEM_PROMPT_PATH = path.join(ROOT, "system-prompt.txt");

async function loadSystemPrompt() {
  try {
    return (await fs.readFile(SYSTEM_PROMPT_PATH, "utf8")).trim();
  } catch {
    console.warn("system-prompt.txt not found, using embedded fallback prompt.");
    return `
你是中文教育/社科论文"投稿前标题门诊"专家。
只优化已经成稿论文的标题和各级小标题，不选题、不写论文、不润色全文。
输出只返回 JSON，不要 Markdown。
    `.trim();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return sendCorsPreflight(res);
    }

    if (req.method === "POST" && url.pathname === "/api/optimize-title") {
      const body = await readJson(req);
      const validation = validatePayload(body);
      if (validation) return sendJson(res, 400, { error: validation });

      if (!DEEPSEEK_API_KEY) {
        return sendJson(res, 200, {
          ...fallbackOptimize(body),
          meta: { mode: "fallback", reason: "DEEPSEEK_API_KEY is not configured" }
        });
      }

      try {
        const result = await optimizeWithDeepSeek(body);
        return sendJson(res, 200, {
          ...normalizeModelResult(result, body),
          meta: { mode: "api", provider: "deepseek", model: DEEPSEEK_MODEL }
        });
      } catch (error) {
        console.error(error);
        return sendJson(res, 502, {
          error: sanitizeErrorMessage(error),
          provider: "deepseek",
          model: DEEPSEEK_MODEL
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        provider: "deepseek",
        model: DEEPSEEK_MODEL,
        keyConfigured: Boolean(DEEPSEEK_API_KEY),
        expertRulesPath: EXPERT_RULES_PATH,
        version: "2026-05-17-outline-compare-v1"
      });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/title-clinic-mvp.html")) {
      return sendFile(res, path.join(ROOT, "title-clinic-mvp.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/MVP_USAGE.md") {
      return sendFile(res, path.join(ROOT, "MVP_USAGE.md"), "text/markdown; charset=utf-8");
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: sanitizeErrorMessage(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Title Clinic MVP: http://localhost:${PORT}`);
  console.log(DEEPSEEK_API_KEY ? `DeepSeek model: ${DEEPSEEK_MODEL}` : "DEEPSEEK_API_KEY is not configured; using fallback mode.");
});

async function optimizeWithDeepSeek(input) {
  const expertRules = await loadExpertRules();
  const requestBody = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: "system", content: await loadSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          title: input.title,
          abstract: input.abstract,
          intro: input.intro,
          fullText: truncateText(input.fullText, 60000),
          outline: normalizeOutline(input.outline).slice(0, 120),
          expertRules
        })
      }
    ],
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    temperature: 0.25
  };

  let response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  let payload = await response.json().catch(() => null);

  if (!response.ok && isJsonModeUnsupported(payload)) {
    const retryBody = { ...requestBody };
    delete retryBody.response_format;
    delete retryBody.thinking;
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(retryBody)
    });
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const message = payload && payload.error && payload.error.message ? payload.error.message : "DeepSeek API request failed";
    throw new Error(message);
  }

  const text = extractChatCompletionText(payload);
  return parseJsonObject(text);
}

async function loadExpertRules() {
  try {
    const content = await fs.readFile(EXPERT_RULES_PATH, "utf8");
    return content.trim().slice(0, 30000);
  } catch {
    return "尚未接入外部专家方法论文件。请仅使用系统内置标题门诊原则。";
  }
}

function normalizeModelResult(result, input) {
  const fallback = fallbackOptimize(input);
  const alternatives = Array.isArray(result.alternativeTitles) ? result.alternativeTitles : [];
  return {
    profile: {
      object: stringOr(result.profile && result.profile.object, fallback.profile.object),
      scene: stringOr(result.profile && result.profile.scene, fallback.profile.scene),
      method: stringOr(result.profile && result.profile.method, ""),
      academicPivot: stringOr(result.profile && result.profile.academicPivot, fallback.profile.academicPivot)
    },
    diagnosis: arrayOfStrings(result.diagnosis, fallback.diagnosis).slice(0, 3),
    recommendedTitle: stringOr(result.recommendedTitle, fallback.recommendedTitle),
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
    outlineRevision: normalizeOutlineRevision(result.outlineRevision, input, stringOr(result.recommendedTitle, fallback.recommendedTitle))
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
      oldText: stringOr(item.oldText, ""),
      newText: stringOr(item.newText, ""),
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
      newText: stringOr(update && update.newText, index === 0 ? recommendedTitle : item.text),
      reason: stringOr(update && update.reason, index === 0 ? "优化大标题表达。" : "")
    };
  });
}

function fallbackOptimize(input) {
  const outline = normalizeOutline(input.outline);
  const originalTitle = input.title || (outline[0] && outline[0].text) || "论文标题";
  const subject = compactSubject(originalTitle);
  const recommendedTitle = localRecommendedTitle(originalTitle, input);
  const revision = (outline.length ? outline : [{ level: 0, text: originalTitle }]).map((item, index) => ({
    index,
    level: normalizeLevel(item.level),
    oldText: item.text,
    newText: index === 0 ? recommendedTitle : localHeadingRevision(item.text),
    reason: index === 0 ? "将做法化标题转为更有题眼和教研意味的表达。" : "弱化工作化动词，增强标题系统感。"
  }));
  return {
    profile: {
      object: subject || "教育/社科论文",
      scene: inferScene(input),
      method: "",
      academicPivot: inferPivot(input)
    },
    diagnosis: [
      "原标题需要进一步明确唯一题眼，避免多个概念并列导致主从关系不清。",
      '若标题停留在"构建与实践""路径与思考"，容易显得工作化，缺少方法论和理论张力。',
      "小标题应围绕同一核心概念成组展开，避免目录式罗列。"
    ],
    recommendedTitle,
    recommendedReason: "本地规则优先保留原题核心信息，并把低辨识度做法词替换为更有教研转型意味的表达。",
    alternativeTitles: [
      {
        type: "稳妥投稿型",
        title: `${subject}标题优化的结构化实践`,
        reason: "表达稳妥，突出标题优化任务和结构化方法。"
      },
      {
        type: "问题意识型",
        title: `从"题目像工作"到"标题像论文"：${subject}标题优化实践`,
        reason: "突出原题问题和修改方向。"
      },
      {
        type: "学术表达型",
        title: `${subject}标题命名的结构化诊断与表达转化`,
        reason: "强化结构化诊断和学术表达。"
      }
    ],
    outlineRevision: revision
  };
}

function localRecommendedTitle(title, input) {
  let next = String(title || "")
    .replace(/AI赋能/g, "AI数智")
    .replace(/构建与实践/g, "转型实践")
    .replace(/路径与思考/g, "转型实践")
    .replace(/实践探索/g, "实践生成")
    .replace(/人工智能支持/g, "AI支持下")
    .replace(/[-—－]\s*以.+?为例$/g, "")
    .replace(/：\s*以.+?为例$/g, "");
  const corpus = `${input.fullText || ""}${input.abstract || ""}${input.intro || ""}${title || ""}`;
  if (!/教研/.test(next) && /课堂|教学|教师|课程|学校/.test(corpus)) {
    next = next.replace(/课堂|教学|课程/, match => `${match}教研`);
  }
  return next || title;
}

function localHeadingRevision(text) {
  return String(text || "")
    .replace(/构建与实践/g, "转型实践")
    .replace(/路径与思考/g, "转型实践")
    .replace(/实践探索/g, "实践生成")
    .replace(/落地实施/g, "实践生成")
    .replace(/^模式建构：/, "模型建构：")
    .replace(/为何需要/g, "植入");
}

function normalizeOutline(outline) {
  if (!Array.isArray(outline)) return [];
  return outline
    .map(item => ({
      level: normalizeLevel(item && item.level),
      text: stringOr(item && item.text, "")
    }))
    .filter(item => item.text)
    .slice(0, 140);
}

function normalizeLevel(value) {
  const level = Number(value);
  if (!Number.isFinite(level)) return 3;
  return Math.max(0, Math.min(4, Math.trunc(level)));
}

function inferScene(input) {
  const text = `${input.title || ""}${input.abstract || ""}${input.intro || ""}${input.fullText || ""}`;
  const match = text.match(/(小学|初中|高中|高校|幼儿园|园本教研|校本教研|语文课堂|数学概念课|通识课程|教师|儿童|学生)/);
  return match ? match[1] : "教育/社科场景";
}

function inferPivot(input) {
  const text = `${input.title || ""}${input.abstract || ""}${input.intro || ""}${input.fullText || ""}`;
  if (/困境|问题|误区|断裂|失衡/.test(text)) return "困境";
  if (/循证|证据|数据/.test(text)) return "循证";
  if (/范式|模型|模式/.test(text)) return "范式";
  if (/素养|成长|发展/.test(text)) return "素养";
  return "逻辑";
}

function compactSubject(title) {
  return String(title || "")
    .replace(/[：:].+$/, "")
    .replace(/["""'《》]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 20) || "论文";
}

function validatePayload(body) {
  if (!body || typeof body !== "object") return "Invalid JSON body";
  if (!hasChinese(body.title)) return "第一版只处理中文论文标题，请提供中文原标题。";
  const contextLength = [body.abstract, body.intro, body.fullText]
    .map(value => String(value || "").trim().length)
    .reduce((sum, length) => sum + length, 0);
  if (contextLength < 80) return "请上传完整 Word，或展开手动粘贴区补充论文内容。";
  return "";
}

function isJsonModeUnsupported(payload) {
  const message = payload && payload.error && payload.error.message ? payload.error.message : "";
  return /(response_format|json|thinking)/i.test(message) && /not support|unsupported|invalid/i.test(message);
}

function extractChatCompletionText(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice && choice.message ? choice.message : {};
  if (typeof message.content === "string") return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .map(item => typeof item === "string" ? item : item && item.text ? item.text : "")
      .join("\n")
      .trim();
  }
  return "";
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Model returned empty output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON");
    return JSON.parse(match[0]);
  }
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[全文过长，已截断到前 ${maxLength} 字用于标题优化]`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length > 900000) throw new Error("Request body too large. 请上传更短的 Word，或只粘贴标题、摘要和引言。");
  return raw ? JSON.parse(raw) : {};
}

function loadLocalEnv(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const content = fsSync.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function hasChinese(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ""));
}

function stringOr(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function arrayOfStrings(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map(item => String(item || "").trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function compactKey(value) {
  return String(value || "").replace(/\s+/g, "");
}

function sanitizeErrorMessage(error) {
  return String(error && error.message ? error.message : error || "Server error")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .slice(0, 500);
}

async function sendFile(res, filePath, contentType) {
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(content);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendCorsPreflight(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  });
  res.end();
}
