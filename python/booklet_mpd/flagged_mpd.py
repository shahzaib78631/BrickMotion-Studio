"""Write a reconstructed MPD whose uncertain parts and steps are flagged in comments."""
from __future__ import annotations

from pathlib import Path


def _line(part: str, colour: int, matrix) -> str:
    values = (*matrix[:3, 3], *matrix[:3, :3].ravel())
    return f"1 {colour} " + " ".join(f"{v:.6g}" for v in values) + f" {part}.dat"


def write_flagged_mpd(path: Path, name: str, groups, confidences: list[list[float]], threshold: float,
                      failed_from_step: int | None = None) -> dict:
    lines = [f"0 FILE {name}.ldr", "0 Reconstructed from instruction images; experimental"]
    parts = flagged = 0
    steps_flagged: list[int] = []
    for number, (group, confs) in enumerate(zip(groups, confidences), start=1):
        low = [c < threshold for c in confs]
        if any(low):
            steps_flagged.append(number)
            lines.append(f"0 // BRICKMOTION STEP_FLAGGED {number}")
        for (part, colour, matrix), conf, is_low in zip(group, confs, low):
            if is_low:
                lines.append(f"0 // BRICKMOTION FLAG confidence={conf:.2f}")
                flagged += 1
            lines.append(_line(part, colour, matrix))
            parts += 1
        lines.append("0 STEP")
    if failed_from_step is not None:
        lines.append(f"0 // BRICKMOTION INCOMPLETE from step {failed_from_step}")
    lines.append("0 NOFILE")
    Path(path).write_text("\n".join(lines) + "\n")
    return {"parts": parts, "flagged": flagged, "steps_flagged": steps_flagged}
