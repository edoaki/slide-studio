from pathlib import Path
from unittest.mock import Mock

from starlette.testclient import TestClient

from slide_studio import cli, server
from slide_studio.location import build_location_app
from slide_studio.workspace import Workspace, default_root, saved_root


def test_first_launch_and_saved_launch(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("SLIDE_STUDIO_HOME", raising=False)
    serve = Mock()
    monkeypatch.setattr(server, "serve", serve)
    cli.main([])
    assert serve.call_args.args == (None,)
    assert not (tmp_path / "Slides").exists()
    custom = tmp_path / "好きな名前"
    with TestClient(build_location_app()) as client:
        assert client.get("/").status_code == 200
        assert client.get("/api/location/folders").json()["suggested"] == str(tmp_path / "Slides")
        assert client.post("/api/location", json={"mode": "new", "path": str(custom)}).status_code == 200
        assert client.get("/api/home").json()["root"] == str(custom.resolve())
    assert saved_root() == custom.resolve()
    assert default_root() == custom.resolve()
    cli.main([])
    assert serve.call_args.args[0].root == custom.resolve()
    custom.rename(tmp_path / "moved")
    cli.main([])
    assert serve.call_args.args == (None,)
    assert not custom.exists()


def test_existing_folder_and_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    existing = Workspace.open(tmp_path / "slide-studio")
    existing.new_deck("talk", "research")
    original = existing.qmd("talk").read_bytes()
    unrelated = tmp_path / "other"
    unrelated.mkdir()
    (unrelated / "keep.txt").write_text("keep")
    with TestClient(build_location_app()) as client:
        for body in ({"mode": "new", "path": str(existing.root)},
                     {"mode": "existing", "path": str(unrelated)},
                     {"mode": "existing", "path": str(tmp_path / "missing")},
                     {"mode": "new", "path": "relative"},
                     {"mode": "invalid", "path": str(tmp_path)}):
            assert client.post("/api/location", json=body).status_code == 400
        assert saved_root() is None
        body = {"mode": "existing", "path": str(existing.root)}
        assert client.post("/api/location", json=body, headers={"origin": "https://other.example"}).status_code == 403
        assert client.post("/api/location", json=body).status_code == 200
        assert client.get("/api/home").json()["recent"][0]["deck"] == "talk"
    assert original == existing.qmd("talk").read_bytes()
    assert (unrelated / "keep.txt").read_text() == "keep"


def test_empty_existing_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    folder = tmp_path / "empty"
    folder.mkdir()
    with TestClient(build_location_app()) as client:
        assert client.post("/api/location", json={"mode": "existing", "path": str(folder)}).status_code == 200
    assert (folder / "README.md").is_file()


def test_switch_locations_and_reject_stale_editor(tmp_path, monkeypatch):
    import re

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    first = Workspace.open(tmp_path / "first")
    first.new_deck("talk", "research")
    original = first.qmd("talk").read_bytes()
    second = tmp_path / "second"
    with TestClient(build_location_app(initial_ws=first)) as client:
        html = client.get("/").text
        token = re.search(r'name="slide-studio-location" content="([^"]+)"', html)[1]
        assert client.get("/location").status_code == 200
        assert client.get("/api/location").json()["current"] == str(first.root)
        assert client.post("/api/location", json={"mode": "new", "path": str(second)}).status_code == 200
        assert client.get("/api/home").json()["root"] == str(second)
        assert client.get("/api/location").json()["recent"] == [str(second), str(first.root)]
        assert (second / ".slide-studio").is_dir()
        stale = {"X-Slide-Studio-Location": token}
        assert client.post("/api/new", json={"name": "wrong", "topic": "test"}, headers=stale).status_code == 409
        assert not (second / "decks" / "wrong").exists()
        assert client.post("/api/deck/talk/assets?name=wrong.png", content=b"wrong", headers=stale).status_code == 409
        assert client.post("/api/location", json={"mode": "existing", "path": str(first.root)}).status_code == 200
        assert client.get("/api/home").json()["root"] == str(first.root)
        assert client.get("/api/location").json()["recent"] == [str(first.root), str(second)]
        assert client.post("/api/location", json={"mode": "existing", "path": str(tmp_path / "missing")}).status_code == 400
        assert client.get("/api/home").json()["root"] == str(first.root)
    assert saved_root() == first.root
    assert first.qmd("talk").read_bytes() == original
