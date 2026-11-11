"""チャット：タブ・未送信の指示・まとめて送信・実行・検査・戻す。設計書 §8.1〜§8.4、作業手順書 手順6。

- タブごとに AI のモデル・思考量・session を持ち、タブどうしは並行して実行できる。同じタブでは1回ずつ。
  モデルは最初の送信の後は変えない（会話の途中で変えると続きにならない）。思考量はいつでも変えられる。
- 未送信の指示はタブ・ページごとに残し、［送信］でまとめて1回の実行にする（決定ログ 2026-10-28）。
- 送信ごとに控えを取り、終了後（正常・失敗・キャンセル）に必ず検査する。どれかの実行中は発表の GUI 編集をロックする。
- 状態は `.slide-studio/chat/<deck>.json`（控えの対象外なので、戻しても会話は消えない）。
- タブには mode があり、"slides"（スライドの編集）と "memo"（左の欄の［下書き］のときの普通のチャット。設計書 §8.8）で
  タブ・会話を分ける。下書きのチャットは memo.md だけを直し、最後の返答は普通の文章で、検査をせず、スライドの編集をロックしない。
- スライドのタブの送信は「話し合い」にもできる（talk）。同じ会話のまま AI は読むだけで、控え・検査・確認役・ロックをしない。
- スライド・図・テーマのファイルが変わらなかった送信は、終わった後に検査しない（質問に答えただけなど）。
"""
from __future__ import annotations

import asyncio
import difflib
import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import check, edit_scope, materials, memo, snapshot, source
from ..fsutil import sha256_text, write_atomic
from ..workspace import StudioError, check_name, figure_title
from . import agent, bridge, live
from .context import Context
from .workflow import Workflow, final_json
from . import roles
from .login import Logins
from .providers import PROVIDERS, split_key
from . import runtimes


def supported(key) -> bool:
    """モデルの鍵（"codex:gpt-…"）が、今も対応している AI のものか。"""
    return isinstance(key, str) and split_key(key)[0] in roles.SUPPORTED_PROVIDERS


COLORS = ["#3D86F5", "#DD8A45", "#8A63D2", "#5E9E2E", "#D2558A", "#2A9D8F", "#B5852A"]
# 発表全体・図（fig:nco/x）・id のないページ（@番号）・ページの id
KEY = re.compile(r"^(deck|fig:([a-z0-9][a-z0-9-]*)/[a-z0-9][a-z0-9-]*|@\d+|[^\s/\\@][^\s/\\]{0,199})$")
STEP_LIMIT = 300
PAGE_TEXT_LIMIT = 6000
STATUS_TTL = 300.0
ACTIVE = ("run", "check", "review")
FIX_LIMIT = 3  # 検査のエラーを同じ会話で直させる回数の上限
ATTACH = re.compile(r"^(images|materials)/[^\x00]{1,400}$")
ATTACH_LIMIT = 20
RASTER = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
FAVORITES_LIMIT = 12
MODES = ("slides", "memo", "theme")
USER_QMD = "user-slides.qmd"  # 控えの中の、実行前の原稿に利用者の変更だけを当てた写し
MEMO_KEY = "memo"


def memo_diff(before: str, after: str, limit: int = 300) -> str:
    """下書きの差分（unified diff。長ければ途中までにして、残りの行数を書く）。"""
    lines = list(difflib.unified_diff(before.splitlines(), after.splitlines(), "前", "後", n=1, lineterm=""))[2:]
    if len(lines) > limit:
        lines = lines[:limit] + [f"…（ほか {len(lines) - limit} 行。memo.md を読む）"]
    return "\n".join(lines)


def error_key(x: dict) -> tuple:
    """送信の前後で同じ検査のエラーかを見分ける。ページの番号・step は送信で変わりうるので使わない。"""
    return x.get("kind"), x.get("page_id"), x.get("message")


def new_errors(view: dict | None) -> list[dict]:
    """画面用の検査の結果（check_view）のうち、送信の前には無かったエラー。"""
    return [x for x in (view or {}).get("errors", []) if not x.get("old")]


def _json(data, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})


class Chat(Context):
    def __init__(self, srv):
        self.srv, self.ws = srv, srv.ws
        self.data: dict[str, dict] = {}
        self.runs: dict[str, agent.Run] = {}  # 送信の id → AI の実行
        self.running: dict[str, tuple[str, str]] = {}  # AI が動いている送信の id → (発表, mode)
        self.tasks: set[asyncio.Task] = set()
        self.check_lock = threading.Lock()
        self.status_lock = threading.Lock()
        self.status: dict | None = None
        self.status_at = 0.0
        self.save_handles: dict[str, asyncio.TimerHandle] = {}
        self.bridge_task: asyncio.Task | None = None
        self.login = Logins()
        self.updater = runtimes.Updater(PROVIDERS.values(), lambda: bool(self.running), self.ai_status, self.invalidate_status)
        self.live = live.Pool()  # タブごとに起動したままの AI（作業手順書 A6）
        self.check_before: dict[str, set] = {}  # 送信の id → 送信の前からあった検査のエラー（直させない）

    # ------------------------------------------------------------ server.py のフック
    def __call__(self, kind, arg) -> None:
        pass

    def locked(self, deck: str) -> bool:
        """発表全体への指示の実行中は、原稿の GUI 編集をすべてロックする。"""
        return self.slide_scope(deck)["all"]

    def slides_running(self, deck: str) -> bool:
        return (deck, "slides") in self.running.values()

    def slide_scope(self, deck: str) -> dict:
        """実行中のスライドの指示がロックする範囲。全体への指示は全体、ページへの指示はそのページ、図への指示はその図。"""
        whole, pages, figures = False, {}, set()
        rounds = {r["id"]: r for r in self.state(deck)["rounds"]} if self.slides_running(deck) else {}
        for rid, (d, kind) in self.running.items():
            if d != deck or kind != "slides":
                continue
            items = rounds.get(rid, {}).get("items") or []
            whole = whole or not items
            for item in items:
                key = item["key"]
                if key == "deck":
                    whole = True
                elif key.startswith("fig:"):
                    figures.add(key[4:])
                else:
                    pages[key] = item.get("page_title")
        return {"all": whole, "pages": [{"key": k, "title": t} for k, t in pages.items()], "figures": sorted(figures)}

    def memo_locked(self, deck: str) -> bool:
        return (deck, "memo") in self.running.values()

    def theme_locked(self, name: str) -> bool:
        return any(r.get("theme") == name and r["state"] in ACTIVE
                   for data in self.data.values() for r in data["rounds"])

    def busy(self, deck: str) -> bool:
        return any(d == deck for d, _ in self.running.values())

    # ------------------------------------------------------------ 保存
    def path(self, deck: str):
        return self.ws.state / "chat" / f"{check_name(deck, '発表の名前')}.json"

    def state(self, deck: str) -> dict:
        if deck not in self.data:
            try:
                data = json.loads(self.path(deck).read_text())
            except (OSError, ValueError):
                data = {"tabs": [], "rounds": []}
            for r in data["rounds"]:
                if r["state"] in ACTIVE:
                    # 前回のアプリの終了で中断した
                    r["state"], r["error"] = "error", "アプリが終了したため中断しました"
                    for child in r.get('agents', []):
                        if child['state'] == 'run':
                            child.update(state='error', error='アプリが終了したため中断しました')
            migrated = False
            for t in data["tabs"]:
                t.setdefault("mode", "slides")
                # 旧グローバル設定は既存タブだけに一度コピー。新規タブは親に追従。
                # 確認の3つの担当の設定は、確認役に一度だけ寄せる（作業手順書 A5）。
                saved = t.get("ai_roles", self.ws.prefs().get("ai_roles", {}))
                clean = json.loads(json.dumps(roles.migrate(saved, t["mode"])))
                if "ai_roles" not in t or clean != t["ai_roles"]:
                    migrated = True
                    t["ai_roles"] = clean
                # 対応をやめた AIのモデルは、まだ送っていないタブでは使わない（送るときに既定のモデル）
                if t.get("model") and not supported(t["model"]) and not t.get("session") \
                        and not any(r["tab"] == t["id"] for r in data["rounds"]):
                    migrated = True
                    t["model"] = None
            # どのチャットにも開いたタブを必ず1つ置く（タブの無い画面は出さない）
            for mode in MODES:
                if not any(t["mode"] == mode and t.get("open", True) for t in data["tabs"]):
                    data["tabs"].append(self._new_tab(data, mode=mode))
            self.data[deck] = data
            if migrated:
                self.save(deck)
        return self.data[deck]

    def save(self, deck: str, soon: bool = False) -> None:
        """soon は途中経過の保存（1秒にまとめる）。"""
        if soon:
            if deck not in self.save_handles:
                loop = asyncio.get_running_loop()
                self.save_handles[deck] = loop.call_later(1.0, self.save, deck)
            return
        handle = self.save_handles.pop(deck, None)
        if handle:
            handle.cancel()
        write_atomic(self.path(deck), json.dumps(self.data[deck], ensure_ascii=False, indent=1))

    def _new_tab(self, data: dict, name: str | None = None, mode: str = "slides") -> dict:
        # モデルは前回選んだもの（無ければ送信のときに既定のモデル）。思考量はモデルの既定
        return {"id": "t" + uuid.uuid4().hex[:8], "name": name or "新しいタブ",
                "color": COLORS[len(data["tabs"]) % len(COLORS)], "created": time.time(), "open": True,
                "session": None, "drafts": {}, "auto_name": not name,
                "model": last if supported(last := self.ws.prefs().get("ai_last")) else None, "effort": None, "attach": [], "mode": mode, "ai_roles": {}}

    def public(self, deck: str) -> dict:
        data = self.state(deck)
        from ..figures import fig_refs
        usages = {ref: self.ws.decks_using(ref) for ref in fig_refs(self.ws.qmd(deck).read_text())}
        return {"role_modes": roles.CONFIGURABLE_MODES, "role_defaults": roles.DEFAULT_ON, "role_providers": roles.SUPPORTED_PROVIDERS, "figure_users": usages, "deck": deck, "tabs": data["tabs"], "rounds": data["rounds"], "locked": self.locked(deck),
                "lock": self.slide_scope(deck), "memo_locked": self.memo_locked(deck), "topic": self.ws.deck_shelf(deck), "ai": self.status}

    def open_view(self, deck: str) -> dict:
        data = self.state(deck)
        active = {r["tab"] for r in data["rounds"] if r["state"] in ACTIVE}
        used = {r["tab"] for r in data["rounds"]}
        # 開き直した画面は新しい会話から。空のタブは使い回し、実行中のタブは残す。
        empty = {}
        for tab in data["tabs"]:
            mode = tab.get("mode", "slides")
            reusable = (tab.get("open", True) and tab["id"] not in used and not tab.get("session")
                        and not tab.get("drafts") and not tab.get("attach") and mode not in empty)
            if reusable:
                empty[mode] = tab
            tab["open"] = reusable or tab["id"] in active
        for mode in MODES:
            if mode not in empty:
                data["tabs"].append(self._new_tab(data, mode=mode))
        self.save(deck)
        self.broadcast(deck)
        return self.public(deck)

    def broadcast(self, deck: str, round_: dict | None = None) -> None:
        if round_ is None or round_.get("mode") == "theme":
            self.srv.broadcast({"type": "theme-lock"})
        if round_ is not None:
            self.srv.broadcast({"type": "chat-round", "deck": deck, "round": round_, "locked": self.locked(deck),
                                "lock": self.slide_scope(deck), "memo_locked": self.memo_locked(deck)})
        else:
            self.srv.broadcast({"type": "chat", "deck": deck, "state": self.public(deck)})

    # ------------------------------------------------------------ AI の検出・モデル
    def ai_status(self, refresh: bool = False) -> dict:
        """入っている AI の CLI・ログイン・モデルの一覧と、既定のモデル・よく使うモデル。検出は並行して行い、5分使い回す。"""
        with self.status_lock:
            if refresh or self.status is None or time.monotonic() - self.status_at > STATUS_TTL:
                cache = self.ws.prefs().get("ai_context") or {}
                with ThreadPoolExecutor(len(PROVIDERS)) as pool:
                    found = list(pool.map(lambda p: p.detect(cache), PROVIDERS.values()))
                self.status = {"providers": found}
                self.status_at = time.monotonic()
                for p in found:
                    if limits := p.pop("limits", None):
                        self._save_limits(p["id"], limits, replace=True)
            self.status.update(self._defaults(), limits=self.ws.prefs().get("ai_limits") or {})
            return self.status

    def cached_status(self) -> dict:
        """検出済みなら、期限切れでも検出を待たずに返す。画面の操作の保存に使う。"""
        if self.status is None:
            return self.ai_status()
        return {**self.status, **self._defaults(), "limits": self.ws.prefs().get("ai_limits") or {}}

    def invalidate_status(self) -> None:
        """実行ファイルが変わったので、次の確認で検出し直す。"""
        self.status_at = float("-inf")

    def _usable(self, pid: str) -> bool:
        return any(p["id"] == pid and p["ok"] for p in self.ai_status()["providers"])

    def runtime_list(self, refresh: bool = False) -> list[dict]:
        """動作環境の画面の AI の行。refresh で配布元に最新版を聞き直す。"""
        def check(provider):
            if not provider.overridden():
                try:
                    provider.runtime.check()
                except StudioError:
                    pass  # 理由は画面に出る
        if refresh:
            with ThreadPoolExecutor(len(PROVIDERS)) as pool:
                list(pool.map(check, PROVIDERS.values()))
        return [runtimes.info(p) for p in PROVIDERS.values()]

    def _update_now(self, provider) -> None:
        was_ok = self._usable(provider.id)
        try:
            if provider.runtime.update(lambda exe: provider.accepts(exe, was_ok), force=True):
                self.invalidate_status()
        except StudioError:
            pass  # 理由は state.json に残り、画面に出る
        finally:
            provider.runtime.updating = False

    def runtime_action(self, provider, body: dict) -> dict:
        if provider.overridden():
            raise StudioError(f"{provider.name} は実行ファイルを指定して使っています。")
        runtime = provider.runtime
        if "auto" in body:
            runtime.set_auto(bool(body["auto"]))
        elif body.get("action") in ("update", "rollback"):
            if self.running:
                raise StudioError("AI の作業中は変更できません。")
            if body["action"] == "rollback":
                runtime.rollback()
                self.invalidate_status()
            elif not runtime.busy():
                runtime.updating = True
                threading.Thread(target=self._update_now, args=(provider,), daemon=True).start()
        else:
            raise StudioError("操作を確かめてください。")
        return runtimes.info(provider)

    def _defaults(self) -> dict:
        found = (self.status or {}).get("providers") or []
        ok = [p for p in found if p["ok"] and p["default"]]
        # 既定は Codex の既定のモデル。Codex が使えなければ、使える最初の AI
        first = next((p for p in ok if p["id"] == "codex"), ok[0] if ok else None)
        default = f"{first['id']}:{first['default']}" if first else None
        favorites = self.ws.prefs().get("ai_favorites")
        if not isinstance(favorites, list):
            favorites = [default] if default else []
        favorites = [k for k in favorites if supported(k)]
        return {"default": default, "favorites": favorites, "favorites_limit": FAVORITES_LIMIT}

    def provider_of(self, key: str | None) -> tuple[dict | None, dict | None]:
        """モデルの鍵から（検出した AI, モデル）。見つからなければ None。"""
        pid, mid = split_key(key or "")
        p = next((x for x in (self.status or {}).get("providers") or [] if x["id"] == pid), None)
        m = next((x for x in (p or {}).get("models") or [] if x["id"] == mid), None)
        return p, m

    def set_favorites(self, favorites: list) -> dict:
        if not isinstance(favorites, list) or not all(isinstance(k, str) and k.count(":") >= 1 and len(k) < 200 for k in favorites):
            raise StudioError("よく使うモデルの形が正しくありません")
        favorites = list(dict.fromkeys(favorites))
        if len(favorites) > FAVORITES_LIMIT:
            raise StudioError(f'表示するモデルは {FAVORITES_LIMIT} 件までです')
        self.ws.set_prefs(ai_favorites=favorites)
        return self.cached_status()

    def _use_model(self, key: str) -> None:
        """選んだモデルを次のタブの既定にする。表示リストは追加画面だけで変更。"""
        self.ws.set_prefs(ai_last=key)

    # ------------------------------------------------------------ 操作
    def tab(self, deck: str, tab_id: str) -> dict:
        tab = next((t for t in self.state(deck)["tabs"] if t["id"] == tab_id), None)
        if tab is None:
            raise StudioError("タブがありません")
        return tab

    def round(self, deck: str, round_id: str) -> dict:
        r = next((r for r in self.state(deck)["rounds"] if r["id"] == round_id), None)
        if r is None:
            raise StudioError("送信が見つかりません")
        return r

    def add_tab(self, deck: str, mode: str = "slides") -> dict:
        if mode not in MODES:
            raise StudioError("チャットの種類が正しくありません")
        data = self.state(deck)
        tab = self._new_tab(data, mode=mode)
        data["tabs"].append(tab)
        self.save(deck)
        self.broadcast(deck)
        return tab

    def update_tab(self, deck: str, tab_id: str, body: dict) -> dict:
        saved_tab = self.tab(deck, tab_id)
        # 検証で断った変更は、会話・書きかけ・次のタブの既定に一部も残さない。
        tab = json.loads(json.dumps(saved_tab))
        model_changed = False
        if body.get("open") is False and any(
                r["tab"] == tab_id and r["state"] in ACTIVE for r in self.state(deck)["rounds"]):
            raise StudioError("作業中のタブは閉じられません")
        new_roles = None
        if set(body) & {"model", "effort", "ai_roles"} and any(
                r["tab"] == tab_id and r["state"] in ACTIVE for r in self.state(deck)["rounds"]):
            raise StudioError("このタブは作業中です。止めてからモデルを変更してください")
        if "ai_roles" in body:
            if any(r["tab"] == tab_id and r["state"] in ACTIVE for r in self.state(deck)["rounds"]):
                raise StudioError('このタブは作業中です。終わってから担当を変更してください')
            new_roles = roles.tab_settings(tab.get('mode', 'slides'), tab.get('ai_roles', {}), body['ai_roles'], self.provider_of)
        if "drafts" in body:
            drafts = body["drafts"]
            if not isinstance(drafts, dict):
                raise StudioError("未送信の指示の形が正しくありません")
            clean_drafts = {}
            for key, value in drafts.items():
                if not isinstance(key, str) or not KEY.fullmatch(key):
                    raise StudioError("未送信の指示の形が正しくありません")
                if isinstance(value, dict) and key.startswith("@") and isinstance(value.get("text"), str) and isinstance(value.get("page_title"), str):
                    value = {"text": value["text"], "page_title": value["page_title"]}
                    text = value["text"]
                elif isinstance(value, str):
                    text = value
                else:
                    raise StudioError("未送信の指示の形が正しくありません")
                if text.strip():
                    clean_drafts[key] = value
            tab["drafts"] = clean_drafts
            if tab.get("auto_name"):
                first = next(iter(clean_drafts.values()), "")
                text = first.get("text", "") if isinstance(first, dict) else first
                tab["name"] = text.strip().splitlines()[0][:40] if text.strip() else "新しいタブ"
        if isinstance(body.get("open"), bool):
            if not body["open"] and tab.get("open", True) and not any(
                    t is not saved_tab and t.get("open", True) and t.get("mode", "slides") == tab.get("mode", "slides")
                    for t in self.state(deck)["tabs"]):
                raise StudioError("最後のタブは閉じられません")
            tab["open"] = body["open"]
        if isinstance(body.get("name"), str) and body["name"].strip():
            tab["name"], tab["auto_name"] = body["name"].strip()[:40], False
        if "model" in body and body["model"] != tab.get("model"):
            if not self.provider_of(body["model"])[1]:
                raise StudioError("そのモデルは使えません")
            if self._started(deck, tab_id):
                tab["model_change"] = {"from": tab.get("model"), "to": body["model"]}
                for key in ("session", "role_binding"):
                    tab.pop(key, None)
                # 担当の AI を決めていない（チャットに追従する）サブエージェントの会話も新しくする
                for role in roles.CONFIGURABLE_MODES.get(tab.get("mode", "slides"), ()):
                    if not (tab.get("ai_roles", {}).get(role) or {}).get("model"):
                        for key in (f"{role}_session", f"{role}_binding"):
                            tab.pop(key, None)
            tab["model"], tab["effort"] = body["model"], None
            model_changed = True
        if "effort" in body:
            _, m = self.provider_of(tab.get("model") or self._defaults()["default"])
            if body["effort"] is not None and (not m or body["effort"] not in m["efforts"]):
                raise StudioError("その思考量は選べません")
            tab["effort"] = body["effort"]
        if new_roles is not None:
            for role in set(new_roles) | set(tab.get("ai_roles", {})):
                if new_roles.get(role) != tab.get("ai_roles", {}).get(role):
                    for key in (f"{role}_session", f"{role}_binding"):
                        tab.pop(key, None)
            tab["ai_roles"] = new_roles
        if "attach" in body:
            tab["attach"] = self._attachments(deck, body["attach"])
        if model_changed:
            self._use_model(tab["model"])
        # 実行中の担当も同じ dict を参照しているので、検証後に元のオブジェクトへ反映する。
        saved_tab.clear()
        saved_tab.update(tab)
        tab = saved_tab
        self.save(deck)
        # 書きかけの指示・添付は送った画面がすでに持っている。他の変更だけ知らせる。
        if set(body) - {"drafts", "attach"}:
            self.broadcast(deck)
        return tab

    def _legacy_model(self, tab: dict) -> str | None:
        """モデルを選べるようになる前のタブ（Codex の会話だけを持つ）は Codex の既定のモデルで続ける。"""
        if not tab.get("session"):
            return None
        p = next((x for x in self.ai_status()["providers"] if x["id"] == "codex"), None)
        return f"codex:{p['default']}" if p and p.get("default") else None

    def _started(self, deck: str, tab_id: str) -> bool:
        tab = self.tab(deck, tab_id)
        return bool(tab.get("session")) or any(r["tab"] == tab_id for r in self.state(deck)["rounds"])

    def _attachments(self, deck: str, items) -> list[dict]:
        """添付は発表のフォルダの images/ か materials/ に置いたファイル（画面が先に置く）。"""
        folder = self.ws.deck_dir(deck).resolve()
        out = []
        for it in items if isinstance(items, list) else []:
            path = str((it or {}).get("path") or "") if isinstance(it, dict) else ""
            if not ATTACH.match(path) or ".." in Path(path).parts:
                raise StudioError(f"添付の場所が正しくありません: {path}")
            folder = (self.ws.asset_root(deck) if path.startswith("images/") else self.ws.deck_dir(deck)).resolve()
            f = (folder / path).resolve()
            if not f.is_relative_to(folder) or not f.is_file():
                raise StudioError(f"添付が見つかりません: {path}")
            kind = "image" if path.startswith("images/") else "file"
            out.append({"path": path, "name": f.name, "kind": kind})
        return out[:ATTACH_LIMIT]

    def send(self, deck: str, tab_id: str, base: str, items: list, attach=None, *, continuation=None, talk=False) -> dict:
        tab = self.tab(deck, tab_id)
        mkey = tab.get("model") or self._legacy_model(tab) or self.ai_status()["default"]
        roles.require_provider(mkey)
        p, m = self.provider_of(mkey)
        if not p or not p["ok"]:
            name = p["name"] if p else (split_key(mkey)[0] or "AI")
            raise StudioError(f"{name} が使えません。" + ((p or {}).get("message") or ""))
        if not m:
            raise StudioError(f"モデル {split_key(mkey)[1]} が {p['name']} の一覧にありません")
        effort = tab.get("effort") if tab.get("effort") in m["efforts"] else m["effort"]
        files = self._attachments(deck, attach if attach is not None else tab.get("attach"))
        data = self.state(deck)
        if any(r["tab"] == tab_id and r["state"] in ACTIVE for r in data["rounds"]):
            raise StudioError("このタブは作業中です。終わってから送信してください")
        mode = tab.get("mode", "slides")
        talk = talk is True and mode == "slides"
        clean = []
        doc = rendered = None
        for it in items if isinstance(items, list) else []:
            if not isinstance(it, dict):
                continue
            key, text = it.get("key"), str(it.get("text") or "").strip()
            if not isinstance(key, str) or not KEY.fullmatch(key) or not text:
                continue
            item = {"key": key, "label": str(it.get("label") or key)[:80], "text": text}
            if mode == "slides":
                if doc is None:
                    qmd = self.ws.qmd(deck).read_text()
                    doc, rendered = source.parse(qmd), self._rendered(deck, qmd)
                if key.startswith("@"):
                    item["page_title"] = it.get("page_title")
                if key.startswith("fig:") and it.get("step") is not None:
                    item["step"] = it["step"]
                item = self._target_item(deck, doc, rendered, item)
            clean.append(item)
        if not clean:
            raise StudioError("送信する指示がありません")
        self.ws.require_deck(deck)
        if mode == "memo":
            # 下書きのチャットは対象を選ばない。1回に1つの依頼
            if len(clean) != 1 or clean[0]["key"] != MEMO_KEY:
                raise StudioError("下書きのチャットの依頼の形が正しくありません")
            if base != memo.read(self.ws, deck)["version"]:
                raise ConflictError("下書きが変わっています。保存が終わってから送信してください")
        elif mode == "theme":
            if len(clean) != 1 or clean[0]["key"] != "theme":
                raise StudioError("テーマのチャットの依頼の形が正しくありません")
            theme = check_name(self.ws.deck_theme(deck), "テーマ")
            if base != sha256_text((self.ws.themes / f"{theme}.css").read_text()):
                raise ConflictError("テーマが変わっています。保存が終わってから送信してください")
        elif base != sha256_text(self.ws.qmd(deck).read_text()):
            raise ConflictError("原稿が変わっています。保存が終わってから送信してください")
        previous = next((x for x in reversed(data["rounds"]) if x["tab"] == tab_id), None)
        pending = (previous if not continuation and previous and previous["state"] == "cancelled"
                   and not previous.get("restored") and bool(previous.get("talk")) == talk else None)
        if pending:
            # 中断を繰り返しても、前回までの対象と依頼をまとめて引き継ぐ。
            prior = json.loads(json.dumps(pending["items"]))
            if mode in ("memo", "theme"):
                clean[0]["text"] = prior[0]["text"] + "\n\n" + clean[0]["text"]
            else:
                clean = prior + clean
            files = list({a["path"]: a for a in [*pending.get("attach", []), *files]}.values())
        chosen_roles = {role: roles.resolve(role, {'model': mkey, 'effort': effort}, tab.get('ai_roles', {}), self.provider_of)
                        for role in roles.CONFIGURABLE_MODES[mode]}
        r = {"ai_roles": chosen_roles, "id": "r" + uuid.uuid4().hex[:10], "tab": tab_id, "mode": mode, "time": time.time(), "items": clean,
             "model": mkey, "model_name": m["name"], "effort": effort, "attach": files, "context": None,
             "state": "run", "steps": [], "summary": "", "results": [], "files": None, "check": None,
             "snapshot": None, "restored": None, "error": None, "cancel": False}
        if talk:
            r["talk"] = True
        if mode == "theme":
            r["theme"] = theme
        # 同じ時間に動いた送信（戻すときに、どちらの変更か区別できないファイルを知らせる）と、実行中に利用者が直したファイル
        r["overlap"], r["user_edits"] = [], []
        for rid, (d, kind) in self.running.items():
            if talk or kind == "talk":
                continue  # 話し合いはファイルを変えない
            self.round(d, rid).setdefault("overlap", []).append({"deck": deck, "round": r["id"]})
            r["overlap"].append({"deck": d, "round": rid})
        if continuation:
            r["continued_from"] = continuation["id"]
            r["review_only"] = self.review_interrupted(continuation)
        if tab.get("model_change"):
            r["model_change"] = tab.pop("model_change")
            r["handover"] = self.conversation_handover(deck, tab_id)
        if continuation:
            r["handover"] = self.conversation_handover(deck, tab_id, continuation)
        if pending:
            r["resumed_from"] = pending["id"]
            r["handover"] = self.conversation_handover(deck, tab_id, pending) + "\n追加の指示が以前の指示を訂正している場合は、追加の指示を優先する。"
        data["rounds"].append(r)
        if not continuation:
            tab["drafts"], tab["attach"] = {}, []
        tab["model"] = mkey
        if not tab.get("session") and m.get("context"):
            r["context"] = {"used": 0, "window": m["context"]}
        if tab.get("auto_name") and not any(x["tab"] == tab_id for x in data["rounds"][:-1]):
            first = clean[0]["text"].splitlines()[0]
            tab["name"] = first[:40]
            tab["auto_name"] = False
        # 話し合いはファイルを変えないので、スライドの編集をロックしない
        self.running[r["id"]] = (deck, "talk" if talk else mode)
        self.save(deck)
        self.broadcast(deck)
        task = asyncio.create_task(self._run(deck, tab, r))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return r

    @staticmethod
    def review_interrupted(r):
        return bool(r.get("agents") and r["agents"][-1].get("role") == "review"
                    and r["agents"][-1].get("state") in ("error", "cancelled"))

    def continue_round(self, deck, rid, base):
        old = self.round(deck, rid)
        if old.get("restored") or (old["state"] not in ("error", "cancelled") and not self.review_interrupted(old)):
            raise StudioError("この送信は続行できません")
        latest = next(r for r in reversed(self.state(deck)["rounds"]) if r["tab"] == old["tab"])
        if latest["id"] != rid:
            raise StudioError("この後の送信があります。最後の送信から続けてください")
        items = json.loads(json.dumps(old["items"]))
        for item in items:
            if isinstance(item.get("step"), dict):
                item["step"] = item["step"]["index"]
        result = self.send(deck, old["tab"], base, items, old.get("attach"), continuation=old, talk=old.get("talk", False))
        if result["review_only"]:
            tab = self.tab(deck, old["tab"])
            tab.pop("review_session", None)
            tab.pop("review_binding", None)
            self.save(deck)
        return result

    async def cancel(self, deck: str, round_id: str) -> None:
        r = self.round(deck, round_id)
        if r["state"] not in ACTIVE:
            raise StudioError("この送信は作業中ではありません")
        r["cancel"] = True
        run = self.runs.get(round_id)
        if run:
            await run.cancel()

    def user_saved_qmd(self, deck: str, before: str, after: str) -> None:
        """実行中に利用者が直した原稿の差分を、控えの写しにも当てる。［戻す］は AI の変更だけを消して、この写しにする。"""
        rel = f"decks/{deck}/slides.qmd"
        for rid, (d, kind) in list(self.running.items()):
            r = self.round(d, rid) if d == deck and kind == "slides" else None
            if not r or not r.get("snapshot"):
                continue
            snap = snapshot.find(self.ws, deck, r["snapshot"])
            shadow = snap.path / USER_QMD
            base = shadow if shadow.is_file() else snap.path / "files" / rel
            merged = edit_scope.merge3(before, after, base.read_text())
            if merged is None:
                self.user_wrote(deck, rel)
            else:
                write_atomic(shadow, merged)

    def user_wrote(self, deck: str, name: str) -> None:
        """server.py のフック：利用者が画面でファイルを保存した。実行中の送信の［戻す］では、それを戻さない。

        スライドの送信の間も下書きは編集できる（§8.8）ので、戻すと推敲した下書きが消えないようにする。
        """
        for rid, (d, _) in self.running.items():
            if d == deck:
                edits = self.round(d, rid).setdefault("user_edits", [])
                if name not in edits:
                    edits.append(name)
                    self.save(d, soon=True)

    def _restorable(self, deck: str, round_id: str) -> tuple[dict, snapshot.Snapshot, set[str] | None]:
        r = self.round(deck, round_id)
        if r["state"] in ACTIVE:
            raise StudioError("作業が終わってから戻してください")
        if self.busy(deck):
            raise StudioError("他のタブで AI が作業中です。終わってから戻してください")
        if not r.get("snapshot"):
            raise StudioError("この送信の控えがありません")
        if r.get("restored"):
            raise StudioError("すでに戻しました")
        snap = snapshot.find(self.ws, deck, r["snapshot"])
        if r.get("theme") and self.theme_locked(r["theme"]):
            raise StudioError("このテーマは AI が作業中です")
        only = {f"themes/{r['theme']}.css"} if r.get("mode") == "theme" else {memo.rel(deck)} if r.get("mode") == "memo" else None
        return r, snap, only

    def _shared(self, deck: str, r: dict, names: list[str]) -> dict:
        """同じ時間に動いた送信があれば、その間に変わったファイル（実行の前後の差では、どちらの変更か区別できない）。"""
        tabs, shared = [], set()
        for o in r.get("overlap") or []:
            data = self.state(o["deck"])
            other = next((x for x in data["rounds"] if x["id"] == o["round"]), None)
            if not other:
                continue
            tab = next((t["name"] for t in data["tabs"] if t["id"] == other["tab"]), "")
            tabs.append(tab if o["deck"] == deck else f"{o['deck']} · {tab}")
            if other["state"] in ACTIVE or other.get("files") is None:
                shared |= set(names)  # まだ終わっていないので分からない
                continue
            f = other["files"]
            shared |= {n for k in ("added", "modified", "deleted", "outside") for n in f.get(k, [])} | set(other.get("stray") or [])
        files = [n for n in names if n in shared]
        return {"files": files, "tabs": tabs if files else []}

    async def restore_preview(self, deck: str, round_id: str) -> dict:
        """［この送信の前に戻す］の確認に出すもの。ファイルは変えない（設計書 §8.4）。"""
        r, snap, only = self._restorable(deck, round_id)
        plan = await anyio.to_thread.run_sync(snapshot.restore_plan, self.ws, snap, only, set(r.get("user_edits") or []))
        names = plan["added"] + plan["modified"] + plan["deleted"]
        return {"files": names, "later": plan["later"], "kept": plan["kept"], "shared": self._shared(deck, r, names)}

    async def restore(self, deck: str, round_id: str) -> dict:
        r, snap, only = self._restorable(deck, round_id)
        result = await anyio.to_thread.run_sync(snapshot.restore_run, self.ws, snap, only, set(r.get("user_edits") or []))
        shadow = snap.path / USER_QMD
        if only is None and shadow.is_file() and f"decks/{deck}/slides.qmd" in result["modified"]:
            write_atomic(self.ws.qmd(deck), shadow.read_text())
        r["restored"] = {"at": time.time(), "files": result["added"] + result["modified"] + result["deleted"],
                         "later": result["later"], "kept": result["kept"], "outside": result["outside"]}
        self.save(deck)
        self.broadcast(deck, r)
        return r

    # ------------------------------------------------------------ 実行
    def _step(self, deck: str, r: dict, step: dict) -> None:
        steps = r["steps"]
        # 同じコマンドの開始と終了は1行にする（コマンドは並行して動くことがある）
        same = next((i for i in range(len(steps) - 1, max(-1, len(steps) - 30), -1)
                     if step.get("id") is not None and steps[i].get("id") == step["id"]), None)
        if same is None:
            steps.append(step)
        else:
            steps[same] = step
        del steps[:-STEP_LIMIT]
        self.save(deck, soon=True)
        self.broadcast(deck, r)

    def _usage(self, deck: str, r: dict, usage: dict) -> None:
        """コンテキストの使用量。上限はイベントに無ければモデルの一覧の値を使う。"""
        cur = r.get("context") or {}
        used = usage["used"] if usage.get("used") is not None else cur.get("used")
        window = usage.get("window") or cur.get("window")
        if window is None:
            window = (self.provider_of(r["model"])[1] or {}).get("context")
        r["context"] = {"used": used or 0, "window": window}
        if usage.get("window") and usage.get("model") is not None:
            # Claude Code は上限を実行の後にしか言わないので、次のタブのために覚えておく
            pid, mid = split_key(r["model"])
            cache = self.ws.prefs().get("ai_context") or {}
            if cache.get(pid, {}).get(mid) != usage["window"]:
                cache.setdefault(pid, {})[mid] = usage["window"]
                self.ws.set_prefs(ai_context=cache)
                _, m = self.provider_of(r["model"])
                if m:
                    m["context"] = usage["window"]
        self.save(deck, soon=True)
        self.broadcast(deck, r)

    def _save_limits(self, pid: str, limits: dict, replace: bool = False) -> dict:
        """利用上限の使用率はアカウントごと。実行中の知らせは一部だけのこともあるので重ね（replace は全体を読んだとき）、
        次に起動したときのために覚えておく。"""
        saved = self.ws.prefs().get("ai_limits") or {}
        saved[pid] = {**({} if replace else saved.get(pid) or {}), **limits, "at": int(time.time())}
        self.ws.set_prefs(ai_limits=saved)
        return saved

    def _limits(self, pid: str, limits: dict) -> None:
        saved = self._save_limits(pid, limits)
        if self.status is not None:
            self.status["limits"] = saved
        self.srv.broadcast({"type": "ai-limits", "limits": saved})

    async def _run(self, deck: str, tab: dict, r: dict) -> None:
        run: agent.Run | None = None
        snap = None
        provider = PROVIDERS[split_key(r["model"])[0]]
        is_memo = r.get("mode") == "memo"
        is_theme = r.get("mode") == "theme"
        is_talk = r.get("talk", False)
        try:
            if not is_talk:
                snap = await anyio.to_thread.run_sync(snapshot.take, self.ws, deck)
                r["snapshot"] = snap.path.name
            if not is_memo and not is_talk and not r["cancel"]:
                old = self.round(deck, r["continued_from"]) if r.get("continued_from") else {}
                prior = old.get("errors_before")
                self.check_before[r["id"]] = ({tuple(x) for x in prior} if prior is not None else
                                              await anyio.to_thread.run_sync(self._errors_before, deck, r))
                r["errors_before"] = list(self.check_before[r["id"]])
            if not r["cancel"]:
                prompt = (self.prompt_memo(deck, r["items"][0]["text"], r.get("attach") or []) if is_memo
                          else self.prompt_theme(deck, r["items"][0]["text"], r.get("attach") or [], r["theme"]) if is_theme
                          else self.prompt(deck, r["items"], r.get("attach") or [], talk=is_talk))
                folder = self.ws.deck_dir(deck)
                images = [self.ws.asset_root(deck) / a["path"] for a in r.get("attach") or []
                          if a["kind"] == "image" and Path(a["path"]).suffix.lower() in RASTER] if provider.images_flag else []
                run = Workflow(self, deck, tab, r)
                self.runs[r["id"]] = run
                if r["cancel"]:
                    run.cancelled = True
                else:
                    if r.get("handover"):
                        prompt = r["handover"] + "\n\n" + prompt
                    if not r.get("review_only"):
                        await run.run(prompt, images)
                    else:
                        old = self.round(deck, r["continued_from"])
                        r["summary"] = "中断した確認を再開しました。"
                        if old.get("handoff"):
                            r["handoff"] = {k: old["handoff"][k] for k in ("text", "rebuild")}
                        r["results"] = json.loads(json.dumps(old.get("results", [])))
                        r["questions"] = json.loads(json.dumps(old.get("questions", [])))
        except Exception as e:  # noqa: BLE001  チャットに出して、検査と戻すは続ける
            r["error"] = str(e)
        result = None
        try:
            if snap:
                await self._files(deck, r, snap)
            if run and not r.get("review_only"):
                if run.session:
                    ctx = await anyio.to_thread.run_sync(provider.context, run.session)
                    if ctx:
                        self._usage(deck, r, ctx)
                final = None if is_memo or is_theme or is_talk else agent.parse_final(run.final)
                if final:
                    self._slide_reply(r, final)
                elif is_memo and (reply := self._draft_final(run.final)):
                    self._plain_reply(r, run.final, reply["reply"], reply)
                    if reply["slides"].strip():
                        r["handoff"] = {"text": reply["slides"].strip(), "rebuild": reply["rebuild"]}
                elif not is_memo and (reply := self._summary_final(run.final)):
                    self._plain_reply(r, run.final, reply["summary"], reply)
                else:
                    r["summary"] = run.final if isinstance(run.final, str) else json.dumps(run.final, ensure_ascii=False)
                if run.returncode and not run.cancelled and not r["error"]:
                    tail = run.stderr.strip().splitlines()
                    r["error"] = run.errors[-1] if run.errors else tail[-1] if tail else f"{provider.name} が失敗しました"
            # 確認の再開時は編集担当を動かさないため、今回の差分がなくても現在のファイルを検査する。
            if not is_memo and not is_talk and (r.get("review_only") or self._changed_checked(deck, r)):
                result = await self._check(deck, r)
        except Exception as e:  # noqa: BLE001
            r["error"] = r["error"] or str(e)
        try:
            if run and result and not r["error"] and not r.get("review_only"):
                result = await self._check_fixes(deck, r, run, snap, result)
        except Exception as e:  # noqa: BLE001
            if not (r["cancel"] or run.cancelled):
                r["error"] = r["error"] or str(e)
        try:
            if run and not r['error'] and not r['cancel'] and not is_talk:
                await self._review_fixes(deck, tab, r, run, snap, result)
        except Exception as exc:
            if not (r["cancel"] or run.cancelled):
                r['error'] = r['error'] or str(exc)
        finally:
            if snap:
                try:
                    r['review_changes'] = await anyio.to_thread.run_sync(snapshot.changes_since_finish, self.ws, snap)
                except Exception as exc:
                    r['error'] = r['error'] or str(exc)
            self.runs.pop(r['id'], None)
            self.running.pop(r['id'], None)
            self.check_before.pop(r['id'], None)
        cancelled = r["cancel"] or (run is not None and run.cancelled)
        if cancelled:
            r["state"] = "cancelled"
            r["error"] = None
        elif r["error"]:
            r["state"] = "error"
        else:
            r["state"] = "fail" if new_errors(r["check"]) or r.get("review_ok") is False else "done"
        self._finish_report(r)
        if r.get("handoff") and r["state"] not in ("cancelled", "error"):
            # スライドの保存待ちを画面が確定してから始める（POST …/handoff）。必ず作成ボタンが押されるまで始めない
            r["handoff"]["blocked" if r.get("review_ok") is False else "pending"] = True
        self.save(deck)
        self.broadcast(deck, r)
        self.broadcast(deck)

    def _changed_checked(self, deck: str, r: dict) -> bool:
        """検査の対象（下書き以外）のファイルが送信で変わったか。テーマは CSS、スライドは memo.md 以外の何か。"""
        changed = {n for k in ("added", "modified", "deleted") for n in (r.get("files") or {}).get(k, [])}
        return bool(changed - {memo.rel(deck)})

    async def _files(self, deck: str, r: dict, snap) -> None:
        """実行の前後の変わったファイル。直しの後にも取り直す（戻すのは、直しを含めた送信全体の変更）。"""
        is_memo, is_theme = r.get("mode") == "memo", r.get("mode") == "theme"
        r["files"] = await anyio.to_thread.run_sync(snapshot.finish, self.ws, snap)
        if is_memo or is_theme:
            # 並行して編集できるため、対象以外の変更は警告に分け、復元対象に含めない。
            f, mine = r["files"] or {}, f"themes/{r['theme']}.css" if is_theme else memo.rel(deck)
            r["stray"] = [n for k in ("added", "modified", "deleted", "outside") for n in f.get(k, []) if n != mine]
            r["files"] = {k: [n for n in f.get(k, []) if n == mine] for k in ("added", "modified", "deleted", "outside")}
            if is_memo and any(r["files"][k] for k in ("added", "modified", "deleted")):
                before = snap.path / "files" / mine
                after = self.ws.root / mine
                r["memo_diff"] = memo_diff(before.read_text() if before.is_file() else "",
                                           after.read_text() if after.is_file() else "")

    @staticmethod
    def _slide_reply(r: dict, final: dict) -> None:
        r["summary"] = final["summary"]
        by_item = {x.get("item"): x for x in final["results"] if isinstance(x, dict)}
        r["results"] = [{"key": it["key"], "label": it["label"], "ok": bool(by_item.get(i, {}).get("ok")),
                         "text": str(by_item[i].get("text") or "") if i in by_item else "最終結果が返されていないため、達成を確認できません。"}
                        for i, it in enumerate(r["items"], 1)]
        r["questions"] = roles.clean_questions(final.get("questions"), len(r["items"]))

    @staticmethod
    def _plain_reply(r: dict, raw, summary: str, data: dict) -> None:
        """下書き・テーマ・話し合いの返事を記録する。途中経過に JSON のままの返事を残さない。"""
        r["summary"] = summary
        r["questions"] = roles.clean_questions(data.get("questions"), len(r["items"]))
        r["steps"] = [x for x in r["steps"] if not (x.get("kind") == "message" and x.get("text") == raw)]

    @staticmethod
    def _finish_report(r: dict) -> None:
        """最終の機械検査と、自動修正を止めた理由を結果に添える。AI は再実行しない。"""
        if not (r.get("fixes") or r.get("review_fixes")):
            return
        notes = []
        if r.get("fix_stop"):
            notes.append(r["fix_stop"])
        if r.get("check") is not None:
            c = r["check"]
            notes.append(f"最終の機械検査：エラー {len(c['errors'])} 件・警告 {len(c['warnings'])} 件。")
        if r.get("review_ok") is False:
            notes.append("確認は未解決です。確認役の指摘を参照してください。")
        if notes:
            r["summary"] = (r.get("summary", "").rstrip() + "\n\n" + "\n".join(notes)).strip()

    async def _fix(self, deck: str, r: dict, run: Workflow, snap, text: str) -> str:
        """編集担当の同じ会話に直しの依頼を1回送り、変わったファイルを取り直す。返すのは担当の返事の要約。

        検査のエラーの直し（A4）と確認の指摘の直し（A5）の両方から呼ぶ。中断・失敗は例外になる。
        """
        mode = r.get("mode", "slides")
        if mode == "slides":
            # 上限・中断で直しの返事が来なくても、直す前の成功を最終結果として残さない。
            self._slide_reply(r, {"summary": "修正後の最終結果はまだ取得できていません。", "results": []})
        try:
            if not run.parent and r.get("handover"):
                text = r["handover"] + "\n\n" + text
            await run.execute(roles.MODES[mode], text, parent=True)
        except Exception:
            # 失敗するまでに一部を書き換えている場合も、現在のファイルと検査結果を残す。
            if snap:
                await self._files(deck, r, snap)
            if mode != "memo":
                r["check"] = None
                await self._check(deck, r)
            raise
        if snap:
            await self._files(deck, r, snap)
        if mode == "slides":
            # 直しの返事は元の全指示についての最新の結果。初回の成功表示を残さない。
            self._slide_reply(r, agent.parse_final(run.final) or {"summary": "最終結果を取得できませんでした。", "results": []})
        elif mode == "memo":
            reply = self._draft_final(run.final)
            if reply:
                self._plain_reply(r, run.final, reply["reply"], reply)
        elif reply := self._summary_final(run.final):
            self._plain_reply(r, run.final, reply["summary"], reply)
        else:
            r["summary"] = run.final if isinstance(run.final, str) else json.dumps(run.final, ensure_ascii=False)
        summary = ((agent.parse_final(run.final) or {}).get("summary", run.final) if mode == "slides"
                   else (self._draft_final(run.final) or {}).get("reply", run.final) if mode == "memo"
                   else (self._summary_final(run.final) or {}).get("summary", run.final))
        return summary if isinstance(summary, str) else json.dumps(summary, ensure_ascii=False)

    async def _review_fixes(self, deck: str, tab: dict, r: dict, run: Workflow, snap, result: dict | None) -> None:
        """確認役を呼び、指摘があれば編集担当の同じ会話で直させて、検査 → 確認をもう一度（設計書 §8.1.2）。

        直すのは最大 FIX_LIMIT 回。直しきれない・直しで何も変わらなければ、最後の確認の指摘をそのまま結果に出す（review_ok が False）。
        """
        async def prompt(again):
            mode = r.get("mode", "slides")
            review_files = r["files"]
            image_snap = snap
            if r.get("review_only"):
                origin = self.round(deck, r["continued_from"])
                while origin.get("review_only") and origin.get("continued_from"):
                    origin = self.round(deck, origin["continued_from"])
                old_files = origin.get("files") or {}
                if origin.get("snapshot"):
                    image_snap = snapshot.find(self.ws, deck, origin["snapshot"])
                review_files = {k: sorted(set(review_files.get(k, []) + old_files.get(k, [])))
                                for k in ("modified", "added", "deleted", "outside")}
            changed = {n for k in ("modified", "added", "deleted") for n in review_files.get(k, [])}
            images = (await anyio.to_thread.run_sync(self.theme_review_images, r["theme"]) if mode == "theme"
                      else [] if mode == "memo" or not snap
                      else await anyio.to_thread.run_sync(self._changed_shots, deck, image_snap, changed))
            return self.prompt_review(deck, r, review_files, images, again)

        seen = set()
        checks_before_fix = 0
        while True:
            r["state"] = "review"
            self.save(deck)
            self.broadcast(deck, r)
            record = await run.review(r["files"], prompt)
            if record is not None:
                r["final_review"] = record["id"]
            if record is not None and record["id"] in seen:
                # 検査で戻された場合や A→B→A の循環も、同じ版の確認結果を使って止める。
                r["review_ok"] = False
                r["fix_stop"] = ("確認役の修正と機械検査の修正が同じ状態に戻るため、自動修正を停止しました。"
                                 if len(r.get("fixes", [])) > checks_before_fix else
                                 "修正しても確認済みの同じ状態に戻るため、自動修正を停止しました。")
                return
            if record is not None:
                seen.add(record["id"])
            if record is None:
                # 確認しなかった（何も変わっていない）か、検査のエラーで飛ばした
                if any(a["role"] == "review" and a["state"] == "skipped" for a in r["agents"]):
                    r["review_ok"] = False
                return
            r["review_ok"] = record["state"] == "complete"
            if record["state"] != "needs_fix" or r["cancel"] or len(r.setdefault("review_fixes", [])) >= FIX_LIMIT:
                return
            # 利用者の判断が必要な指摘は自動修正しない。混在時は直せる分だけ先に直す。
            fixable = [i for i in record["issues"] if not i["message"].startswith("【要判断】")]
            if not fixable:
                return
            fix = {"issues": len(fixable), "limit": FIX_LIMIT, "summary": ""}
            r["review_fixes"].append(fix)
            r["state"], r["fixing"] = "run", "review"  # 画面で検査の直しと分ける
            self.save(deck)
            self.broadcast(deck, r)
            checks_before_fix = len(r.get("fixes", []))
            try:
                fix["summary"] = await self._fix(deck, r, run, snap, self.prompt_review_fix(deck, r, fixable, len(r["review_fixes"]), FIX_LIMIT))
            finally:
                r.pop("fixing", None)
            if r.get("mode") != "memo":
                result = await self._check_fixes(deck, r, run, snap, await self._check(deck, r))

    def theme_review_images(self, theme: str) -> list[str]:
        """テーマの確認役に見せる見本の画像。今の CSS で撮ったものが無ければ撮る（Chromium が無ければ渡さない）。"""
        from .. import theme_shots
        worker = getattr(self.srv, 'browser_worker', None)
        if not theme_shots.cached(self.ws, theme) and worker and theme_shots.ENABLED:
            try:
                worker.submit(lambda b: theme_shots.shoot(self.ws, theme, b)).result()
            except Exception:  # noqa: BLE001  画像が無くても CSS を読んで確認できる
                pass
        if not theme_shots.cached(self.ws, theme):
            return []
        return [(theme_shots.folder(self.ws, theme) / f"{i}.png").relative_to(self.ws.root).as_posix() for i in range(4)]

    async def _check_fixes(self, deck: str, r: dict, run: Workflow, snap, result: dict) -> dict:
        """検査のエラーを同じ会話に返して直させ、もう一度検査する（設計書 §8.1.2。警告は送らない）。

        上限は送信全体で FIX_LIMIT 回（r["fixes"] の数）。最後の検査の結果を返す。中断・失敗は例外になる。
        直させるのは、送信の前には無かったエラーだけ（前からあるものは今回の指示の範囲の外のことが多い）。
        """
        while (errors := self._new(r, result)) and not r["cancel"] and not run.cancelled and len(r.setdefault("fixes", [])) < FIX_LIMIT:
            fix = {"errors": len(errors), "limit": FIX_LIMIT, "summary": ""}
            r["fixes"].append(fix)
            r["state"] = "run"
            self.save(deck)
            self.broadcast(deck, r)
            fix["summary"] = await self._fix(deck, r, run, snap, self.prompt_fix(deck, r, {**result, "errors": errors}, len(r["fixes"]), FIX_LIMIT))
            result = await self._check(deck, r)
        return result

    async def _check(self, deck: str, r: dict) -> dict:
        """送信の後の検査。結果（check.py の形）を返し、画面用に r["check"] に入れる。"""
        r["state"] = "check"
        self.save(deck)
        self.broadcast(deck, r)
        result = (await anyio.to_thread.run_sync(check.check_theme, self.ws, r["theme"]) if r.get("mode") == "theme"
                  else await anyio.to_thread.run_sync(self.run_check, deck, None, None))
        r["check"] = self.check_view(result, self.check_before.get(r["id"]))
        return result

    def _errors_before(self, deck: str, r: dict) -> set:
        """送信の前からあった検査のエラー。今の版の検査の結果（checks.json）があれば使い、無ければ AI を動かす前に検査する。"""
        if r.get("mode") == "theme":
            result = check.check_theme(self.ws, r["theme"])
        else:
            result = check.load(self.ws, deck)
            if not result or result.get("version") != check.deck_version(self.ws, deck):
                result = self.run_check(deck, None, None)
        return {error_key(x) for x in result["errors"]}

    def _new(self, r: dict, result: dict) -> list[dict]:
        before = self.check_before.get(r["id"], set())
        return [x for x in result["errors"] if error_key(x) not in before]

    @staticmethod
    def _draft_final(value) -> dict | None:
        """下書きの担当の最後の返事（roles.DRAFT_SCHEMA）。形が違えば None（そのまま文章として出す）。"""
        try:
            data = final_json(value)
        except (TypeError, ValueError):
            return None
        ok = isinstance(data, dict) and isinstance(data.get("reply"), str) and isinstance(data.get("slides"), str)
        return {**data, "rebuild": data.get("rebuild") is True} if ok else None

    @staticmethod
    def _summary_final(value) -> dict | None:
        """テーマ・話し合いの最後の返事（roles.REPLY_SCHEMA）。形が違えば None（そのまま文章として出す）。"""
        try:
            data = final_json(value)
        except (TypeError, ValueError):
            return None
        return data if isinstance(data, dict) and isinstance(data.get("summary"), str) else None

    def handoff(self, deck: str, round_id: str, base: str, force: bool = False, defer: bool = False) -> dict:
        """下書きのチャットの「スライドにして」を、スライドのチャットの送信として始める（設計書 §8.8）。

        画面がスライドの保存待ちを確定してから呼ぶ（base は原稿の版）。下書きの確認で直す所があったときは、押されたときだけ（force）。
        """
        r = self.round(deck, round_id)
        h = r.get("handoff")
        if not h:
            raise StudioError("スライドに引き渡す方針がありません")
        if h.get("round"):
            return r  # 別の画面がもう始めた
        if defer:
            h["deferred"] = True
            h.pop("pending", None)
            self.save(deck)
            self.broadcast(deck)
            return r
        if h.get("deferred"):
            raise StudioError("下書きを続けることを選択済みです。下書きのチャットから改めて依頼してください")
        if h.get("blocked") and not force:
            raise StudioError("下書きの確認で直す所が見つかっています")
        data = self.state(deck)
        # 引き渡し先は1つのタブを使い回し、会話を続ける（前回どう作ったかを覚えている）
        new = next((t for t in data["tabs"] if t.get("handoff") and t.get("mode", "slides") == "slides"), None)
        if not new:
            src = next((t for t in data["tabs"] if t["id"] == r["tab"]), {})
            new = self._new_tab(data, name="下書きから")
            new.update(model=src.get("model"), effort=src.get("effort"),
                       ai_roles=json.loads(json.dumps(src.get("ai_roles") or {})), handoff=True)
            data["tabs"].append(new)
        new["open"] = True
        h["tab"] = new["id"]
        cur = memo.read(self.ws, deck)["text"]
        try:
            sent = self.send(deck, new["id"], base, [{"key": "deck", "label": "発表全体", "text": self._handoff_text(deck, new, h, cur)}],
                             r.get("attach") or [])
            sent["memo_base"] = cur
            h["round"] = sent["id"]
            h.pop("error", None)
        except StudioError as e:
            h["error"] = str(e)
        h.pop("pending", None)
        self.save(deck)
        self.broadcast(deck)
        return r

    def _handoff_text(self, deck: str, tab: dict, h: dict, cur: str) -> str:
        """既にスライドがあれば、変わった所だけを反映させる。作り直すのは利用者が頼んだとき（rebuild）だけ。"""
        rel = memo.rel(deck)
        # 前回この下書きからスライドにした送信（戻していないもの）の下書き
        prev = next((x["memo_base"] for x in reversed(self.state(deck)["rounds"])
                     if x["tab"] == tab["id"] and "memo_base" in x and x["state"] in ("done", "fail") and not x.get("restored")), None)
        if self.ws.is_blank(deck):
            head = f"下書き（{rel}）からスライドを作ってください。"
        elif h.get("rebuild"):
            head = f"下書き（{rel}）から、今のスライドを作り直してください（利用者の依頼）。使える図・画像とページの id は使い回します。"
        elif prev is None:
            head = (f"下書き（{rel}）をもとに、今のスライドを直してください。下書きと合わない所・足りない所だけを直し、"
                    "ほかは残します（全体を作り直さない。手で直した所も残す）。")
        elif prev == cur:
            head = f"下書き（{rel}）は前回スライドにしたときから変わっていません。下の方針の所だけスライドを直してください。"
        else:
            head = (f"下書き（{rel}）が、前回スライドにしたときから変わりました。変わった所だけをスライドに反映し、"
                    "ほかは残します（全体を作り直さない。手で直した所も残す）。\n\n"
                    f"[下書きの差分]（前回スライドにしたとき → 今）\n```diff\n{memo_diff(prev, cur)}\n```")
        return f"{head}\n\n[下書きの担当からの方針]\n{h['text']}"

    def run_check(self, deck: str | None, page: str | None, figure: str | None) -> dict:
        """AI の後の検査と、sandbox からの検査の依頼。Chromium を並行して開かないよう1つずつ行う。"""
        worker = getattr(self.srv, 'browser_worker', None)
        # 発表から頼まれた図の検査は、その発表のテーマで描く（まだ原稿に入れていない新しい図も同じ見た目で確かめるため）。
        theme = self.ws.deck_theme(deck) if figure and deck else None
        if worker:
            if figure:
                return worker.submit(lambda b: check.check_figure(self.ws, figure, browser=b, theme=theme), deck=deck).result()
            if not deck:
                raise StudioError("発表の名前か --figure を指定してください")
            return worker.submit(lambda b: check.check_deck(self.ws, deck, page=page, browser=b), deck=deck).result()
        with self.check_lock:
            if figure:
                return check.check_figure(self.ws, figure, theme=theme)
            if not deck:
                raise StudioError("発表の名前か --figure を指定してください")
            return check.check_deck(self.ws, deck, page=page)

    def run_audit(self, deck: str) -> dict:
        from .. import audit
        worker = getattr(self.srv, 'browser_worker', None)
        if worker:
            return worker.submit(lambda b: audit.run(self.ws, deck, browser=b), deck=deck).result()
        with self.check_lock:
            return audit.run(self.ws, deck)

    async def run_consult(self, tab_id, question) -> str:
        """編集担当が `slide-studio consult` で送った質問を、そのタブの相談役に答えさせる。依頼文は質問だけ。"""
        if not isinstance(question, str) or not question.strip():
            raise StudioError("相談の内容が空です")
        run = next((w for w in self.runs.values() if isinstance(w, Workflow) and w.tab.get("id") == tab_id
                    and not (w.cancelled or w.r["cancel"])), None)
        if run is None:
            raise StudioError("相談できるのは、そのタブで AI が作業している間だけです")
        return (await run.execute("consult", question.strip()))["summary"]

    @staticmethod
    def check_view(result: dict, before: set | None = None) -> dict:
        """画面用の検査の結果。送信の前からあったエラーには old を付ける（直させず、要修正にもしない）。"""
        def item(x: dict) -> dict:
            key = x.get("page_id") or (f"@{x['page']}" if x.get("page") is not None else "deck")
            where = f"p{x['slide'] + 1}" if x.get("slide") is not None else "全体"
            text = x["message"] + (f"（{check.step_label(x)}）" if check.step_label(x) else "")
            out = {"key": key, "label": where, "text": text}
            if before and x["level"] == "error" and error_key(x) in before:
                out["old"] = True
            return out
        return {"kind": result.get("kind"), "errors": [item(x) for x in result["errors"]], "warnings": [item(x) for x in result["warnings"]],
                "summary": check.summary(result) if "deck" in result else "\n".join(x["message"] for x in result["errors"])}

    # ------------------------------------------------------------ プロンプト（設計書 §8.3）
    # ------------------------------------------------------------ 起動・終了
    def start(self) -> None:
        self.bridge_task = asyncio.create_task(bridge.serve(self.ws, self.run_check, self.run_audit, self.run_consult))
        # 最初にチャットを開くまでに AI の検出を済ませておく
        task = asyncio.create_task(anyio.to_thread.run_sync(self.ai_status))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def stop(self) -> None:
        self.updater.stop()
        self.login.stop()
        if self.bridge_task:
            self.bridge_task.cancel()
        for run in list(self.runs.values()):
            run.kill_now()
        self.live.kill_all()
        for deck in list(self.data):
            try:
                self.save(deck)
            except OSError:
                pass


class ConflictError(StudioError):
    pass


def install(app, srv, routes) -> None:
    chat = Chat(srv)
    srv.hooks.append(chat)
    srv.starters.append(chat.start)
    srv.stoppers.append(chat.stop)
    srv.starters.append(chat.updater.start)
    app.state.chat = chat

    def deck_of(request: Request) -> str:
        deck = check_name(request.path_params["deck"], "発表の名前")
        srv.ws.require_deck(deck)
        return deck

    def guard(fn):
        async def handler(request: Request):
            try:
                return await fn(request)
            except ConflictError as e:
                return _json({"error": str(e)}, 409)
            except StudioError as e:
                return _json({"error": str(e)}, 400)
        return handler

    @guard
    async def status(request: Request):
        refresh = bool(request.query_params.get("refresh"))
        return _json(await anyio.to_thread.run_sync(chat.ai_status, refresh))

    def provider_param(request: Request):
        provider = PROVIDERS.get(request.path_params["provider"])
        if provider is None:
            raise StudioError("この AI は使えません")
        return provider

    @guard
    async def login(request: Request):
        provider = provider_param(request)
        if request.method == "GET":
            return _json(chat.login.state(provider))
        body = await request.json() if await request.body() else {}
        return _json(chat.login.start(provider, download=body.get("download") is True))

    @guard
    async def runtime_list(request: Request):
        return _json({"ai": await anyio.to_thread.run_sync(chat.runtime_list, bool(request.query_params.get("refresh")))})

    @guard
    async def runtime_action(request: Request):
        provider, body = provider_param(request), await request.json()
        return _json(await anyio.to_thread.run_sync(chat.runtime_action, provider, body))

    @guard
    async def favorites(request: Request):
        body = await request.json()
        return _json(await anyio.to_thread.run_sync(chat.set_favorites, body.get("favorites")))

    @guard
    async def get_state(request: Request):
        # AI の検出（数秒かかる）は待たない。画面は /api/ai/status を別に読む
        return _json(chat.public(deck_of(request)))

    @guard
    async def open_view(request: Request):
        return _json(chat.open_view(deck_of(request)))

    @guard
    async def add_tab(request: Request):
        body = await request.json() if await request.body() else {}
        return _json(chat.add_tab(deck_of(request), body.get("mode") or "slides"))

    @guard
    async def update_tab(request: Request):
        body = await request.json()
        if set(body) & {'ai_roles', 'model', 'effort'}:
            await anyio.to_thread.run_sync(chat.cached_status)
        return _json(chat.update_tab(deck_of(request), request.path_params["tab"], body))

    @guard
    async def send(request: Request):
        deck = deck_of(request)
        body = await request.json()
        await anyio.to_thread.run_sync(chat.ai_status)
        return _json(chat.send(deck, request.path_params["tab"], body.get("base"), body.get("items"), body.get("attach"),
                               talk=body.get("talk") is True))

    @guard
    async def continue_round(request: Request):
        body = await request.json()
        await anyio.to_thread.run_sync(chat.ai_status)
        return _json(chat.continue_round(deck_of(request), request.path_params["round"], body.get("base")))

    @guard
    async def cancel(request: Request):
        deck = deck_of(request)
        await chat.cancel(deck, request.path_params["round"])
        return _json({"ok": True})

    @guard
    async def restore(request: Request):
        deck = deck_of(request)
        if request.method == "GET":
            return _json(await chat.restore_preview(deck, request.path_params["round"]))
        return _json(await chat.restore(deck, request.path_params["round"]))

    @guard
    async def handoff(request: Request):
        deck = deck_of(request)
        body = await request.json()
        return _json(chat.handoff(deck, request.path_params["round"], str(body.get("base") or ""), body.get("force") is True, defer=body.get("defer") is True))

    @guard
    async def role_catalog(request: Request):
        # どの担当も置き場の AGENTS.md・skill と AI 本体の道具で動く。利用者の追加指示だけはアプリが依頼に添える
        return _json({'roles': [{'id': role.id, 'revision': role.revision, 'skill': role.skill, 'web': role.web,
                                 'readonly': role.readonly, 'configurable': role.configurable,
                                 'base': roles.base_files(chat.ws, role.id), 'extra': roles.extra(chat.ws, role.id)}
                                for role in roles.ROLES.values()],
                      'supported_providers': list(roles.SUPPORTED_PROVIDERS), 'extra_limit': roles.EXTRA_LIMIT})

    @guard
    async def role_extra(request: Request):
        body = await request.json()
        return _json({'extra': roles.set_extra(chat.ws, request.path_params["role"], body.get("text"))})

    # 既存の /api/deck/{deck}/{action} より先に照合させる
    app.router.routes[0:0] = [
        Route("/api/ai/status", status),
        Route("/api/ai/roles", role_catalog),
        Route("/api/ai/roles/{role}/extra", role_extra, methods=["PUT"]),
        Route("/api/ai/runtimes", runtime_list),
        Route("/api/ai/{provider}/login", login, methods=["GET", "POST"]),
        Route("/api/ai/{provider}/runtime", runtime_action, methods=["POST"]),
        Route("/api/ai/favorites", favorites, methods=["PUT"]),
        Route("/api/deck/{deck}/chat", get_state),
        Route("/api/deck/{deck}/chat/open", open_view, methods=["POST"]),
        Route("/api/deck/{deck}/chat/tabs", add_tab, methods=["POST"]),
        Route("/api/deck/{deck}/chat/tabs/{tab}", update_tab, methods=["PATCH"]),
        Route("/api/deck/{deck}/chat/tabs/{tab}/send", send, methods=["POST"]),
        Route("/api/deck/{deck}/chat/rounds/{round}/continue", continue_round, methods=["POST"]),
        Route("/api/deck/{deck}/chat/rounds/{round}/cancel", cancel, methods=["POST"]),
        Route("/api/deck/{deck}/chat/rounds/{round}/restore", restore, methods=["GET", "POST"]),
        Route("/api/deck/{deck}/chat/rounds/{round}/handoff", handoff, methods=["POST"]),
    ]
