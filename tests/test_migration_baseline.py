"""Safety and statistics tests for scripts/migration/baseline.py (no browser, no Pandoc)."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

from slide_studio.fsutil import sha256_bytes

ROOT = Path(__file__).resolve().parents[1]


def _load_baseline():
    path = ROOT / "scripts" / "migration" / "baseline.py"
    spec = importlib.util.spec_from_file_location("migration_baseline", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


baseline = _load_baseline()


def measurement(number: int, *, open_ms: float = 1.0, import_ms: float = 2.0,
                html_ms: float = 3.0, pdf_ms: float = 4.0, total_ms: float | None = None,
                html_size: int = 10, pdf_size: int = 20, pages: int = 2,
                text_chars: int = 100) -> dict:
    total = open_ms + import_ms + html_ms + pdf_ms if total_ms is None else total_ms
    return {
        "run": number,
        "stages": {
            "workspace_open_ms": open_ms,
            "import_ms": import_ms,
            "html_ms": html_ms,
            "pdf_ms": pdf_ms,
            "total_ms": total,
        },
        "html": {"size_bytes": html_size},
        "pdf": {
            "size_bytes": pdf_size,
            "pages": pages,
            "text_present": True,
            "text_chars": text_chars,
        },
    }


# ---------------------------------------------------------------- safety


def test_existing_directory_is_never_touched(tmp_path):
    out = tmp_path / "baseline"
    out.mkdir()
    keep = out / "keep.txt"
    keep.write_text("caller content")

    with pytest.raises(baseline.BaselineError):
        baseline.allocate_output(out)

    assert keep.read_text() == "caller content"


def test_existing_file_is_never_touched(tmp_path):
    out = tmp_path / "manifest.json"
    out.write_text("caller content")

    with pytest.raises(baseline.BaselineError):
        baseline.check_output_available(out)

    assert out.read_text() == "caller content"


def test_broken_symlink_counts_as_existing(tmp_path):
    if os.name == "nt":
        pytest.skip("symlink permissions differ on Windows")
    out = tmp_path / "baseline"
    out.symlink_to(tmp_path / "missing")

    with pytest.raises(baseline.BaselineError):
        baseline.check_output_available(out)


def test_failed_output_is_removed(tmp_path):
    out = tmp_path / "baseline"

    with pytest.raises(RuntimeError):
        with baseline.output_directory(out) as created:
            assert created == out and created.is_dir()
            (created / "partial.html").write_text("partial")
            raise RuntimeError("boom")

    assert not out.exists()


def test_successful_output_is_kept(tmp_path):
    out = tmp_path / "baseline"

    with baseline.output_directory(out) as created:
        (created / "manifest.json").write_text("{}")

    assert (out / "manifest.json").read_text() == "{}"


def test_main_stops_before_starting_browser_when_output_exists(tmp_path, monkeypatch):
    out = tmp_path / "baseline"
    out.mkdir()
    keep = out / "keep.txt"
    keep.write_text("caller content")

    def fail_if_started():
        raise AssertionError("browser must not start when output already exists")

    monkeypatch.setattr(baseline.check, "Browser", fail_if_started)

    assert baseline.main(["--output", str(out), "--runs", "1"]) == 1
    assert keep.read_text() == "caller content"


# ---------------------------------------------------------------- statistics


def test_summary_reports_median_max_and_min_per_stage():
    runs = [
        measurement(1, open_ms=10, import_ms=100, html_ms=200, pdf_ms=300, total_ms=610),
        measurement(2, open_ms=20, import_ms=200, html_ms=300, pdf_ms=400, total_ms=920),
        measurement(3, open_ms=30, import_ms=300, html_ms=400, pdf_ms=500, total_ms=1230),
    ]

    summary = baseline.summarize_measurements(runs)

    assert summary["total_ms"] == {"median": 920, "max": 1230, "min": 610}
    assert summary["import_ms"] == {"median": 200, "max": 300, "min": 100}
    assert summary["workspace_open_ms"] == {"median": 20, "max": 30, "min": 10}
    assert summary["pdf_pages"]["median"] == 2


def test_summary_rejects_empty_measurements():
    with pytest.raises(baseline.BaselineError):
        baseline.summarize_measurements([])


def test_representative_is_the_median_total_run():
    runs = [
        measurement(1, total_ms=100),
        measurement(2, total_ms=300),
        measurement(3, total_ms=200),
    ]

    index = baseline.representative_run_index(runs)

    assert index == 2
    assert runs[index]["run"] == 3


# ---------------------------------------------------------------- fixture hashes


def test_fixture_hashes_are_sorted_and_ignore_ds_store(tmp_path):
    fixture = tmp_path / "fixture"
    (fixture / "sub").mkdir(parents=True)
    (fixture / "a.txt").write_text("a")
    (fixture / "sub" / "b.txt").write_text("b")
    (fixture / ".DS_Store").write_text("ignored")

    first = baseline.fixture_hashes(fixture)

    assert list(first["files"]) == ["a.txt", "sub/b.txt"]
    assert first["file_count"] == 2
    assert first["files"]["a.txt"] == sha256_bytes(b"a")
    assert baseline.fixture_hashes(fixture) == first

    (fixture / "sub" / "b.txt").write_text("changed")
    changed = baseline.fixture_hashes(fixture)

    assert changed["files"]["a.txt"] == first["files"]["a.txt"]
    assert changed["files"]["sub/b.txt"] != first["files"]["sub/b.txt"]
    assert changed["aggregate_sha256"] != first["aggregate_sha256"]


# ---------------------------------------------------------------- PDF metrics


def test_pdf_metrics_uses_reader_and_extracted_text(tmp_path):
    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"%PDF-")

    class Box:
        def __init__(self, width: float, height: float):
            self.width = width
            self.height = height

    class Page:
        def __init__(self, text: str, width: float = 1280.0, height: float = 720.0):
            self.text = text
            self.mediabox = Box(width, height)

        def extract_text(self) -> str:
            return self.text

    class Reader:
        def __init__(self, path):
            assert Path(path) == pdf
            self.pages = [Page("こんにちは"), Page("  \n", width=612.0, height=792.0)]

    metrics = baseline.pdf_metrics(pdf, reader_cls=Reader)

    assert metrics == {
        "pages": 2,
        "page_sizes": [
            {"width_pt": 1280.0, "height_pt": 720.0},
            {"width_pt": 612.0, "height_pt": 792.0},
        ],
        "size_bytes": 5,
        "text_present": True,
        "text_chars": 5,
        "text_sha256": sha256_bytes("こんにちは".encode("utf-8")),
    }


def test_pdf_metrics_reports_missing_text(tmp_path):
    pdf = tmp_path / "blank.pdf"
    pdf.write_bytes(b"")

    class Box:
        width = 612.0
        height = 792.0

    class Page:
        mediabox = Box()

        def extract_text(self) -> str:
            return " \n\t"

    class Reader:
        def __init__(self, path):
            self.pages = [Page()]

    metrics = baseline.pdf_metrics(pdf, reader_cls=Reader)

    assert metrics["page_sizes"] == [{"width_pt": 612.0, "height_pt": 792.0}]
    assert metrics["text_present"] is False
    assert metrics["text_chars"] == 0


def test_canonical_pdf_text_ignores_line_endings_and_trailing_spaces():
    first = baseline.canonical_pdf_text("A\r\nB  \r\n\r\n")
    second = baseline.canonical_pdf_text("A\nB")

    assert first == second == "A\nB"
    assert sha256_bytes(first.encode("utf-8")) == sha256_bytes(second.encode("utf-8"))


# ---------------------------------------------------------------- scope


def test_scope_marks_batch_export_and_excludes_gui_and_memory():
    assert baseline.SCOPE["kind"] == "batch_export_baseline"
    assert baseline.SCOPE["is_gui_startup_baseline"] is False
    assert baseline.SCOPE["is_total_process_memory_baseline"] is False
    assert "warm browser" in baseline.SCOPE["browser_mode"]
    assert any("GUI startup" in item for item in baseline.SCOPE["does_not_measure"])
    assert any("process memory" in item for item in baseline.SCOPE["does_not_measure"])
