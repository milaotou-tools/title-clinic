# 专家材料抽取与 OCR 说明

## 结论先说

这些材料不能粗糙处理。当前项目的专家库必须基于以下 4 个文件完整整理：

- `取标题的理论.pdf`
- `修改示范.pdf`
- `怎么取标题_导读.docx`
- `怎么取标题_原文.docx`

`怎么取标题.MP3` 不处理，因为已有转写 Word。

## 谁来整理

- 专家材料的学习、案例对齐、命名规则沉淀：由 Codex/ChatGPT 完成。
- DeepSeek：只用于之后诊断用户上传的新论文，不用于整理专家材料。

## PDF 怎么处理

脚本 `scripts/build_expert_methodology.py` 会按顺序尝试：

1. PDF 内嵌文字抽取。
2. 如果页面没有文字，渲染该页为 PNG。
3. 如果本机有 Tesseract 中文 OCR，则自动 OCR。
4. 如果本机有 PaddleOCR，则自动 OCR。
5. 如果都没有，会保存页面图片并写入 warning，不会假装识别成功。

## 运行命令

在 PowerShell 里执行：

```powershell
cd "C:\Users\admin\Desktop\论文标题优化"
npm run extract:expert
```

或直接执行：

```powershell
cd "C:\Users\admin\Desktop\论文标题优化"
python scripts\build_expert_methodology.py
```

## 运行后会生成

- `expert-sources/manifest.json`：每个文件抽取了多少字、有哪些警告。
- `expert-sources/extracted/*.txt`：每个 Word/PDF 的抽取文本。
- `expert-sources/pages/`：PDF 图片页渲染结果。
- `expert-sources/structured/manual_review_template.md`：人工整理任务清单。

## 判断是否需要你用别的工具处理 PDF

打开：

```text
expert-sources/manifest.json
```

如果看到类似：

```text
未找到本地 OCR 引擎
本页未抽取到文字
```

说明扫描 PDF 没有成功 OCR。此时请用你信任的 OCR 工具把 PDF 转成 `.txt` 或 `.docx`，放回本目录，我再基于转写文字继续整理专家库。

如果 `取标题的理论.pdf` 和 `修改示范.pdf` 都抽出了完整文字，我就可以继续逐字阅读并写入 `expert-methodology.md`。
