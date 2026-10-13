#!/usr/bin/env python3
"""Stub that fails the way the vendored script does on a data-source error:
a message on stderr and exit status 1."""

import sys

print("stub: simulated fetch failure", file=sys.stderr)
sys.exit(1)
