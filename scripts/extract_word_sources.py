from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "expert-sources" / "word-fulltext"
COMBINED = OUT_DIR / "ALL_WORD_SOURCES_FULLTEXT.md"

SOURCE_NAMES = [
    "改造标题案例示范.docx",
    "怎么取标题_导读.docx",
    "怎么取标题_原文.docx",
    "怎么选题和取小标题.docx",
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sections = []
    missing = []

    for name in SOURCE_NAMES:
        path = ROOT / name
        if not path.exists():
            missing.append(name)
            continue
        text = extract_docx(path)
        out = OUT_DIR / f"{path.stem}.txt"
        out.write_text(text, encoding="utf-8")
        sections.append(f"# {name}\n\n{text}")
        print(f"extracted {name}: {len(text)} chars")

    if missing:
        print("missing:", ", ".join(missing))

    COMBINED.write_text("\n\n---\n\n".join(sections), encoding="utf-8")
    print(f"combined: {COMBINED}")


def extract_docx(path: Path) -> str:
    parts = []
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        targets = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"]
        targets += sorted(name for name in names if re.match(r"word/(header|footer)\d+\.xml$", name))
        for target in targets:
            if target not in names:
                continue
            xml = zf.read(target)
            text = xml_to_text(xml)
            if text.strip():
                parts.append(f"## {target}\n\n{text}")
    return normalize("\n\n".join(parts))


def xml_to_text(xml: bytes) -> str:
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
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


def normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


if __name__ == "__main__":
    main()
