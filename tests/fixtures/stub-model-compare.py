#!/usr/bin/env python3
"""Minimal stand-in for vendor/model_compare.py used by the local-source tests.

Switches on argv like the real script: ``--version`` prints a fixed version
line; ``--catalog`` prints the recorded catalog fixture from disk (resolved
relative to this file, so the stub works from any working directory).
"""

import os
import sys

FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "..",
    "fixtures",
    "catalog-no-quality.json",
)

if "--version" in sys.argv[1:]:
    print("model-compare 9.9.9")
elif "--catalog" in sys.argv[1:]:
    with open(FIXTURE, encoding="utf-8") as handle:
        sys.stdout.write(handle.read())
else:
    print("usage: stub-model-compare.py [--version | --catalog]", file=sys.stderr)
    sys.exit(2)
