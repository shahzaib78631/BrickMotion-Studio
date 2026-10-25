"""Learned ordering prior: ONLY reorders certified candidates, never approves them.

Feature vector (fixed key order so saved weights stay portable):
  tier0      1.0 if candidate travels along a certified snap joint axis
  tier1      1.0 if candidate has a face contact with the placed set
  tier2      1.0 if candidate is a pure fallback (gravity/side) candidate
  contacts   number of joints the piece has with already-placed pieces
  area       supported face area / 1000
  lateral    1.0 if travel axis is horizontal
  dist       travel distance / 100
Weights are trained offline (train.py) from certification traces and stored as
plain JSON {"weights": {...}, "bias": x}; no learned component is invoked at
plan time unless that file is supplied.
"""
from __future__ import annotations

import json
import math

import numpy as np

FEATURES = ["tier0", "tier1", "tier2", "contacts", "area", "lateral", "dist"]


def vectorize(cand) -> dict[str, float]:
    return {
        "tier0": 1.0 if cand.tier == 0 else 0.0,
        "tier1": 1.0 if cand.tier == 1 else 0.0,
        "tier2": 1.0 if cand.tier == 2 else 0.0,
        "contacts": float(cand.contacts),
        "area": cand.area / 1000.0,
        "lateral": 1.0 if abs(cand.axis[0]) > 0.5 or abs(cand.axis[2]) > 0.5 else 0.0,
        "dist": cand.dist / 100.0,
    }


def x_row(features: dict[str, float]) -> np.ndarray:
    return np.array([features[k] for k in FEATURES], dtype=np.float64)


def features(asm, cand, placed: set[str]) -> dict[str, float]:
    """Public feature hook used by the search (kept for trace symmetry)."""
    return vectorize(cand)


class Prior:
    def __init__(self, weights: dict[str, float], bias: float):
        self.weights = np.array([weights.get(k, 0.0) for k in FEATURES], dtype=np.float64)
        self.bias = bias

    def score(self, features: dict[str, float]) -> float:
        return float(1.0 / (1.0 + math.exp(-self.bias - float(x_row(features) @ self.weights))))

    @staticmethod
    def load(path: str | None) -> "Prior | None":
        if not path:
            return None
        with open(path) as f:
            raw = json.load(f)
        return Prior(raw.get("weights", {}), raw.get("bias", 0.0))

    def save(self, path: str) -> None:
        data = {"weights": {k: float(w) for k, w in zip(FEATURES, self.weights)}, "bias": float(self.bias)}
        with open(path, "w") as f:
            json.dump(data, f, indent=2)


def train_from_traces(trace_paths: list[str], out_path: str, epochs: int = 200, lr: float = 0.05, l2: float = 1e-4) -> dict:
    """Pairwise logistic: within each decision, chosen-and-certified = 1, certified-not-chosen = 0."""
    pos: list[np.ndarray] = []
    neg: list[np.ndarray] = []
    for path in trace_paths:
        with open(path) as f:
            for line in f:
                row = json.loads(line)
                cands = [c for c in row.get("candidates", []) if c.get("certified") == 1 and c.get("features")]
                chosen = [c for c in cands if c.get("chosen")]
                if len(cands) < 2:
                    continue
                cherry = chosen[0]["features"] if chosen else None
                if cherry is None:
                    continue
                for c in cands:
                    if c is chosen[0]:
                        continue
                    pos.append(x_row(cherry))
                    neg.append(x_row(c["features"]))
    if not pos:
        raise ValueError("no training pairs found in traces")
    X_p = np.array(pos)
    X_n = np.array(neg)
    w = np.zeros(len(FEATURES))
    b = 0.0
    for _ in range(epochs):
        z = (X_p - X_n) @ w + 0.0
        p = 1.0 / (1.0 + np.exp(-z))
        g = (p - 1.0)
        gw = (X_p - X_n).T @ g / len(g) + l2 * w
        gb = float(np.mean(g))
        w -= lr * gw
        b -= lr * gb
    prior = Prior({k: float(v) for k, v in zip(FEATURES, w)}, b)
    prior.save(out_path)
    return {"pairs": len(pos), "weights": data_out(out_path)}


def data_out(out_path: str) -> dict:
    with open(out_path) as f:
        return json.load(f)
