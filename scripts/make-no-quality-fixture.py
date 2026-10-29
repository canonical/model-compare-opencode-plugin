#!/usr/bin/env python3
"""Regenerate fixtures/catalog-no-quality.json from the recorded catalog.

The no-quality fixture stands for a catalog produced when NO candidate has
quality data (the AA data absent): upstream then drops the `quality` weight key
and renormalizes the rest. Everything the script would derive from that is
recomputed here with the VENDORED script's own functions, so the fixture is
internally consistent instead of a hand-edited copy with stale scores:

  - parameters.weights   <- model_compare.catalog_weights(candidates, {})
  - scores.quality       <- 0 (quality_score of an unmatched candidate)
  - scores.overall       <- the exact derivation of build_catalog: weighted sum
                            of the ROUNDED component scores, rounded to 4
  - rankings             <- model_compare.catalog_rankings (see the caveat)
  - models order         <- (-overall.balanced, id), as build_catalog sorts
  - quality / aa indices <- null, quality_match null, quality_as_of,
                             quality_drift and quality_effort null,
                             reasoning.depths emptied (no measured quality),
                             sources.aa none/0 (v5 shape, depth counters 0)
  - schedules[].quality  <- null, quality_as_of, quality_effort and
                            quality_source null, score <- the new balanced
                            overall

Caveat: the recorded document only has the 4-decimal ROUNDED component scores,
while upstream orders `rankings` from unrounded ones; a near-tie may therefore
sit differently than a real run would put it (design §6 "Rounding").

Usage: python3 scripts/make-no-quality-fixture.py   (from the repository root)
"""

import importlib.util
import json
import sys

SOURCE = "fixtures/catalog-v0.7.0.json"
TARGET = "fixtures/catalog-no-quality.json"
VENDOR = "vendor/model_compare.py"


def load_vendor():
    spec = importlib.util.spec_from_file_location("model_compare", VENDOR)
    module = importlib.util.module_from_spec(spec)
    sys.modules["model_compare"] = module
    spec.loader.exec_module(module)
    return module


def main():
    mc = load_vendor()
    with open(SOURCE, encoding="utf-8") as fh:
        doc = json.load(fh)

    candidates = []
    for model in doc["models"]:
        scores = model["scores"]
        candidates.append(
            {
                "id": model["id"],
                "quality": None,
                "quality_score": 0.0,
                "price_score": scores["price"],
                "context_score": scores["context"],
                "age_score": scores["age"],
                "blended": model["pricing"]["blended_per_1m"],
            }
        )

    weights = mc.catalog_weights(candidates, {})  # quality-blind pool
    priorities = list(mc.PRIORITY_WEIGHTS)

    for model in doc["models"]:
        scores = model["scores"]
        scores["quality"] = 0
        scores["overall"] = {
            p: round(
                weights[p].get("quality", 0.0) * scores["quality"]
                + weights[p].get("price", 0.0) * scores["price"]
                + weights[p].get("context", 0.0) * scores["context"]
                + weights[p].get("age", 0.0) * scores["age"],
                4,
            )
            for p in priorities
        }
        model["quality"] = None
        model["quality_match"] = None
        model["quality_as_of"] = None
        model["quality_drift"] = None
        model["quality_effort"] = None
        if isinstance(model.get("reasoning"), dict):
            model["reasoning"]["depths"] = []
        model["aa"] = {
            "intelligence_index": None,
            "coding_index": None,
            "agentic_index": None,
        }

    doc["models"].sort(key=lambda m: (-m["scores"]["overall"]["balanced"], m["id"]))
    doc["parameters"]["weights"] = weights
    doc["rankings"] = mc.catalog_rankings(candidates, weights)
    doc["sources"]["aa"] = {
        "mode": "none",
        "matched_aa": 0,
        "matched_catalog": 0,
        "matched_openrouter": 0,
        "depth_rows": 0,
        "matched_depth": 0,
        "matched_default": 0,
        "catalog_generated_at": None,
        "intelligence_index_version": None,
    }

    balanced = {m["id"]: m["scores"]["overall"]["balanced"] for m in doc["models"]}
    for entry in doc["schedules"]:
        entry["quality"] = None
        entry["quality_as_of"] = None
        entry["quality_effort"] = None
        entry["quality_source"] = None
        if entry["id"] in balanced:
            entry["score"] = balanced[entry["id"]]

    with open(TARGET, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {TARGET}: {len(doc['models'])} models, weights {json.dumps(weights)}")


if __name__ == "__main__":
    main()
