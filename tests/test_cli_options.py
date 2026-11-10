"""Every option a workflow passes must exist on the command it is passed to.
(A missed edit shipped `--min-gap` in weekly-ingest.yml before the commands had it.)"""

from __future__ import annotations

import re
from pathlib import Path

from typer.testing import CliRunner

from ingest.cli import app

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _help(runner: CliRunner, words: list[str]):
    """Help text without colour codes (CI terminals colour it, which splits option names)."""
    res = runner.invoke(app, [*words, "--help"], env={"NO_COLOR": "1", "TERM": "dumb", "COLUMNS": "200"})
    return res.exit_code, _ANSI.sub("", res.output)


def test_workflow_commands_and_options_exist():
    runner = CliRunner()
    seen = 0
    for wf in WORKFLOWS.glob("*.yml"):
        for line in wf.read_text().splitlines():
            m = re.search(r"\bbsb ((?:[a-z][a-z-]+ ){1,2})", line + " ")
            if not m or line.strip().startswith("#"):
                continue
            words = m.group(1).split()
            flags = set(re.findall(r"(--[a-z][a-z-]+)", line)) | {f"--{f}" for f in re.findall(r"args\+=\(--([a-z-]+)", line)}
            code, text = _help(runner, words)
            assert code == 0, f"{wf.name}: `bsb {' '.join(words)}` is not a command"
            for flag in flags:
                assert flag in text, f"{wf.name}: `bsb {' '.join(words)}` has no option {flag}"
            seen += 1
    assert seen >= 12


def test_stale_flags_used_by_workflows_exist():
    runner = CliRunner()
    assert "--if-stale" in _help(runner, ["model", "project"])[1]
    assert "--if-stale" in _help(runner, ["lineups", "build"])[1]
