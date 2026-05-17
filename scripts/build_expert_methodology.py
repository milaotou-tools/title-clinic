"""
Build expert-methodology.md from the precious source files.

This script intentionally treats the expert materials as primary data:
- DOCX files: read all Word XML text, including body, headers, footers, footnotes,
  endnotes, and comments when present.
- PDF files: extract embedded text per page; when a page has little/no text,
  render the page and try local OCR engines if available.
- MP3 files: intentionally skipped because the transcript DOCX is the source.
- This script does not call any LLM. It only prepares complete local evidence
  files so ChatGPT/Codex can read, compare, and write the methodology.

Run:
  python scripts/build_expert_methodology.py

Optional:
  set PYTHONUTF8=1
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "expert-sources"
EXTRACTED_DIR = OUT_DIR / "extracted"
PAGES_DIR = OUT_DIR / "pages"
STRUCTURED_DIR = OUT_DIR / "structured"
OUTPUT_FILE = ROOT / "expert-methodology.md"

EXPECTED_SOURCES = [
    "取标题的理论.pdf",
    "修改示范.pdf",
    "怎么取标题_导读.docx",
    "怎么取标题_原文.docx",
]

SKIP_NAMES = {
    "怎么取标题.MP3",
    "expert-methodology.md",
    "expert-methodology.example.md",
    "MVP_USAGE.md",
}


@dataclass
class SourceText:
    path: Path
    kind: str
    text: str
    warnings: list[str]


def main() -> None:
    load_env(ROOT / ".env")
    load_env(ROOT / ".env.local")

    for directory in (EXTRACTED_DIR, PAGES_DIR, STRUCTURED_DIR):
        directory.mkdir(parents=True, exist_ok=True)

    sources = discover_sources()
    if not sources:
        raise SystemExit("没有找到专家材料。请确认 PDF/DOCX 在项目目录中。")

    extracted: list[SourceText] = []
    for source in sources:
        print(f"[extract] {source.name}")
        item = extract_source(source)
        extracted.append(item)
        write_text(EXTRACTED_DIR / f"{safe_name(source)}.txt", item.text)
        if item.warnings:
            write_text(EXTRACTED_DIR / f"{safe_name(source)}.warnings.txt", "\n".join(item.warnings))

    write_manifest(extracted)

    write_manual_review_template(extracted)

    print("")
    print("完成：已抽取全部可读材料。")
    print(f"抽取文本：{EXTRACTED_DIR}")
    print(f"人工整理模板：{STRUCTURED_DIR / 'manual_review_template.md'}")
    print("下一步：由 Codex/ChatGPT 读取 extracted 文本，逐字整理 expert-methodology.md。")


def discover_sources() -> list[Path]:
    found = []
    for name in EXPECTED_SOURCES:
        path = ROOT / name
        if path.exists():
            found.append(path)

    if found:
        missing = [name for name in EXPECTED_SOURCES if not (ROOT / name).exists()]
        if missing:
            print("[warn] missing expected sources:", ", ".join(missing))
        return found

    candidates = []
    for path in ROOT.iterdir():
        if path.name in SKIP_NAMES or path.name.startswith("~$"):
            continue
        if path.suffix.lower() in {".docx", ".pdf", ".txt", ".md"}:
            candidates.append(path)
    return sorted(candidates)


def extract_source(path: Path) -> SourceText:
    ext = path.suffix.lower()
    if ext == ".docx":
        text, warnings = extract_docx_all_text(path)
        return SourceText(path, "docx", text, warnings)
    if ext == ".pdf":
        text, warnings = extract_pdf_with_ocr(path)
        return SourceText(path, "pdf", text, warnings)
    text = path.read_text(encoding="utf-8", errors="ignore")
    return SourceText(path, ext.lstrip("."), normalize_text(text), [])


def extract_docx_all_text(path: Path) -> tuple[str, list[str]]:
    warnings: list[str] = []
    parts = []
    xml_targets = [
        "word/document.xml",
        "word/footnotes.xml",
        "word/endnotes.xml",
        "word/comments.xml",
    ]
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        for name in sorted(names):
            if re.match(r"word/(header|footer)\d+\.xml$", name):
                xml_targets.append(name)

        for target in xml_targets:
            if target not in names:
                continue
            xml = zf.read(target)
            text = word_xml_to_text(xml)
            if text.strip():
                parts.append(f"\n\n===== {target} =====\n{text}")

    if not parts:
        warnings.append("DOCX 中未抽取到文本。")
    return normalize_text("\n".join(parts)), warnings


def word_xml_to_text(xml: bytes) -> str:
    ns = {
        "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    }
    root = ET.fromstring(xml)
    lines = []
    for paragraph in root.iterfind(".//w:p", ns):
        tokens = []
        for node in paragraph.iter():
            if node.tag == f"{{{ns['w']}}}t" and node.text:
                tokens.append(node.text)
            elif node.tag == f"{{{ns['w']}}}tab":
                tokens.append("\t")
            elif node.tag == f"{{{ns['w']}}}br":
                tokens.append("\n")
        line = "".join(tokens).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def extract_pdf_with_ocr(path: Path) -> tuple[str, list[str]]:
    warnings: list[str] = []

    try:
        import fitz  # PyMuPDF
    except Exception:
        fitz = None

    if fitz is None:
        text, fallback_warnings = extract_pdf_text_only_fallback(path)
        fallback_warnings.append("未找到 PyMuPDF(fitz)，无法把扫描页渲染为图片做 OCR。")
        return text, fallback_warnings

    doc = fitz.open(path)
    page_texts = []
    for page_index, page in enumerate(doc, start=1):
        text = normalize_text(page.get_text("text") or "")
        page_dir = PAGES_DIR / safe_name(path)
        page_dir.mkdir(parents=True, exist_ok=True)

        if len(text) < 30:
            image_path = page_dir / f"page-{page_index:03d}.png"
            pix = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
            pix.save(image_path)
            ocr_text, ocr_warning = ocr_image(image_path)
            if ocr_warning:
                warnings.append(f"第 {page_index} 页 OCR 警告：{ocr_warning}")
            text = normalize_text(ocr_text)

        if not text:
            warnings.append(f"第 {page_index} 页没有抽取到文字。")
            text = "[本页未抽取到文字]"

        page_texts.append(f"===== Page {page_index} =====\n{text}")

    return normalize_text("\n\n".join(page_texts)), warnings


def extract_pdf_text_only_fallback(path: Path) -> tuple[str, list[str]]:
    warnings = []
    try:
        import pypdf
        reader = pypdf.PdfReader(str(path))
        pages = []
        for index, page in enumerate(reader.pages, start=1):
            pages.append(f"===== Page {index} =====\n{page.extract_text() or ''}")
        return normalize_text("\n\n".join(pages)), warnings
    except Exception as exc:
        warnings.append(f"PDF 文本抽取失败：{exc}")
        return "", warnings


def ocr_image(image_path: Path) -> tuple[str, str]:
    # Prefer local OCR so the original PDF images do not leave the machine.
    tesseract = shutil.which("tesseract")
    if tesseract:
        try:
            result = subprocess.run(
                [tesseract, str(image_path), "stdout", "-l", "chi_sim+eng", "--psm", "6"],
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
            )
            return result.stdout, ""
        except Exception as exc:
            return "", f"tesseract 执行失败：{exc}"

    try:
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
        result = ocr.ocr(str(image_path), cls=True)
        lines = []
        for page in result or []:
            for line in page or []:
                if len(line) >= 2 and line[1]:
                    lines.append(str(line[1][0]))
        return "\n".join(lines), ""
    except Exception:
        pass

    return "", "未找到本地 OCR 引擎。请安装 Tesseract 中文语言包或 PaddleOCR 后重跑；图片页已保存到 expert-sources/pages。"


def write_manifest(extracted: list[SourceText]) -> None:
    manifest = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "sources": [
            {
                "file": item.path.name,
                "kind": item.kind,
                "chars": len(item.text),
                "warnings": item.warnings,
            }
            for item in extracted
        ],
    }
    write_text(OUT_DIR / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))


def write_manual_review_template(extracted: list[SourceText]) -> None:
    manifest = json.loads((OUT_DIR / "manifest.json").read_text(encoding="utf-8"))
    lines = [
        "# 专家材料人工整理模板",
        "",
        f"生成时间：{datetime.now().isoformat(timespec='seconds')}",
        "",
        "## 资料来源清单",
        "",
    ]
    for source in manifest["sources"]:
        warnings = "；".join(source["warnings"]) if source["warnings"] else "无"
        lines.append(f"- {source['file']}：{source['kind']}，{source['chars']} 字，警告：{warnings}")

    lines.extend([
        "",
        "## 逐字阅读任务",
        "",
        "- 读完 `expert-sources/extracted` 下每一个文本文件。",
        "- 不使用 DeepSeek 归纳专家材料。",
        "- 对 PDF 图片页，如果 OCR 警告存在，先补 OCR 或人工核对截图。",
        "- 从 `修改示范.pdf` 中逐个识别改前标题、改后标题、改动点、为什么这样改。",
        "",
        "## 输出 expert-methodology.md 必须包含",
        "",
        "1. 专家核心理念。",
        "2. 标题命名规则，按 R01/R02 编号。",
        "3. 原题病灶诊断表。",
        "4. 改题动作库。",
        "5. 10 篇示范案例复盘。",
        "6. API 生成标题硬约束。",
        "7. 最终可注入后端 prompt 的短规则。",
        "",
    ])
    write_text(STRUCTURED_DIR / "manual_review_template.md", "\n".join(lines))


def normalize_text(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text.replace("\r\n", "\n"))).strip()


def safe_name(path: Path) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", path.name).strip("_")[:120]


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


if __name__ == "__main__":
    main()
