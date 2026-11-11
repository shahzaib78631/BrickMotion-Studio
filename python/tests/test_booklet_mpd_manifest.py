import json

from booklet_mpd.manifest import merge_manifests


def write(path, booklets):
    path.write_text(json.dumps({"version": 1, "booklets": booklets, "errors": [{"set": "x", "error": "e"}]}))
    return path


def test_merge_keeps_first_occurrence_of_each_set_and_drops_errors(tmp_path):
    a = write(tmp_path / "a.json", [{"set": "1", "path": "a1"}, {"set": "2", "path": "a2"}])
    b = write(tmp_path / "b.json", [{"set": "2", "path": "b2"}, {"set": "3", "path": "b3"}])
    merged = merge_manifests([a, b])
    assert [(r["set"], r["path"]) for r in merged["booklets"]] == [("1", "a1"), ("2", "a2"), ("3", "b3")]
    assert "errors" not in merged and merged["version"] == 1


def test_merge_skips_a_missing_manifest(tmp_path):
    a = write(tmp_path / "a.json", [{"set": "1", "path": "a1"}])
    assert len(merge_manifests([a, tmp_path / "nope.json"])["booklets"]) == 1
