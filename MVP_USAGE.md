# 教育/社科论文标题门诊 MVP

## 当前实现

- 入口文件：`title-clinic-mvp.html`
- 推荐运行方式：通过本地 Node 服务打开，前端会调用 `/api/optimize-title`。
- 离线演示方式：直接用浏览器打开 HTML 文件，会自动降级为本地规则版。
- 输入方式：
  - 上传 `.docx`，浏览器本地解析全文，并尽量自动识别原标题、摘要、引言。
  - 或手动粘贴“原标题 + 摘要 + 引言”。
- 输出内容：
  - 原题诊断，最多 3 条。
  - 1 个推荐标题。
  - 3 个备选标题：稳妥投稿型、问题意识型、学术表达型。
  - 每个标题附简短修改理由。

## MVP 边界

- 只面向中文教育/社科论文。
- 只处理投稿前标题优化。
- 不做全文润色、选题生成、期刊匹配、查重、英文标题、批量处理。
  - 不保存用户论文，`.docx` 解析在浏览器本地完成；通过服务访问时，会把全文片段发给 API 用于理解论文。
- 不处理扫描 PDF、图片 PDF 或附件材料。

## 接入 DeepSeek API

1. 安装 Node.js 18 或更高版本。
2. 打开 `.env`，把第一行改成你的 DeepSeek API key：

```text
DEEPSEEK_API_KEY=sk-xxxxxxxx
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_BASE_URL=https://api.deepseek.com
PORT=3000
```

3. 启动服务：

```powershell
npm start
```

4. 打开：

```text
http://localhost:3000
```

如果没有设置 `DEEPSEEK_API_KEY`，服务仍可启动，但 `/api/optimize-title` 会返回本地 fallback 结果。当前项目固定按 `deepseek-v4-pro` 准备。

## API 约定

请求：

```http
POST /api/optimize-title
Content-Type: application/json
```

```json
{
  "title": "原标题",
  "abstract": "摘要",
  "intro": "引言",
  "fullText": "可选，上传 .docx 后解析出的全文"
}
```

响应：

```json
{
  "profile": {
    "object": "研究对象",
    "scene": "研究场景",
    "method": "方法线索",
    "academicPivot": "学术支点"
  },
  "diagnosis": ["最多3条原题问题"],
  "recommendedTitle": "1个最推荐标题",
  "recommendedReason": "1句话理由",
  "alternativeTitles": [
    {"type": "稳妥投稿型", "title": "标题", "reason": "1句话理由"},
    {"type": "问题意识型", "title": "标题", "reason": "1句话理由"},
    {"type": "学术表达型", "title": "标题", "reason": "1句话理由"}
  ],
  "meta": {
    "mode": "api"
  }
}
```

## 后续接入专家材料

专家讲座材料建议沉淀为三类规则后再接入：

- 标题诊断规则：空泛、口号化、范围过大、对象不清、问题意识弱、学术感不足。
- 标题改写动作：压缩范围、突出对象、显化变量关系、加入机制/困境/路径/逻辑等学术支点。
- 案例校准规则：把 10 篇改前改后案例整理为“原题问题 -> 修改动作 -> 新题优势”。

落地方式：

- 参考 `expert-methodology.example.md`。
- 新建 `expert-methodology.md`，把整理后的专家方法论放进去。
- 后端会自动读取 `expert-methodology.md` 并注入 API prompt。
- 如需放在其他路径，可设置：

```powershell
$env:EXPERT_RULES_PATH="C:\path\to\expert-methodology.md"
```

## 人工验收

1. 打开 `title-clinic-mvp.html`。
2. 点击“示例”，再点击“开始诊断”。
3. 检查是否生成 1 个推荐标题和 3 个不同取向备选标题。
4. 配置 `DEEPSEEK_API_KEY` 后用 `npm start` 打开服务，再用专家 10 篇案例逐条试跑，观察诊断是否能解释专家的改题方向。
