"""Per-part confidence for solver placements: logistic combiner of independent cues.

Cues come from the placer (picture score, colour and edge evidence, margin over the next pose,
float distance) and from the step registration (score, hull IoU); the pose probability is multiplied
by the parts-reading confidence (how well the callout matched its parts-list picture). The combiner is the L2 logistic regression of
`booklet_mpd.confidence`, refit on these cues over TRAIN-split teacher-forced placements only
(`fit`); the fitted model and its flag threshold ship in `confidence_model.json`.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

FEATURES = ("score", "colour", "edge", "margin", "delta", "registration", "fit_iou")
MODEL_PATH = Path(__file__).with_name("confidence_model.json")
_DEFAULT: dict | None = None


def cues(sc, result, read_confidence: float = 1.0) -> dict[str, float]:
    base = {"registration": float(result.registration), "fit_iou": float(result.fit_iou), "read": float(read_confidence)}
    if sc is None:   # the seeded first part: placed by definition, nothing to compare
        return {**base, "score": 0.0, "colour": 0.0, "edge": 0.0, "margin": 1.0, "delta": 0.0}
    return {**base, "score": float(sc.score), "colour": float(sc.colour), "edge": float(sc.edge),
            "margin": float(sc.margin), "delta": float(sc.delta)}


def _vector(c: dict) -> np.ndarray:
    v = np.array([c.get(f, 0.0) for f in FEATURES], float)
    v[FEATURES.index("margin")] = np.log1p(max(0.0, v[FEATURES.index("margin")]) * 100)
    return v


def fit(rows: list[tuple[dict, bool]], l2: float = 1.0) -> dict:
    raw = np.array([_vector(c) for c, _ in rows])
    mean, std = raw.mean(0), raw.std(0)
    std[std < 1e-9] = 1.0
    X = np.hstack([(raw - mean) / std, np.ones((len(rows), 1))])
    y = np.array([1.0 if e else 0.0 for _, e in rows])
    w = np.zeros(X.shape[1])
    penalty = l2 * np.eye(X.shape[1])
    penalty[-1, -1] = 0.0
    for _ in range(50):
        p = 1 / (1 + np.exp(-np.clip(X @ w, -30, 30)))
        step = np.linalg.solve(X.T @ (X * (p * (1 - p))[:, None]) + penalty + 1e-9 * np.eye(len(w)), X.T @ (p - y) + penalty @ w)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return {"features": list(FEATURES), "weights": w[:-1].tolist(), "bias": float(w[-1]), "mean": mean.tolist(), "std": std.tolist()}


def predict(c: dict, model: dict) -> float:
    x = (_vector(c) - np.array(model["mean"])) / np.array(model["std"])
    z = float(x @ np.array(model["weights"]) + model["bias"])
    return float(1 / (1 + np.exp(-np.clip(z, -30, 30))))


def default_model() -> dict | None:
    global _DEFAULT
    if _DEFAULT is None and MODEL_PATH.exists():
        _DEFAULT = json.loads(MODEL_PATH.read_text())
    return _DEFAULT


def part_confidence(sc, result, read_confidence: float = 1.0, model: dict | None = None) -> float:
    model = model or default_model()
    c = cues(sc, result, read_confidence)
    if model is None:   # unfitted: margin-only heuristic
        return float(min(1.0, max(0.0, c["margin"] * 10))) * float(read_confidence)
    # pose and identity treated as independent: P(exact) = P(pose | identity) * P(identity)
    return predict(c, model) * float(read_confidence)


def threshold(model: dict | None = None) -> float:
    model = model or default_model()
    return float(model.get("threshold", 0.5)) if model else 0.5


def calibration(rows: list[tuple[float, bool]], bins: int = 5) -> list[dict]:
    """Reliability table: mean predicted vs observed exact rate per confidence bin."""
    out = []
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = [(c, e) for c, e in rows if lo <= c < hi or (hi == 1 and c == 1)]
        if sel:
            out.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(sel), "predicted": float(np.mean([c for c, _ in sel])),
                        "observed": float(np.mean([e for _, e in sel]))})
    return out
