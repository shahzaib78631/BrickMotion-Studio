"""Autonomous BrickLayer-Agent: Hierarchical Programmatic LEGO MOC Builder + Visual Critic Loop.

Turns any text prompt (+ optional reference image) into a certified 80-220+ piece human-grade LEGO MOC:
  1. Plans 4-6 structural sub-assemblies with exact stud/plate budgets.
  2. Writes a `def build(b: BrickBuild):` program using BrickLayer-Studio (`place`, `place_sym`, `snap`).
  3. Executes against native C++ `libbmcore` for millisecond exact collision, connectivity, and stability checks.
  4. Feeds exact collision / disconnected-brick diagnostics back for surgical fixes (anti-mirage best-state tracking).
  5. Renders a 4-view Apple Metal `bmshot` inspection sheet (+ reference image) and runs visual polish rounds!

Backends:
  - `claude-cli`: uses local `claude -p` (user's existing Claude login, zero API key needed, supports viewing PNG renders!)
  - `anthropic`:  direct Anthropic Messages API via stdlib urllib (`ANTHROPIC_API_KEY`)
  - `openai`:     direct OpenAI Responses/Chat API via stdlib urllib (`OPENAI_API_KEY`)
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np

from .bricklayer import COLORS, BrickBuild, ValidationReport

SHOWCASE_DIR = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/bricklayer_showcase")
CODE_BLOCK_RE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)

SYSTEM_PROMPT = """You are a master LEGO MOC designer writing Python code for BrickLayer-Studio (`BrickBuild`), backed by a native C++ exact mesh collision, typed connector, and physical stability engine (`libbmcore`) + Apple Metal renderer (`bmshot`).

Write ONLY a single ```python code block defining `def build(b: BrickBuild) -> None:` (no imports needed; `math` is available).

### BrickBuild API (Y-Up Stud / Plate Coordinates)
- `x, z` in **STUDS** (1 stud = 20 LDU; X = right, Z = front/+forward; symmetry plane is `X = 0`).
- `y` in **PLATES** (1 plate = 8 LDU; 1 standard brick = 3 plates; `y = 0` is the ground plane).
- `b.step(name)` — starts a named sub-assembly (`0 STEP` in LDraw).
- `b.place(part, color, x=0, y=0, z=0, yaw=0, pitch=0, roll=0, studs_dir=None, ground="bottom", tag="")`
  - `ground="bottom"` places the part's rotated lowest bottom at exact `y` plates.
  - Raises `ValueError("Collision ...")` immediately on any mesh overlap!
- `b.place_sym(part, color, x, y, z, yaw=0, ...)` — places at `(+x, y, z)` AND its exact chiral/geometric mirror at `(-x, y, z)` (`x` must be non-zero!).
- `b.snap(part, color, on=entry_or_tag, near=(x, y, z), studs_dir=None, kind=None, mirror_x=False, tag="")`
  - Queries `libbmcore` for exact typed connector snaps (`kind`: `"stud"`, `"technic"`, `"non_stud"`, `"clip"`, `"hinge"`).
- `b.checkpoint()` / `b.rollback(ckpt)` / `b.pop()` — undo failed placements cleanly.

### CRITICAL LEGO STUD-GRID PARITY RULE (NEVER VIOLATE!)
For a model centered on `X = 0`, `Z = 0`:
- **EVEN-stud dimension** (2, 4, 6, 8 studs) along an axis → center on an **INTEGER** (`0, ±1.0, ±2.0, ±3.0...`).
  Example: `3020` (4×2, `yaw=0`) at `x=0, z=1.0` spans `x=[-2..+2], z=[0..2]`.
- **ODD-stud dimension** (1, 3, 5 studs) along an axis → center on a **HALF-INTEGER** (`±0.5, ±1.5, ±2.5, ±3.5...`).
  Example: `3023` (2×1, `yaw=90` → 1 wide X × 2 deep Z) MUST use `x=±1.5` (half-integer!), `z=0.0` (integer!).
- Violating parity causes a 0.5-stud offset and immediate stud collision!

### Verified Local Parts & Exact Orientations
- **Plates (1 plate tall)**: `3024`(1x1), `3023`(2x1), `3623`(3x1), `3710`(4x1), `3666`(6x1), `3460`(8x1), `3022`(2x2), `3021`(3x2), `3020`(4x2), `3795`(6x2), `3034`(8x2), `3031`(4x4), `3032`(6x4), `3035`(8x4), `3036`(8x6).
- **Bricks (3 plates tall)**: `3005`(1x1), `3004`(2x1), `3622`(3x1), `3010`(4x1), `3009`(6x1), `3008`(8x1), `3003`(2x2), `3002`(3x2), `3001`(4x2), `98283`(2x1 embossed masonry), `3062b`(1x1 round brick).
- **Smooth Tiles (1 plate tall)**: `3070b`(1x1), `3069b`(2x1), `63864`(3x1), `2431`(4x1), `6636`(6x1), `3068b`(2x2), `87079`(4x2), `2412b`(2x1 grille tile), `98138`(1x1 round tile), `6141`(1x1 round plate).
- **Slopes**:
  - `11477` (1x2 curved slope, 2p tall) & `15068` (2x2 curved slope, 2p tall): **`yaw=180` slopes down toward `+Z` (front); `yaw=0` slopes down toward `-Z` (back)**. Stud sockets sit at the high end (`z = center - 0.5` when `yaw=0`, `center + 0.5` when `yaw=180`).
  - `54200` (1x1 cheese slope, 2p tall), `3040b` (1x2 45° slope, 3p), `3039` (2x2 45° slope, 3p), `3037` (4x2 45° slope, 3p): **`yaw=180` slopes down toward `+Z`; `yaw=0` slopes down toward `-Z`**.
  - `3044c` (1x2 double 45° roof ridge, 3p), `3665` (1x2 inverted 45° corbel, 3p), `3660` (2x2 inverted 45° corbel, 3p): `yaw=180` flares toward `+Z`, `yaw=0` toward `-Z`, `yaw=270` toward `+X`.
- **Vehicles**:
  - `30157` (2x6 stub axle): place at `y=2.75`, then `w1, _ = b.snap("18976", "silver", on=ax, near=(3.2, 3.5, z), kind="technic", mirror_x=True)` and `b.snap("18977", "black", on=w1, near=(3.2, 3.5, z), kind="non_stud", mirror_x=True)`. Tyres touch `y=0` and occupy `x=±[2.4..3.8], z=[z-1.5..z+1.5], y=[0..7.5]p`; keep chassis spine 4-wide (`x=[-2..+2]`) at `y=5..7` between wheel wells, widen to 8-wide at `y=8+` above tyres!
  - `65633` (6x6 Speed Champions angled windscreen, 4p tall): `yaw=180` faces `+Z`, mates at front cowl `z_center + 2.5`, roof top at `y + 4, z_center - 2.5`.
  - `62360` (6x3 curved windscreen, 3p tall).
- **Architecture & Details**:
  - `6182` (4x1x2 stone arch, 6p tall), `4490` (3x1 arch, 3p), `60592` (2x1x2 window frame, 6p) + `b.snap("60601", "trans_yellow", on=win, kind="non_stud")`, `3957` (gold flagpole, 12p) + `b.snap("4495", "red", on=pole, kind="non_stud")`.
- **SNOT Bricks**:
  - `22885` (2x1x1.667, 5p tall, 4 side studs facing local `-Z`: `yaw=180`→`+Z`, `yaw=0`→`-Z`, `yaw=270`→`+X`), `87087` (1x1, 3p tall, 1 side stud facing `-Z`). Use `b.snap(..., on="snot_tag", studs_dir="+z")` to attach face/panel tiles cleanly!

### Colors Available
""" + ", ".join(sorted(COLORS.keys())) + """

### Quality Bar (Human-Built LEGO MOC Standard)
- Target **60–160 parts** across 4–6 clean `b.step(...)` sub-assemblies.
- **100% physically certified**: `overlaps == 0`, `groups == 1` (EVERY piece structurally interlocked!), `stands == True`, high bilateral symmetry (`>= 90%` for symmetric subjects).
- Use diverse authentic shapes (slopes, curved slopes, arches, tiles, translucent lights/glass, wheels/SNOT) — NEVER plain monochrome voxel boxes!
"""


def _extract_code(text: str) -> str:
    m = CODE_BLOCK_RE.search(text)
    if m:
        return m.group(1).strip()
    if "def build(" in text:
        return text[text.index("def build(") :].strip()
    raise ValueError("LLM response did not contain a ```python code block with `def build(b):`.")


def _find_disconnected_details(b: BrickBuild) -> list[str]:
    """Identify singleton/small disconnected bricks via native leave-one-out check for crisp agent repair feedback."""
    full = b.native.check()
    if full.groups <= 1 or len(b.bricks) > 260:
        return []
    # Quick incremental scan: bricks that increase group count and never merge back, or singleton removals
    offenders: list[str] = []
    # Check in reverse order (most disconnected pieces are late details/roof/wings!)
    from .native import BrickGenNative

    nat = BrickGenNative(use_studio=True)
    try:
        for i in range(len(b.bricks) - 1, -1, -1):
            nat.reset()
            for j, br in enumerate(b.bricks):
                if j != i:
                    nat.add(br.part, br.color, br.matrix)
            if nat.check().groups < full.groups:
                br = b.bricks[i]
                bb = br.bbox_yup
                offenders.append(
                    f"#{br.idx}:{br.part}(tag='{br.tag}', step='{br.step_name}') "
                    f"x=[{bb[0]/20:.1f}..{bb[3]/20:.1f}s] y=[{bb[1]/8:.1f}..{bb[4]/8:.1f}p] z=[{bb[2]/20:.1f}..{bb[5]/20:.1f}s]"
                )
                if len(offenders) >= 8:
                    break
    finally:
        nat.close()
    return offenders


def execute_bricklayer_script(
    code: str,
    title: str,
    prompt: str,
) -> tuple[BrickBuild | None, ValidationReport | None, str | None]:
    """Execute `def build(b):` in a safe restricted namespace against native C++ `libbmcore`."""
    safe_builtins = {
        "range": range,
        "len": len,
        "int": int,
        "float": float,
        "str": str,
        "bool": bool,
        "list": list,
        "tuple": tuple,
        "dict": dict,
        "set": set,
        "abs": abs,
        "min": min,
        "max": max,
        "round": round,
        "sum": sum,
        "enumerate": enumerate,
        "zip": zip,
        "sorted": sorted,
        "reversed": reversed,
        "any": any,
        "all": all,
        "isinstance": isinstance,
        "Exception": Exception,
        "ValueError": ValueError,
        "RuntimeError": RuntimeError,
        "print": lambda *a, **k: None,
    }
    ns: dict = {"__builtins__": safe_builtins, "math": math, "BrickBuild": BrickBuild}
    try:
        exec(compile(code, "<bricklayer_agent>", "exec"), ns, ns)
    except Exception as exc:
        return None, None, f"Syntax/compile error: {exc}"
    fn = ns.get("build")
    if not callable(fn):
        return None, None, "Script must define `def build(b: BrickBuild) -> None:`."

    b = BrickBuild(title=title, prompt=prompt)
    try:
        fn(b)
        rep = b.validate()
        return b, rep, None
    except Exception as exc:
        err = f"Runtime/placement error after {len(b.bricks)} bricks (step='{b._current_step}'): {exc}"
        b.close()
        return None, None, err


def _detect_backend(preferred: str = "auto") -> str:
    if preferred != "auto":
        return preferred
    if shutil.which("claude"):
        return "claude-cli"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    raise RuntimeError(
        "No LLM backend found. Install/sign in to `claude` CLI, or set ANTHROPIC_API_KEY or OPENAI_API_KEY."
    )


def _call_llm(
    backend: str,
    user_prompt: str,
    image_paths: list[Path] | None = None,
    model: str | None = None,
    timeout_s: int = 300,
) -> str:
    images = [p for p in (image_paths or []) if p.exists()]

    if backend == "claude-cli":
        cli_model = model or "sonnet"
        full_prompt = user_prompt
        args = [
            "claude",
            "-p",
            "--model",
            cli_model,
            "--system-prompt",
            SYSTEM_PROMPT,
            "--no-session-persistence",
        ]
        if images:
            # Allow Read tool strictly so Claude CLI can visually inspect reference & 4-view Metal bmshot PNGs!
            args += ["--allowedTools", "Read", "--permission-mode", "bypassPermissions"]
            img_lines = "\n".join(f"- {p.resolve()}" for p in images)
            full_prompt = (
                f"First use the Read tool to inspect these image(s) carefully:\n{img_lines}\n\n"
                + user_prompt
            )
        else:
            args += ["--tools", "", "--strict-mcp-config", "--setting-sources", ""]
        res = subprocess.run(
            args,
            input=full_prompt,
            text=True,
            capture_output=True,
            timeout=timeout_s,
            cwd=tempfile.gettempdir(),
        )
        if res.returncode != 0:
            raise RuntimeError(f"claude CLI failed ({res.returncode}): {res.stderr.strip()[:500]}")
        return res.stdout

    if backend == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        content: list[dict] = []
        for p in images:
            mime = "image/jpeg" if p.suffix.lower() in (".jpg", ".jpeg") else "image/png"
            b64 = base64.b64encode(p.read_bytes()).decode("ascii")
            content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}})
        content.append({"type": "text", "text": user_prompt})
        body = json.dumps(
            {
                "model": model or "claude-sonnet-4-20250514",
                "max_tokens": 6000,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": content}],
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return "\n".join(blk.get("text", "") for blk in data.get("content", []) if blk.get("type") == "text")

    if backend == "openai":
        key = os.environ.get("OPENAI_API_KEY", "")
        if not key:
            raise RuntimeError("OPENAI_API_KEY not set")
        content = [{"type": "text", "text": user_prompt}]
        for p in images:
            mime = "image/jpeg" if p.suffix.lower() in (".jpg", ".jpeg") else "image/png"
            b64 = base64.b64encode(p.read_bytes()).decode("ascii")
            content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
        body = json.dumps(
            {
                "model": model or "gpt-4.1",
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": content},
                ],
                "max_tokens": 6000,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]

    raise ValueError(f"Unknown backend: {backend}")


def agent_build(
    prompt: str,
    out_ldr: Path,
    out_png: Path | None = None,
    image_ref: Path | None = None,
    rounds: int = 4,
    polish_rounds: int = 1,
    backend: str = "auto",
    model: str | None = None,
    title: str | None = None,
) -> dict:
    """Run the autonomous BrickLayer-Agent synthesize -> libbmcore verify -> Metal render -> visual polish loop."""
    t0 = time.time()
    be = _detect_backend(backend)
    title = title or prompt.strip()[:48].title()
    out_ldr = Path(out_ldr)
    out_png = Path(out_png) if out_png is not None else out_ldr.with_suffix(".png")
    out_ldr.parent.mkdir(parents=True, exist_ok=True)
    out_png.parent.mkdir(parents=True, exist_ok=True)

    best_score = (-1, -1, -1, -1, -1.0, -1)
    best_ldr: str | None = None
    best_code: str | None = None
    best_rep: ValidationReport | None = None
    polished = 0
    last_code: str | None = None
    feedback = ""
    last_sheet: Path | None = None

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for rnd in range(1, rounds + 1):
            imgs: list[Path] = []
            if image_ref is not None and Path(image_ref).exists():
                imgs.append(Path(image_ref))

            if rnd == 1 or last_code is None:
                user_msg = (
                    f"Design and build a human-grade LEGO MOC for:\n\"{prompt}\"\n\n"
                    f"Requirements:\n"
                    f"1. Decompose into 4-6 clear `b.step(...)` sub-assemblies.\n"
                    f"2. Strictly obey stud-grid parity (even widths on integer coords, odd widths on half-integer coords).\n"
                    f"3. Ensure EVERY brick connects into ONE rigid component (`groups == 1`), `overlaps == 0`, and `stands == True`.\n"
                    f"4. Return ONLY the ```python block containing `def build(b: BrickBuild) -> None:`."
                )
            else:
                if last_sheet is not None and last_sheet.exists():
                    imgs.append(last_sheet)
                user_msg = (
                    f"Goal: \"{prompt}\"\n\n"
                    f"Previous script:\n```python\n{last_code}\n```\n\n"
                    f"Feedback from native C++ `libbmcore` + Metal 4-view render:\n{feedback}\n\n"
                    f"Return the COMPLETE fixed/polished `def build(b: BrickBuild) -> None:` inside a single ```python block."
                )

            print(f"[BrickLayer-Agent round {rnd}/{rounds} | backend={be}] querying LLM...", flush=True)
            raw = _call_llm(be, user_msg, image_paths=imgs, model=model)
            try:
                code = _extract_code(raw)
            except Exception as exc:
                feedback = str(exc)
                print(f"  Parse error: {exc}", flush=True)
                continue
            last_code = code

            b, rep, err = execute_bricklayer_script(code, title=title, prompt=prompt)
            if err is not None or b is None or rep is None:
                feedback = f"EXECUTION FAILED:\n{err}\nFix the exact colliding/invalid placement while keeping all other sub-assemblies intact."
                print(f"  Round {rnd} error: {err}", flush=True)
                continue

            try:
                c = rep.check
                sc = (
                    int(c.certified),
                    int(c.overlaps == 0),
                    int(c.groups == 1),
                    int(c.stands),
                    1 if rep.symmetry_score >= 0.85 else round(rep.symmetry_score, 2),
                    c.pieces,
                )
                print(f"  Round {rnd}: {rep.summary().splitlines()[0]} | sym={rep.symmetry_score*100:.0f}%", flush=True)
                sheet_p = tdp / f"round_{rnd}.png"
                try:
                    b.render_sheet(sheet_p, size=384, ref_image=image_ref)
                    last_sheet = sheet_p
                except Exception:
                    last_sheet = None

                if sc > best_score:
                    best_score = sc
                    best_ldr = b.to_ldr()
                    best_code = code
                    best_rep = rep
                    if last_sheet is not None and last_sheet.exists():
                        shutil.copy2(last_sheet, out_png)

                if c.certified:
                    if polished >= polish_rounds or rnd == rounds:
                        break
                    polished += 1
                    feedback = (
                        f"STRUCTURALLY CERTIFIED ({c.pieces} parts, overlaps=0, groups=1, stands=True, sym={rep.symmetry_score*100:.0f}%).\n"
                        f"Inspect the rendered 4-view Metal sheet carefully (and the reference image if provided). "
                        f"Fix any inverted slope directions, awkward overhangs, missing details, or blocky surfaces so it looks 100% like an official LEGO set, "
                        f"while keeping overlaps=0, groups=1, and stands=True!"
                    )
                else:
                    disc = _find_disconnected_details(b) if c.groups > 1 else []
                    disc_txt = ("\nDisconnected singleton bricks:\n  - " + "\n  - ".join(disc)) if disc else ""
                    feedback = (
                        f"VALIDATION FAILED:\n{rep.summary()}{disc_txt}\n"
                        f"Fix every disconnected brick and stability issue so overlaps=0, groups=1, stands=True."
                    )
            finally:
                b.close()

    if best_ldr is None or best_rep is None:
        raise RuntimeError(f"BrickLayer-Agent did not produce a valid build after {rounds} rounds. Last feedback: {feedback}")

    out_ldr.write_text(best_ldr)
    if best_code is not None:
        out_ldr.with_suffix(".py").write_text(best_code + "\n")
    c = best_rep.check
    result = {
        "ok": True,
        "certified": c.certified,
        "pieces": c.pieces,
        "overlaps": c.overlaps,
        "groups": c.groups,
        "stands": c.stands,
        "margin": round(c.margin, 1),
        "symmetry": best_rep.symmetry_score,
        "span_studs": best_rep.span_studs,
        "ldr": str(out_ldr),
        "png": str(out_png) if out_png.exists() else None,
        "seconds": round(time.time() - t0, 1),
    }
    print(f"BrickLayer-Agent finished: {result}", flush=True)
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description="Autonomous BrickLayer-Agent: Text/Image -> Certified Human-Grade LEGO MOC.")
    ap.add_argument("prompt", type=str)
    ap.add_argument("--image-ref", type=Path, default=None, help="Optional reference image (.png/.jpg)")
    ap.add_argument("--out", type=Path, default=SHOWCASE_DIR / "agent_moc.ldr")
    ap.add_argument("--render", type=Path, default=None, help="Output 4-view Metal PNG sheet path")
    ap.add_argument("--rounds", type=int, default=4)
    ap.add_argument("--polish-rounds", type=int, default=1)
    ap.add_argument("--backend", choices=["auto", "claude-cli", "anthropic", "openai"], default="auto")
    ap.add_argument("--model", type=str, default=None)
    a = ap.parse_args()
    agent_build(
        prompt=a.prompt,
        out_ldr=a.out,
        out_png=a.render,
        image_ref=a.image_ref,
        rounds=a.rounds,
        polish_rounds=a.polish_rounds,
        backend=a.backend,
        model=a.model,
    )


if __name__ == "__main__":
    main()
