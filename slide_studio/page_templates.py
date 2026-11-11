"""ページのひな形の仮文字。文言は UI と同じ正本から読む。"""
import json
import re
from pathlib import Path

from . import source


_strings = (Path(__file__).parent / "web" / "strings.js").read_text()
PLACEHOLDERS = json.JSONDecoder().raw_decode(_strings.split("export const PAGE_PLACEHOLDERS =", 1)[1].lstrip())[0]


def placeholder_blocks(doc: source.Doc):
    """仮文字が単独で残る段落・項目・表セルを含むブロック。コードは除く。"""
    words = set(PLACEHOLDERS.values())
    for page in doc.pages:
        for chunk in page.walk():
            if chunk.kind != "text":
                continue
            raw = doc.text[chunk.start:chunk.end].strip()
            if raw.startswith(("```", "~~~", "$$", "    ", "\t")):
                continue
            for cell in re.split(r"[\n|]", raw):
                cell = re.sub(r"^(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)", "", cell.strip())
                cell = re.sub(r"^\*\*(.*?)\*\*$", r"\1", cell)
                if cell in words:
                    yield page, chunk
                    break
