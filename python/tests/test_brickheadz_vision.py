"""Vision hints (Phase 6): parsing and the no-key error path, with the network call injected."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz.vision_hints import VisionError, _parse, infer_hints


def test_missing_key_raises(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(VisionError):
        infer_hints("x.png", [(0, "Black")])


def test_parse_extracts_spec_fields():
    text = '```json\n{"hair":"cap","eyes":"none","head":4,"head_courses":4,"body_h":12,"colors":{"hair":0,"head":14,"body":4,"legs":4,"base":0},"headwear_name":"hood","face_notes":"mask","prop_name":""}\n```'
    hints = _parse(text, {0, 4, 14, 71})
    assert hints["hair"] == "cap"
    assert hints["eyes"] == "none"
    assert hints["head_courses"] == 4
    assert hints["color_head"] == 14
    assert hints["headwear_name"] == "hood"


def test_out_of_palette_colour_is_ignored():
    hints = _parse('{"colors": {"head": 999}}', {0, 4})
    assert "color_head" not in hints


def test_invalid_json_raises():
    with pytest.raises(VisionError):
        _parse("not json", {0})


def test_infer_hints_with_injected_post(tmp_path):
    image = tmp_path / "char.png"
    image.write_bytes(b"fake-image-bytes")

    captured = {}

    def post(url, headers, body, timeout):
        captured["body"] = body
        captured["headers"] = headers
        return {"content": [{"type": "text", "text": '{"hair":"flat","colors":{"body":4},"prop_name":"staff"}'}]}

    hints = infer_hints(str(image), [(0, "Black"), (4, "Red")], post=post, api_key="secret")
    assert hints["hair"] == "flat"
    assert hints["color_body"] == 4
    assert hints["prop_name"] == "staff"
    # the request carries the image and the key
    assert captured["body"]["messages"][0]["content"][0]["type"] == "image"
    assert captured["headers"]["x-api-key"] == "secret"
