#!/usr/bin/env python3
"""Run the repo's kite_cli.main() with the tool venv's deps."""

import sys

sys.path.insert(
    0, "/home/toxic/.local/share/uv/tools/kite-cli/lib/python3.12/site-packages"
)
sys.path.insert(0, "/home/toxic/estate/ranch/hatch/kite-cli/src")

from kite_cli.cli import main

main()
