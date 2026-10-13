#!/usr/bin/env python3
"""Stub that sleeps past any short timeout, then would print a valid catalog
document. Used with a small timeoutMs to hit the timeout path."""

import json
import time

time.sleep(5)
print(
    json.dumps(
        {
            "schema_version": 1,
            "generated_at": "2026-01-01T00:00:00+00:00",
            "models": [],
        }
    )
)
