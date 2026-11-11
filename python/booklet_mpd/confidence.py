"""Per-part confidence from independent cues; logistic combiner and flag threshold."""
from __future__ import annotations

import numpy as np

FEATURES = ("geometric_score", "margin", "camera_rms_ratio", "arrow_error_ratio")


def cues_from_report(report: dict, scale: float) -> dict[str, float]:
    fit = report["fit"]
    score = float(fit["geometricScore"])
    nxt = fit.get("nextDifferentBoundsScore")
    return {
        "geometric_score": score,
        "margin": 1.0 if nxt is None else score - float(nxt),
        "camera_rms_ratio": float(report["camera"]["rmsPixels"]) / scale,
        "arrow_error_ratio": float(fit.get("arrowErrorPixels", 0.0)) / scale,
    }


def _vector(cues: dict[str, float]) -> np.ndarray:
    return np.array([cues[f] for f in FEATURES], float)


def fit_combiner(rows: list[tuple[dict[str, float], bool]], l2: float = 1.0) -> dict:
    """L2-regularised logistic regression by Newton/IRLS; the bias is unpenalised."""
    if not rows:
        raise ValueError("No rows to fit")
    raw = np.array([_vector(c) for c, _ in rows])
    mean = raw.mean(0)
    std = raw.std(0)
    std[std < 1e-9] = 1.0
    X = np.hstack([(raw - mean) / std, np.ones((len(rows), 1))])
    y = np.array([1.0 if e else 0.0 for _, e in rows])
    w = np.zeros(X.shape[1])
    penalty = l2 * np.eye(X.shape[1])
    penalty[-1, -1] = 0.0
    for _ in range(50):
        p = 1 / (1 + np.exp(-np.clip(X @ w, -30, 30)))
        gradient = X.T @ (p - y) + penalty @ w
        hessian = X.T @ (X * (p * (1 - p))[:, None]) + penalty + 1e-9 * np.eye(len(w))
        step = np.linalg.solve(hessian, gradient)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return {"weights": w[:-1].tolist(), "bias": float(w[-1]), "mean": mean.tolist(), "std": std.tolist()}


def confidence(cues: dict[str, float], model: dict) -> float:
    x = (_vector(cues) - np.array(model["mean"])) / np.array(model["std"])
    z = float(x @ np.array(model["weights"]) + model["bias"])
    return float(1 / (1 + np.exp(-np.clip(z, -30, 30))))


def choose_threshold(rows: list[tuple[float, bool]], target_unflagged_exact: float = 0.9) -> float:
    """Lowest threshold whose unflagged parts (confidence >= t) are exact at the target rate."""
    for t in sorted({c for c, _ in rows}):
        kept = [e for c, e in rows if c >= t]
        if kept and sum(kept) / len(kept) >= target_unflagged_exact:
            return t
    return 1.0 + 1e-9
