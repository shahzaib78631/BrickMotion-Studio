"""Vision hints: ask a vision model for the design choices a photo implies.

Feeds the ``hints`` that ``image_spec.spec_from_image`` merges over the offline
colour analysis — hair style, eyes, head size, proportions and colours — so those
are inferred from the photo instead of passed by hand. Uses the Anthropic Messages
API over plain HTTP (no new dependency); the network call is injectable so it is
testable without a key.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request

API = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = os.environ.get("BRICKHEADZ_VISION_MODEL", "claude-sonnet-5-5")
HAIR = ("none", "flat", "cap")
EYES = ("round", "none")
BODY_HEIGHTS = (6, 9, 12, 15)


class VisionError(RuntimeError):
    pass


def _image_block(path: str) -> dict:
    media = mimetypes.guess_type(path)[0] or "image/png"
    data = base64.b64encode(open(path, "rb").read()).decode("ascii")
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}


def _prompt(palette: list[tuple[int, str]]) -> str:
    colours = ", ".join(f"{code} {name}" for code, name in palette) or "(none)"
    return f"""You are a LEGO BrickHeadz analyst. Look at this single front photo and describe the character as a compact JSON design spec.

Output ONLY a JSON object (no prose, no code fences) with exactly these keys:
- "hair": one of {list(HAIR)} — headwear/hair volume (flat cap, a raised cap, or bare)
- "eyes": one of {list(EYES)} — round eyes or none
- "head": 4 or 6 — the head's footprint width in studs
- "head_courses": 2, 3 or 4 — how many 5-plate courses tall the head is
- "body_h": one of {list(BODY_HEIGHTS)} — torso height in plates
- "colors": an object with keys "hair","head","body","legs","base"; each value MUST be one colour code chosen from this list (number only): {colours}
- "headwear_name": short free text naming the headwear/hair (e.g. "hood", "long hair", "helmet")
- "face_notes": short free text describing the face (e.g. "mask with white eye patches", "toothy grin")
- "prop_name": short free text for a held prop, or "" if none

Pick colours only from the list. Prefer 4 for the head unless the head is clearly much wider than the body."""


def _post(url: str, headers: dict, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise VisionError(f"vision API error {exc.code}: {exc.read()[:200]!r}") from exc
    except urllib.error.URLError as exc:
        raise VisionError(f"network error: {exc}") from exc


def _parse(text: str, palette_codes: set[int]) -> dict:
    body = text.strip()
    if body.startswith("```"):
        body = body.strip("`")
        if body.lower().startswith("json"):
            body = body[4:]
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise VisionError(f"vision model did not return JSON: {text[:200]!r}") from exc
    if not isinstance(data, dict):
        raise VisionError("vision model returned non-object JSON")

    hints: dict = {}
    if data.get("hair") in HAIR:
        hints["hair"] = data["hair"]
    if data.get("eyes") in EYES:
        hints["eyes"] = data["eyes"]
    if data.get("head") in (4, 6):
        hints["head"] = data["head"]
    if data.get("head_courses") in (2, 3, 4):
        hints["head_courses"] = data["head_courses"]
    if data.get("body_h") in BODY_HEIGHTS:
        hints["body_h"] = data["body_h"]
    colors = data.get("colors") or {}
    for src, field in (("hair", "color_hair"), ("head", "color_head"), ("body", "color_body"), ("legs", "color_leg"), ("base", "color_base")):
        try:
            code = int(colors.get(src))
        except (TypeError, ValueError):
            continue
        if code in palette_codes:
            hints[field] = code
    for src, field in (("headwear_name", "headwear_name"), ("face_notes", "face_notes"), ("prop_name", "prop_name")):
        if isinstance(data.get(src), str):
            hints[field] = data[src].strip()
    return hints


def infer_hints(image: str, palette: list[tuple[int, str]], model: str | None = None, post=None, api_key: str | None = None, timeout: float = 60.0) -> dict:
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise VisionError("set ANTHROPIC_API_KEY (or pass api_key) to use --vision")
    body = {
        "model": model or DEFAULT_MODEL,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": [_image_block(image), {"type": "text", "text": _prompt(palette)}]}],
    }
    response = (post or _post)(API, {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}, body, timeout)
    text = "".join(block.get("text", "") for block in response.get("content", []) if block.get("type") == "text")
    return _parse(text, {code for code, _ in palette})
