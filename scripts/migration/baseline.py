"""M0 batch-export performance baseline for the current Python implementation.

This script is deliberately narrow. It measures, on this machine:

* ``Workspace.open`` on a fresh temporary directory
* ``importer.import_deck`` of ``tests/fixtures/nco-intro``
* ``export.bundle_deck`` (single-file HTML)
* ``export.pdf_from_html`` (PDF)

It does NOT measure GUI startup, time to an editable window, total process
memory (Python + Chromium + Pandoc children), or Electron renderer behaviour.
Those need separate M0/M1 measurements. One Chromium browser is started before
the runs and reused (warm browser); its cold start is excluded.

Run from the repository root::

    uv run python scripts/migration/baseline.py --output <new directory> --runs 5

The output directory must not exist. It is created only after all measurements
succeed, and is removed again if writing the final files fails. Temporary
workspaces are always removed, and the browser plus Pandoc workers are closed in
a ``finally`` block.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

# Make the repository's slide_studio package/baseline fixtures importable even
# when this file is invoked directly as scripts/migration/baseline.py.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) in sys.path:
    sys.path.remove(str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT))

from pypdf import PdfReader  # noqa: E402

from slide_studio import __version__, check, export, importer, pandoc_worker  # noqa: E402
from slide_studio.doctor import pandoc_path, pandoc_version  # noqa: E402
from slide_studio.fsutil import sha256_bytes, sha256_file, write_atomic  # noqa: E402
from slide_studio.workspace import Workspace  # noqa: E402

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "nco-intro"
DECK = "nco-intro"
TOPIC = "nco"

KIND = "batch_export_baseline"
SCOPE = {
    "kind": KIND,
    "is_batch_export_baseline": True,
    "is_gui_startup_baseline": False,
    "is_total_process_memory_baseline": False,
    "measures": [
        "Workspace.open on a fresh temporary directory",
        "importer.import_deck of tests/fixtures/nco-intro",
        "export.bundle_deck single-file HTML",
        "export.pdf_from_html PDF via one reused check.Browser (warm browser)",
    ],
    "browser_mode": "one Chromium browser started before the measurements and reused (warm browser)",
    "does_not_measure": [
        "GUI startup or time to an editable view",
        "total process memory across Python, Chromium, and Pandoc",
        "browser process memory or cold browser launch",
        "Electron renderer performance",
        "AI features or network access",
    ],
}

SUMMARY_FIELDS = {
    "workspace_open_ms": lambda m: m["stages"]["workspace_open_ms"],
    "import_ms": lambda m: m["stages"]["import_ms"],
    "html_ms": lambda m: m["stages"]["html_ms"],
    "pdf_ms": lambda m: m["stages"]["pdf_ms"],
    "total_ms": lambda m: m["stages"]["total_ms"],
    "html_size_bytes": lambda m: m["html"]["size_bytes"],
    "pdf_size_bytes": lambda m: m["pdf"]["size_bytes"],
    "pdf_pages": lambda m: m["pdf"]["pages"],
    "pdf_text_chars": lambda m: m["pdf"]["text_chars"],
}

LIMITATIONS = [
    "This is a batch export baseline, not a GUI startup or total process memory baseline.",
    "Timings come from one machine and one OS; they are not a performance guarantee.",
    "One Chromium browser is started before the runs and reused, so cold browser launch is excluded.",
    "Pandoc workers are reused as the product does; their first startup is included in the first run.",
    "import_ms covers only importer.import_deck; Workspace.open is measured separately as workspace_open_ms.",
    "pdf_text_present is a pypdf non-whitespace extraction heuristic, not a full PDF conformance check.",
    "pdf_text_sha256 hashes canonical extracted text (line endings and trailing spaces normalised), so it is comparable even when raw PDF hashes differ because of timestamps.",
    "The representative HTML/PDF is the run whose total_ms is closest to the median total.",
    "Temporary directories use the local filesystem; disk and OS cache conditions affect timings.",
    "If git.dirty is true, the recorded commit does not exactly reproduce the working tree.",
]


class BaselineError(Exception):
    """A baseline run that must stop without touching caller content."""


# ---------------------------------------------------------------- safety


def check_output_available(output: Path) -> None:
    """Refuse to run when anything (file, directory, or broken symlink) is there."""
    if os.path.lexists(output):
        raise BaselineError(f"output already exists; refusing to overwrite: {output}")


def allocate_output(output: Path) -> Path:
    """Create a brand-new output directory, never replacing caller content."""
    output = Path(output)
    check_output_available(output)
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise BaselineError(f"cannot create output parent directory: {output.parent}: {exc}") from exc
    try:
        os.mkdir(output)
    except FileExistsError as exc:
        # Another process created it after the check; still do not touch it.
        raise BaselineError(f"output already exists; refusing to overwrite: {output}") from exc
    return output


@contextmanager
def output_directory(output: Path) -> Iterator[Path]:
    """Yield an owned output directory and discard it if finalisation fails."""
    output = allocate_output(output)
    try:
        yield output
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise


# ---------------------------------------------------------------- hashes


def fixture_hashes(root: Path) -> dict:
    """Hash every regular fixture file, excluding macOS metadata."""
    root = Path(root)
    if not root.is_dir():
        raise BaselineError(f"fixture directory not found: {root}")
    files: dict[str, str] = {}
    for path in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
        if not path.is_file() or path.name == ".DS_Store":
            continue
        files[path.relative_to(root).as_posix()] = sha256_file(path)
    if not files:
        raise BaselineError(f"fixture directory is empty: {root}")
    listing = "\n".join(f"{name}\0{digest}" for name, digest in files.items())
    return {
        "file_count": len(files),
        "aggregate_sha256": sha256_bytes(listing.encode("utf-8")),
        "files": files,
    }


# ---------------------------------------------------------------- statistics


def _summary_value(value: float) -> float:
    return round(float(value), 3)


def summarize_measurements(measurements: list[dict]) -> dict:
    """Median, max, and min for each timing and size field."""
    if not measurements:
        raise BaselineError("no measurements to summarize")
    summary = {}
    for name, getter in SUMMARY_FIELDS.items():
        values = [float(getter(m)) for m in measurements]
        summary[name] = {
            "median": _summary_value(median(values)),
            "max": _summary_value(max(values)),
            "min": _summary_value(min(values)),
        }
    return summary


def representative_run_index(measurements: list[dict]) -> int:
    """Index of the run whose total time is closest to the median total."""
    if not measurements:
        raise BaselineError("no measurements to choose from")
    totals = [float(m["stages"]["total_ms"]) for m in measurements]
    target = median(totals)
    return min(range(len(totals)), key=lambda i: (abs(totals[i] - target), i))


# ---------------------------------------------------------------- PDFs


def canonical_pdf_text(text: str) -> str:
    """Normalise incidental whitespace so extracted-text hashes compare across raw PDFs."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.split("\n")).strip()


def pdf_metrics(path: Path, *, reader_cls=PdfReader) -> dict:
    """Pages, page sizes, byte size, and canonical extracted-text hash for a PDF."""
    path = Path(path)
    reader = reader_cls(path)
    pages = list(reader.pages)
    text = canonical_pdf_text("\n".join((page.extract_text() or "") for page in pages))
    return {
        "pages": len(pages),
        "page_sizes": [
            {
                "width_pt": round(float(page.mediabox.width), 3),
                "height_pt": round(float(page.mediabox.height), 3),
            }
            for page in pages
        ],
        "size_bytes": path.stat().st_size,
        "text_present": bool(text),
        "text_chars": len(text),
        "text_sha256": sha256_bytes(text.encode("utf-8")),
    }


# ---------------------------------------------------------------- environment


def _git(repo: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def git_state(repo: Path) -> dict:
    """Pin the commit. Tracked-file dirtiness is recorded because it affects reproduction."""
    commit = _git(repo, "rev-parse", "HEAD")
    if not commit:
        raise BaselineError("cannot determine the git commit; run from a git checkout")
    status = _git(repo, "status", "--porcelain", "--untracked-files=no")
    return {"commit": commit, "dirty": None if status is None else bool(status)}


def environment(browser: check.Browser, git: dict) -> dict:
    """Versions needed to compare the M0 baseline with later M1 runs."""
    return {
        "git": git,
        "platform": {
            "platform": platform.platform(),
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "processor": platform.processor(),
        },
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
        },
        "pandoc": {
            "version": pandoc_version(),
            "path": str(pandoc_path()),
        },
        "playwright": {
            "version": importlib.metadata.version("playwright"),
        },
        "chromium": {
            "browser": "chromium",
            "version": str(browser.browser.version),
        },
        "slide_studio": {
            "version": __version__,
        },
    }


def _display_path(path: Path) -> str:
    try:
        return Path(path).resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(Path(path).resolve())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------- measurement


def _ms(seconds: float) -> float:
    return round(seconds * 1000, 3)


def measure_run(browser: check.Browser, root: Path, number: int,
                *, fixture: Path = FIXTURE, deck: str = DECK, topic: str = TOPIC) -> tuple[dict, Path, Path]:
    """Fresh import + HTML + PDF in a newly allocated temporary workspace."""
    total_start = time.perf_counter()

    t0 = total_start
    ws = Workspace.open(root)
    t1 = time.perf_counter()

    importer.import_deck(ws, fixture, topic, name=deck)
    t2 = time.perf_counter()

    html = export.bundle_deck(ws, deck)
    t3 = time.perf_counter()

    pdf = html.with_suffix(".pdf")
    export_info = export.pdf_from_html(html, pdf, browser=browser)
    t4 = time.perf_counter()

    pdf_info = pdf_metrics(pdf)
    html_info = {
        "filename": html.name,
        "size_bytes": html.stat().st_size,
        "sha256": sha256_file(html),
    }
    record = {
        "run": number,
        "stages": {
            "workspace_open_ms": _ms(t1 - t0),
            "import_ms": _ms(t2 - t1),
            "html_ms": _ms(t3 - t2),
            "pdf_ms": _ms(t4 - t3),
            "total_ms": _ms(t4 - total_start),
        },
        "html": html_info,
        "pdf": {
            "filename": pdf.name,
            **pdf_info,
            "sha256": sha256_file(pdf),
        },
        "export": export_info,
    }
    return record, html, pdf


# ---------------------------------------------------------------- CLI


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="M0 batch-export performance baseline (not GUI startup or total memory)",
    )
    parser.add_argument("--output", required=True, type=Path,
                        help="new directory for manifest.json and representative HTML/PDF")
    parser.add_argument("--runs", type=int, default=5, help="number of fresh import+export runs")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output = args.output

    try:
        # Fail before doing expensive work, and again atomically at allocation time.
        check_output_available(output)
        git = git_state(REPO_ROOT)
        fixture = {
            "path": _display_path(FIXTURE),
            "deck": DECK,
            "topic": TOPIC,
            **fixture_hashes(FIXTURE),
        }

        measurements: list[dict] = []
        output_paths: list[tuple[Path, Path]] = []
        temporary_dirs: list[Path] = []
        browser: check.Browser | None = None
        try:
            # Reuse one browser so browser startup is not hidden inside any export stage.
            browser = check.Browser()
            env = environment(browser, git)
            for number in range(1, args.runs + 1):
                root = Path(tempfile.mkdtemp(prefix=f"slide-studio-m0-baseline-run-{number}-"))
                temporary_dirs.append(root)
                record, html, pdf = measure_run(browser, root, number)
                measurements.append(record)
                output_paths.append((html, pdf))

            index = representative_run_index(measurements)
            representative = measurements[index]
            html_source, pdf_source = output_paths[index]

            summary = summarize_measurements(measurements)
            text_hashes = sorted({m["pdf"]["text_sha256"] for m in measurements})
            with output_directory(output) as out:
                html_copy = out / html_source.name
                pdf_copy = out / pdf_source.name
                write_atomic(html_copy, html_source.read_bytes())
                write_atomic(pdf_copy, pdf_source.read_bytes())

                manifest = {
                    "schema_version": 1,
                    "kind": KIND,
                    "generated_at": _now(),
                    "git_commit": git["commit"],
                    "git_dirty": git["dirty"],
                    "scope": SCOPE,
                    "environment": env,
                    "fixture": fixture,
                    "inputs": {
                        "fixture": fixture["path"],
                        "deck": DECK,
                        "topic": TOPIC,
                        "runs": args.runs,
                    },
                    "measurements": measurements,
                    "summary": summary,
                    "pdf_text_present": {
                        "all_runs": all(m["pdf"]["text_present"] for m in measurements),
                        "runs_with_text": sum(m["pdf"]["text_present"] for m in measurements),
                        "runs": len(measurements),
                        "canonical_sha256": text_hashes,
                        "canonical_sha256_consistent": len(text_hashes) == 1,
                    },
                    "representative": {
                        "run": representative["run"],
                        "selection": "closest total_ms to median",
                        "html": {
                            "file": html_copy.name,
                            "sha256": sha256_file(html_copy),
                            "size_bytes": html_copy.stat().st_size,
                        },
                        "pdf": {
                            "file": pdf_copy.name,
                            "sha256": sha256_file(pdf_copy),
                            "size_bytes": pdf_copy.stat().st_size,
                            "pages": representative["pdf"]["pages"],
                            "page_sizes": representative["pdf"]["page_sizes"],
                            "text_present": representative["pdf"]["text_present"],
                            "text_chars": representative["pdf"]["text_chars"],
                            "text_sha256": representative["pdf"]["text_sha256"],
                        },
                    },
                    "limitations": LIMITATIONS,
                }
                write_atomic(
                    out / "manifest.json",
                    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                )
        finally:
            if browser is not None:
                try:
                    browser.close()
                except Exception as exc:  # noqa: BLE001 - cleanup must not hide the original failure
                    print(f"baseline: warning: browser close failed: {exc}", file=sys.stderr)
            try:
                pandoc_worker.close()
            except Exception as exc:  # noqa: BLE001
                print(f"baseline: warning: Pandoc close failed: {exc}", file=sys.stderr)
            for directory in temporary_dirs:
                shutil.rmtree(directory, ignore_errors=True)

        print(f"wrote {output / 'manifest.json'}")
        return 0
    except BaselineError as exc:
        print(f"baseline: {exc}", file=sys.stderr)
        return 1
    except Exception:  # noqa: BLE001 - show the traceback for the integrator, after cleanup
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
