"""置き場・棚・発表・最近の一覧。設計書 §4.1・§5.4・§5.5。"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from . import __version__, source
from .fsutil import sha256_bytes, write_atomic

PKG = Path(__file__).resolve().parent
TEMPLATES = PKG / "templates"
RUNTIME = PKG / "runtime"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
RUNTIME_FILES = ["figure.mjs", "motion.mjs", "figure.css"]
# 前の版の themes/default.css の sha256（手を入れていなければ ensure で今の版に置き換える）
OLD_DEFAULT_THEMES = {
    "6c68f6dd20506ee79b5d70c1e9b98e2bea4fdc82efbd0880d57400b3abf36010",
    "c0d0274749f3d6aaba9a55f871d5cd7cc716ef32d84264e89c72f3d421253e08",
}
# default 以外の同梱テーマの前の版（手を入れていなければ ensure で今の版に置き換える）。
# 今は置いた版を .slide-studio/bundled-themes.json に覚えるので、ここに足すのはそれより前に配った版だけ
OLD_THEMES = {
    "graphite.css": {"0658790fab7e283857cec03cb5be6a6e8be57d3c83aa3d6ba02844ebb583314e"},
    "serif.css": {"cd884b15fed2797d38215860ac8103fba502d14aa1cd6f00a5b221b0006529e9"},
    "solarized.css": {"85b228bb48b2a3ec9c8abfb978dac05741b9ccf2755f6b614d79f8088e460a2c"},
    "mist.css": {"2656730b18615d99c913560c5be61cde732d2d47fd3a63cb89cdad3785e26255", "cc107dfd25460ea4345406efa0287246763e4174efc2035bceb082074d7fd1ea"},
    "night.css": {"b6547be3896e5b0e82d624b0b499409abe40516b8a2d7412af7d815b22d49428",
                  "b815b3f3585929435c54c37d6a9c4de1132393bf8e1772a5c9357627b5c9675d"},
}
# 廃止した同梱テーマ。ensure で控えを残して除去し、使っていた発表は default へ移す
RETIRED_THEMES = ("sage", "simple")


# 型の CSS が唯一の必須変数一覧。コメント中の例は宣言として扱わない。
def theme_variables(css: str) -> tuple[str, ...]:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return tuple(dict.fromkeys(re.findall(r"(?<![\w-])(--[\w-]+)\s*:\s*[^;{}\s][^;{}]*(?=[;}])", css)))


THEME_VARIABLES = theme_variables((TEMPLATES / "themes" / "_base.css").read_text())


class StudioError(Exception):
    """利用者に見せるエラー（日本語の文言をそのまま出す）。"""


def check_name(value: str, what: str = "名前") -> str:
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise StudioError(f"{what}には英小文字・数字・ハイフンを使ってください: {value!r}")
    return value


def default_root() -> Path:
    configured = os.environ.get("SLIDE_STUDIO_HOME")
    if configured:
        return Path(configured).expanduser()
    return saved_root() or Path.home() / "Slides"


def location_file() -> Path:
    return Path.home() / ".config" / "slide-studio" / "location.json"


def saved_root() -> Path | None:
    try:
        value = json.loads(location_file().read_text())["root"]
        path = Path(value).expanduser()
        return path if path.is_absolute() else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def recent_roots() -> list[str]:
    try:
        data = json.loads(location_file().read_text())
        values = [data.get("root"), *data.get("recent", [])]
        return list(dict.fromkeys(v for v in values if isinstance(v, str) and Path(v).is_absolute()))[:12]
    except (OSError, ValueError, TypeError, AttributeError):
        return []


def remember_root(root: Path, *, previous: Path | None = None) -> None:
    recent = list(dict.fromkeys([str(root), *([str(previous)] if previous else []), *recent_roots()]))[:12]
    write_atomic(location_file(), json.dumps({"root": str(root), "recent": recent}, ensure_ascii=False))


@dataclass
class Workspace:
    root: Path

    @classmethod
    def open(cls, root: Path | str | None = None, ensure: bool = True) -> "Workspace":
        ws = cls(Path(root).expanduser().resolve() if root else default_root().resolve())
        if ensure:
            ws.ensure()
        return ws

    # ------------------------------------------------------------ 場所
    @property
    def topics(self) -> Path:
        return self.root / "topics"

    @property
    def decks(self) -> Path:
        return self.root / "decks"

    @property
    def themes(self) -> Path:
        return self.root / "themes"

    @property
    def state(self) -> Path:
        return self.root / ".slide-studio"

    @property
    def runtime(self) -> Path:
        return self.state / "runtime"

    def build_dir(self, deck: str) -> Path:
        return self.state / "build" / deck

    def deck_dir(self, deck: str) -> Path:
        return self.decks / deck

    def qmd(self, deck: str) -> Path:
        return self.deck_dir(deck) / "slides.qmd"

    def memo(self, deck: str) -> Path:
        """下書き（左の欄の［下書き］タブ）。"""
        return self.deck_dir(deck) / "memo.md"

    def shelf_dir(self, shelf: str) -> Path:
        return self.topic_dir(shelf) / "html"

    def topic_dir(self, shelf: str) -> Path:
        return self.topics / check_name(shelf, "トピック")

    def asset_root(self, deck: str) -> Path:
        return self.topic_dir(self.deck_shelf(deck))

    def images_dir(self, deck: str) -> Path:
        return self.asset_root(deck) / "images"

    # ------------------------------------------------------------ 用意
    def ensure(self) -> None:
        from .topic_migrate import migrate as migrate_topics
        migrate_topics(self)
        for d in (self.topics, self.decks, self.themes, self.state):
            d.mkdir(parents=True, exist_ok=True)
        # 同梱テーマは置いた版の sha256 を覚え、手を入れていなければ今の版に揃える
        record = self.state / "bundled-themes.json"
        try:
            placed = json.loads(record.read_text())
        except (OSError, ValueError):
            placed = {}
        before = dict(placed)
        for src in sorted((TEMPLATES / "themes").glob("*.css")):
            if src.name.startswith("_"):
                continue  # 型は選べるテーマとして配らない
            dst = self.themes / src.name
            data = src.read_bytes()
            if not dst.exists() and src.name in placed and placed[src.name] is None:
                continue  # 一覧から削除した同梱テーマ
            if dst.exists():
                digest = sha256_bytes(dst.read_bytes())
                if digest == sha256_bytes(data):
                    placed[src.name] = digest
                    continue
                if src.name == "default.css" and digest in OLD_DEFAULT_THEMES:
                    self._migrate_default_deck_styles()
                elif digest != placed.get(src.name) and digest not in OLD_THEMES.get(src.name, ()):
                    continue
            write_atomic(dst, data)
            placed[src.name] = sha256_bytes(data)
        # serif は terracotta に交代。旧テーマと参照元の控えを残して移行する。
        old_serif = self.themes / 'serif.css'
        if old_serif.exists() and (self.themes / 'terracotta.css').exists():
            digest = sha256_bytes(old_serif.read_bytes())
            untouched = digest == placed.get('serif.css') or digest in OLD_THEMES.get('serif.css', ())
            if untouched:
                trash = self.state / 'trash' / 'themes' / str(time.time_ns())
                write_atomic(trash / 'serif.css', old_serif.read_bytes())
                for deck in self.list_decks():
                    if self.deck_theme(deck) == 'serif':
                        path = self.qmd(deck)
                        text = path.read_text()
                        write_atomic(trash / 'decks' / deck / 'slides.qmd', text)
                        write_atomic(path, set_front(text, {'theme': 'terracotta'}))
                prefs = self.prefs()
                recent = list(dict.fromkeys('terracotta' if n == 'serif' else n for n in prefs.get('recent_themes', [])))
                self.set_prefs(recent_themes=recent, **({'theme': 'terracotta'} if prefs.get('theme') == 'serif' else {}))
                old_serif.unlink()
                placed['serif.css'] = None
        for name in RETIRED_THEMES:
            self._retire_theme(name)
            placed.pop(f'{name}.css', None)
        from .block_design import with_current_palette
        from .theme_edit import refresh_heading_options, preserve_title_header, drop_cover_layout, OVERRIDE_RE, read_vars
        for path in self.themes.glob("*.css"):
            css = path.read_text()
            updated = drop_cover_layout(refresh_heading_options(css))
            # ブロックの配色の層だけを今の版にする。テーマ本文や GUI の個別調整はそのまま。
            if set(THEME_VARIABLES) <= set(theme_variables(css)):
                repainted = with_current_palette(updated, read_vars(css))
                if repainted != updated:
                    write_atomic(self.state / 'trash' / 'themes' / str(time.time_ns()) / path.name, css)
                    updated = repainted

            # 旧版で見出しの塗りと連動し、題名が背景と同色になったテーマを修復。
            original = TEMPLATES / 'themes' / path.name
            colors = read_vars(css)
            if OVERRIDE_RE.search(css) and colors.get('--header') == colors.get('--paper') and original.exists():
                updated = preserve_title_header(updated, original.read_text())
            if updated != css:
                write_atomic(path, updated)
        if placed != before:
            write_atomic(record, json.dumps(placed, indent=1, sort_keys=True))
        # 図の runtime は Slide Studio の版に合わせて置き直す（図の index.html が相対パスで読む）
        self.runtime.mkdir(parents=True, exist_ok=True)
        for name in RUNTIME_FILES:
            src, dst = RUNTIME / name, self.runtime / name
            data = src.read_bytes()
            if not dst.exists() or dst.read_bytes() != data:
                write_atomic(dst, data)
        from .bibliography import migrate
        migrate(self)
        self._ensure_agent_files()
        from .portable import ensure_portable
        ensure_portable(self)

    def _retire_theme(self, name: str) -> None:
        """廃止したテーマを控えを残して除去し、発表と選択履歴を default へ移す。"""
        retired = self.themes / f'{name}.css'
        prefs = self.prefs()
        affected = [deck for deck in self.list_decks() if self.deck_theme(deck) == name]
        if retired.exists() or affected or prefs.get('theme') == name or name in prefs.get('recent_themes', []):
            trash = self.state / 'trash' / 'themes' / str(time.time_ns())
            if retired.exists():
                write_atomic(trash / retired.name, retired.read_bytes())
            for deck in affected:
                path = self.qmd(deck)
                text = path.read_text()
                write_atomic(trash / 'decks' / deck / 'slides.qmd', text)
                write_atomic(path, set_front(text, {'theme': 'default'}))
            recent = list(dict.fromkeys('default' if n == name else n for n in prefs.get('recent_themes', [])))
            self.set_prefs(recent_themes=recent, **({'theme': 'default'} if prefs.get('theme') == name else {}))
            retired.unlink(missing_ok=True)
        (self.state / 'theme-defaults' / f'{name}.css').unlink(missing_ok=True)
        shutil.rmtree(self.state / 'themes' / name, ignore_errors=True)

    def _migrate_default_deck_styles(self) -> None:
        """旧テーマに含まれた発表固有の規則を、既存の上書きより前に残す。"""
        legacy = (TEMPLATES / "migrations" / "nco-intro.css").read_text()
        for deck in self.list_decks():
            if self.deck_theme(deck) != "default":
                continue
            path = self.deck_dir(deck) / "styles" / "slides.css"
            css = path.read_text() if path.exists() else ""
            if legacy.strip() not in css:
                write_atomic(path, legacy + "\n" + css)

    def theme_preparation(self) -> list[dict]:
        """手を入れた旧テーマは保護し、ホームの環境表示に報告する。"""
        path = self.themes / "default.css"
        if not path.is_file():
            return []
        css = path.read_text()
        # 型を満たした新テーマの色などを直しただけなら移行は不要。
        if set(THEME_VARIABLES).issubset(theme_variables(css)):
            return []
        # UI 文言の正本は strings.js。JSON としても読める独立した定数。
        strings = (PKG / "web" / "strings.js").read_text()
        messages, _ = json.JSONDecoder().raw_decode(strings.split("export const THEME_PREPARATION = ", 1)[1])
        return [{"name": messages["name"], "ok": False,
                 "detail": messages["detail"], "fix": messages["fix"]}]

    def migration_preparation(self) -> list[dict]:
        from .bibliography import conflicts
        strings = (PKG / "web" / "strings.js").read_text()
        messages, _ = json.JSONDecoder().raw_decode(strings.split("export const MIGRATION_PREPARATION = ", 1)[1])
        out = []
        if (self.root / "figures").exists() and self.topics.exists():
            out.append({"name": messages["topics"], "ok": False,
                        "detail": messages["folders"], "fix": messages["folderFix"]})
        for detail in conflicts(self):
            out.append({"name": messages["bib"], "ok": False,
                        "detail": detail, "fix": messages["bibFix"]})
        return out

    def _ensure_agent_files(self) -> None:
        """AI 用ファイルを配り、廃止した未編集のファイルを片付ける。.claude/skills/ は .agents/skills/ を指すリンク。"""
        tdir = TEMPLATES / "workspace"
        if not tdir.exists():
            return
        stamp = self.state / "agent-files.json"
        try:
            known = json.loads(stamp.read_text())
        except (OSError, ValueError):
            known = {}
        files = {}
        for src in sorted(tdir.rglob("*")):
            if not src.is_file():
                continue
            rel = src.relative_to(tdir).as_posix()
            files[rel] = src.read_bytes()
        for rel, data in files.items():
            dst = self.root / rel
            h = sha256_bytes(data)
            if dst.exists() and known.get(rel) == h:
                continue
            if dst.exists() and dst.read_bytes() == data:
                known[rel] = h
                continue
            # 置き場の利用者が直した版は残し、Slide Studio の版が変わったときだけ上書きする
            if dst.exists() and known.get(rel) and sha256_bytes(dst.read_bytes()) != known[rel] and known.get("_version") == __version__:
                continue
            write_atomic(dst, data)
            known[rel] = h
        for rel in known.keys() - files.keys() - {"_version"}:
            digest = known.pop(rel)
            path = Path(rel)
            if path.is_absolute() or ".." in path.parts:
                continue
            dst = self.root / path
            if not dst.is_file() or dst.is_symlink() or not dst.resolve().is_relative_to(self.root):
                continue
            if sha256_bytes(dst.read_bytes()) != digest:
                continue
            dst.unlink()
            parent = dst.parent
            while parent != self.root:
                try:
                    parent.rmdir()
                except OSError:
                    break  # 利用者のファイルが残るフォルダは消さない
                parent = parent.parent
        skills = {Path(rel).parts[2] for rel in files if rel.startswith(".agents/skills/")}
        links = self.root / ".claude" / "skills"
        for name in sorted(skills):
            link = links / name
            if not link.exists() and not link.is_symlink():
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(Path("../../.agents/skills") / name, target_is_directory=True)
        for link in links.iterdir() if links.is_dir() else ():
            # 廃止した skill を指したまま切れたリンクだけ消す
            if link.is_symlink() and not link.exists() and os.readlink(link) == f"../../.agents/skills/{link.name}":
                link.unlink()
        known["_version"] = __version__
        write_atomic(stamp, json.dumps(known, indent=1))

    # ------------------------------------------------------------ 発表
    def list_decks(self) -> list[str]:
        if not self.decks.exists():
            return []
        return sorted(p.name for p in self.decks.iterdir() if (p / "slides.qmd").is_file() and not p.name.startswith(("_", ".")))

    def has_deck(self, deck: str) -> bool:
        return self.qmd(deck).is_file()

    def require_deck(self, deck: str) -> Path:
        if not self.has_deck(deck):
            raise StudioError(f"発表がありません: {deck}（{self.deck_dir(deck)}）")
        return self.deck_dir(deck)

    def deck_meta(self, deck: str) -> dict:
        return source.parse(self.qmd(deck).read_text()).meta

    def deck_shelf(self, deck: str) -> str:
        shelf = self.deck_meta(deck).get("topic")
        if not shelf:
            raise StudioError(f"{deck} の front matter に topic:（トピック）がありません")
        return str(shelf)

    def bib(self, deck: str, meta: dict | None = None) -> Path:
        topic = (self.deck_meta(deck) if meta is None else meta).get("topic")
        if not topic:
            return self.state / "missing-topic.bib"
        return self.topic_dir(str(topic)) / "reference.bib"

    def deck_theme(self, deck: str) -> str:
        return str(self.deck_meta(deck).get("theme") or "default")

    def is_blank(self, deck: str) -> bool:
        """スライドの中身がまだ無い（ページが無いか、雛形のまま）。開いたときに左の欄の［下書き］を出す。"""
        text = self.qmd(deck).read_text()
        doc = source.parse(text)
        if not doc.pages:
            return True
        meta = doc.meta
        title = str(meta.get("title") or "")
        blank = blank_qmd(str(meta.get("topic") or ""), str(meta.get("theme") or ""),
                          None if title in ("", "発表タイトル") else title)
        return set_front(text, {}).strip() == blank.strip()

    def is_untouched(self, deck: str) -> bool:
        """原稿も下書きも手を入れていない。ホームの［＋］を隠す判定。"""
        if not self.is_blank(deck):
            return False
        memo = self.memo(deck)
        return not memo.exists() or memo.read_text().split() == (TEMPLATES / "deck" / "memo.md").read_text().split()

    def new_deck(self, deck: str, shelf: str, theme: str = "default", source_deck: str | None = None, title: str | None = None) -> Path:
        check_name(deck, "フォルダ名")
        check_name(shelf, "トピックの名前")
        check_name(theme, "テーマ")
        if source_deck:
            check_name(source_deck, "複製する発表")
        dest = self.deck_dir(deck)
        if dest.exists():
            raise StudioError(f"既にあります: {dest}")
        if not (self.themes / f"{theme}.css").exists():
            raise StudioError(f"テーマがありません: themes/{theme}.css")
        if source_deck:
            src = self.require_deck(source_deck)
            # 参考資料（materials/）は実験結果などで大きいことがあるので複製しない
            skip = shutil.ignore_patterns("*.html", "*.pdf", ".DS_Store")
            shutil.copytree(src, dest, ignore=lambda d, names: [*skip(d, names), *(["materials"] if Path(d) == src else [])])
            qmd = dest / "slides.qmd"
            # 別トピックへ複製するときも引用を保つ。
            source_bib = self.bib(source_deck)
            if shelf != self.deck_shelf(source_deck) and source_bib.exists():
                write_atomic(dest / "reference.bib", source_bib.read_bytes())
            # コピー元の共有図への参照を保つ。
            from .topic_migrate import copy_topic_assets
            text = copy_topic_assets(self, source_deck, deck, shelf, qmd.read_text())
            text = set_front(text, {"topic": shelf, "theme": theme})
            if title:
                text = set_front(text, {"title": json.dumps(title, ensure_ascii=False)})
            write_atomic(qmd, text)
        else:
            shutil.copytree(TEMPLATES / "deck", dest, ignore=shutil.ignore_patterns(".DS_Store"))
            write_atomic(dest / "slides.qmd", blank_qmd(shelf, theme, title))
        self.shelf_dir(shelf).mkdir(parents=True, exist_ok=True)
        self.images_dir(deck).mkdir(parents=True, exist_ok=True)
        from .bibliography import migrate
        migrate(self)
        self.touch_recent(deck)
        self.set_prefs(shelf=shelf, theme=theme)
        return dest

    # ------------------------------------------------------------ 最近
    @property
    def recent_file(self) -> Path:
        return self.state / "recent.json"

    def recent(self) -> list[dict]:
        try:
            items = json.loads(self.recent_file.read_text())
        except (OSError, ValueError):
            items = []
        known = {i["deck"] for i in items}
        # 置き場にあって一覧にない発表も、更新日時の順に出す
        for deck in self.list_decks():
            if deck not in known:
                items.append({"deck": deck, "opened": 0})
        out = []
        for i in items:
            if not self.has_deck(i["deck"]):
                continue
            qmd = self.qmd(i["deck"])
            meta = source.parse(qmd.read_text()).meta
            out.append({**i, "title": str(meta.get("title") or meta.get("pagetitle") or i["deck"]),
                        "shelf": str(meta.get("topic") or ""), "theme": str(meta.get("theme") or ""),
                        "modified": qmd.stat().st_mtime})
        out.sort(key=lambda i: (i.get("opened", 0), i["modified"]), reverse=True)
        return out

    def touch_recent(self, deck: str) -> None:
        try:
            items = json.loads(self.recent_file.read_text())
        except (OSError, ValueError):
            items = []
        items = [i for i in items if i.get("deck") != deck]
        items.insert(0, {"deck": deck, "opened": time.time()})
        write_atomic(self.recent_file, json.dumps(items[:50], ensure_ascii=False, indent=1))

    def prefs(self) -> dict:
        try:
            return json.loads((self.state / "prefs.json").read_text())
        except (OSError, ValueError):
            return {}

    def set_prefs(self, **values) -> None:
        p = self.prefs()
        p.update({k: v for k, v in values.items() if v is not None})
        write_atomic(self.state / "prefs.json", json.dumps(p, ensure_ascii=False, indent=1))

    # ------------------------------------------------------------ 棚と図
    def shelves(self) -> list[str]:
        if not self.topics.exists():
            return []
        return sorted(p.name for p in self.topics.iterdir() if p.is_dir() and not p.name.startswith((".", "_")))

    def new_topic(self, shelf: str) -> Path:
        dest = self.topic_dir(shelf)
        if dest.exists():
            raise StudioError(f"同じ名前のトピックがあります: {shelf}")
        dest.mkdir(parents=True)
        return dest

    def remove_topic(self, shelf: str) -> Path:
        """未使用のトピックを素材ごとゴミ箱へ移す。"""
        base = self.topic_dir(shelf)
        if base.is_symlink() or not base.is_dir() or base.resolve().parent != self.topics.resolve():
            raise StudioError("topicMissing")
        for deck in self.list_decks():
            text = self.qmd(deck).read_text()
            if (str(source.parse(text).meta.get("topic") or "") == shelf
                    or f"topics/{shelf}/" in text
                    or re.search(r"\{\{<\s*fig\s+[\"']?" + re.escape(shelf) + r"/", text)):
                raise StudioError("topicInUse")
        trash = self.state / "trash" / "topics" / f"{shelf}-{time.time_ns()}"
        trash.parent.mkdir(parents=True, exist_ok=True)
        base.rename(trash)
        return trash

    def topic_empty(self, shelf: str) -> bool:
        """トピックの中にファイルが1つもない（作ったまま）。"""
        return not any(p.is_file() and p.name != ".DS_Store" for p in self.topic_dir(shelf).rglob("*"))

    def themes_list(self) -> list[str]:
        return sorted(p.stem for p in self.themes.glob("*.css") if not p.name.startswith("_"))

    # テーマの「デフォルト」＝登録したときの CSS。登録したものは .slide-studio/theme-defaults/ に控え、
    # 同梱テーマは同梱の版。どちらも無い（AI や手で置いた）テーマはデフォルトに戻せない
    def theme_default(self, name: str) -> str | None:
        for path in (self.state / "theme-defaults" / f"{name}.css", TEMPLATES / "themes" / f"{name}.css"):
            if not name.startswith("_") and path.is_file():
                return path.read_bytes().decode("utf-8")
        return None

    def register_theme(self, name: str, css: str) -> None:
        check_name(name, "テーマ")
        if (self.themes / f"{name}.css").exists():
            raise StudioError("同じ名前のテーマがあります")
        write_atomic(self.state / "theme-defaults" / f"{name}.css", css)
        write_atomic(self.themes / f"{name}.css", css)

    def remove_theme(self, name: str) -> Path:
        """消すのは使っている発表が無いテーマだけ。CSS は .slide-studio/trash/themes/<時刻>/ へ移す。"""
        check_name(name, "テーマ")
        path = self.themes / f"{name}.css"
        if not path.is_file():
            raise StudioError("テーマがありません")
        if name == "default":
            raise StudioError("default のテーマは削除できません")
        if using := [d for d in self.list_decks() if self.deck_theme(d) == name]:
            raise StudioError(f"このテーマを使う発表があります：{'、'.join(using)}")
        trash = self.state / "trash" / "themes" / str(time.time_ns())
        trash.mkdir(parents=True)
        shutil.move(path, trash / path.name)
        (self.state / "theme-defaults" / f"{name}.css").unlink(missing_ok=True)
        shutil.rmtree(self.state / "themes" / name, ignore_errors=True)  # 縮小画像
        # 同梱テーマは次の起動で置き直さないよう覚えておく（ensure）
        record = self.state / "bundled-themes.json"
        if (TEMPLATES / "themes" / path.name).is_file():
            try:
                placed = json.loads(record.read_text())
            except (OSError, ValueError):
                placed = {}
            write_atomic(record, json.dumps({**placed, path.name: None}, indent=1, sort_keys=True))
        prefs = self.prefs()
        self.set_prefs(recent_themes=[n for n in prefs.get("recent_themes", []) if n != name],
                       **({"theme": "default"} if prefs.get("theme") == name else {}))
        return trash / path.name

    def figure_dir(self, ref: str, deck: str | None = None) -> Path:
        """qmd の参照（nco/route-example）からトピックの図のフォルダ。"""
        shelf, sep, name = ref.partition('/')
        if not sep or shelf == '.' or not name or Path(name).is_absolute() or '..' in Path(name).parts:
            raise StudioError(f"トピック/名前で図を指定してください: {ref}")
        return self.shelf_dir(shelf) / name

    def list_figures(self, shelf: str | None = None, deck: str | None = None) -> list[dict]:
        shelf = self.deck_shelf(deck) if deck else shelf
        base = self.shelf_dir(shelf)
        if not base.exists():
            return []
        out = []
        for d in sorted(base.iterdir()):
            if d.is_dir() and not d.name.startswith((".", "_")) and (d / "figure.mjs").exists():
                out.append({"name": d.name, "ref": f"{shelf}/{d.name}",
                            "title": figure_title(d), "steps": figure_steps(d),
                            "place": "shelf"})
        return out

    def decks_using(self, ref: str) -> list[str]:
        """棚の図（nco/x）を使っている発表。"""
        out = []
        for deck in self.list_decks():
            text = self.qmd(deck).read_text()
            for m in re.finditer(r"\{\{<\s*fig\s+(\S+)", text):
                if m[1].strip('"') == ref:
                    out.append(deck)
                    break
        return out


def runtime_rel(fig_dir: Path, ws: Workspace) -> str:
    """図のフォルダから .slide-studio/runtime への相対パス。"""
    return os.path.relpath(ws.runtime, fig_dir).replace(os.sep, "/")


def figure_title(d: Path) -> str:
    try:
        m = re.search(r"""\btitle\s*:\s*(['"`])(.*?)\1""", (d / "figure.mjs").read_text())
        return m[2] if m else d.name
    except OSError:
        return d.name


def figure_steps(d: Path) -> list[str]:
    try:
        m = re.search(r"\bsteps\s*:\s*\[(.*?)\]", (d / "figure.mjs").read_text(), re.S)
        return [s for _, s in re.findall(r"""(['"`])(.*?)\1""", m[1])] if m else []
    except OSError:
        return []


def set_front(text: str, values: dict) -> str:
    """front matter のキーを書き換える（無いキーは足す）。他の行はそのまま残す。"""
    doc = source.parse(text)
    values = {("topic" if k == "figures" else k): v for k, v in values.items()}
    if doc.front[1] and "figures" in doc.meta:
        head = text[:doc.front[1]]
        if re.search(r"^topic\s*:", head, re.M):
            head = re.sub(r"^figures\s*:.*\n", "", head, flags=re.M)
        else:
            head = re.sub(r"^figures(?=\s*:)", "topic", head, flags=re.M)
        text = head + text[doc.front[1]:]
        doc = source.parse(text)
    if not doc.front[1]:
        if not values:
            return text
        lines = "".join(f"{k}: {v}\n" for k, v in values.items())
        return f"---\n{lines}---\n\n" + text
    head = text[:doc.front[1]]
    rest = text[doc.front[1]:]
    lines = head.split("\n")
    # lines[0] は '---'、最後の区切りの行を探す
    close = max(i for i, l in enumerate(lines) if l.strip() in ("---", "...") and i > 0)
    for k, v in values.items():
        pat = re.compile(rf"^{re.escape(k)}\s*:")
        hit = next((i for i in range(1, close) if pat.match(lines[i])), None)
        if hit is not None:
            lines[hit] = f"{k}: {v}"
        else:
            lines.insert(close, f"{k}: {v}")
            close += 1
    return "\n".join(lines) + rest


def blank_qmd(shelf: str, theme: str, title: str | None = None) -> str:
    """新しい発表の原稿（雛形）。is_blank はこれと同じかどうかで「中身がまだ無い」を決める。"""
    text = (TEMPLATES / "deck" / "slides.qmd").read_text().replace("{{SHELF}}", shelf).replace("{{THEME}}", theme)
    if title:
        text = text.replace("発表タイトル", title.replace("\n", " ").replace("\r", " "))
        text = set_front(text, {"title": json.dumps(title, ensure_ascii=False)})
    return text
