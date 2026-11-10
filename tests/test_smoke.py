"""Smoke + regression tests for the toxicwind/kite-cli fork.

No network, no credentials, no browser: pure source/config checks.
Run with: python -m pytest tests/ -q
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "kite_cli"


def test_gateway_tls_verify_enabled():
    """Regression guard for nikships/muse-cli#1: the gateway WebSocket must
    verify TLS certificates (upstream fix 9406cbb, released in 0.3.2,
    inherited by this fork with full history)."""
    text = (SRC / "gateway.py").read_text()
    assert re.search(r"\.connect\(.*?verify\s*=\s*True", text, re.S), (
        "gateway WebSocket connect() must pass verify=True; "
        "curl_cffi defaults to verify=None (no verification)"
    )


def test_routes_json_method_count():
    """routes.json must carry the full 258-method gateway table the README
    and the `raw` escape hatch advertise."""
    data = json.loads((SRC / "routes.json").read_text())
    assert isinstance(data, list), "routes.json must be a list of methods"
    assert len(data) == 258, f"expected 258 gateway methods, got {len(data)}"
    methods = [entry["method"] for entry in data]
    assert len(set(methods)) == 258, "gateway method names must be unique"


def test_readme_install_points_at_fork():
    """The fork repoint: install/clone/asset/doc URLs must resolve to
    toxicwind/kite-cli, never the upstream repo."""
    text = (ROOT / "README.md").read_text()
    assert "raw.githubusercontent.com/toxicwind/kite-cli/main/install.sh" in text
    assert "git clone https://github.com/toxicwind/kite-cli.git" in text
    assert "raw.githubusercontent.com/nikships" not in text
    assert "github.com/nikships/muse-cli/blob" not in text
    assert "github.com/nikships/muse-cli.git" not in text


def test_site_links_point_at_fork():
    """The Firebase-hosted site's repo links must resolve to the fork."""
    text = (ROOT / "site" / "index.html").read_text()
    assert "github.com/nikships/muse-cli" not in text


def test_version_sane():
    """Package version must be a plain x.y.z the PyPI update check can parse."""
    text = (SRC / "__init__.py").read_text()
    match = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    assert match, "__version__ not found in __init__.py"
    assert re.fullmatch(r"\d+\.\d+\.\d+", match.group(1)), (
        f"version {match.group(1)!r} is not plain x.y.z"
    )
