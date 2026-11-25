// The document part of the C interface: blank projects, save bytes, undo, remove, lists.
#include <catch2/catch_test_macros.hpp>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>
#include <vector>
#include "bmffi.h"

static const char* kHeliDoc = BM_REPO "/samples/helicopter/helicopter.mpd";

static BmSession* openHeli() {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, kHeliDoc);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  return s;
}

TEST_CASE("blank document is clean and saves bytes that reopen") {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_new_blank(s);
  REQUIRE(r.ok);
  bm_open_result_free(r);
  CHECK_FALSE(bm_session_dirty(s));
  CHECK_FALSE(bm_session_imported(s));
  CHECK(bm_session_piece_count(s) == 0);
  BmString bytes = bm_session_project_bytes(s);
  REQUIRE(bytes.len > 0);
  auto path = std::filesystem::temp_directory_path() /
              ("bmffi-blank-" + std::to_string(getpid()) + ".brickmotion");
  {
    std::ofstream f(path, std::ios::binary);
    f.write(bytes.ptr, static_cast<std::streamsize>(bytes.len));
  }
  bm_string_free(bytes);
  BmSession* t = bm_session_new();
  BmOpenResult r2 = bm_session_open(t, path.c_str());
  CHECK(r2.ok);
  bm_open_result_free(r2);
  bm_session_free(t);
  std::filesystem::remove(path);
  bm_session_free(s);
}

TEST_CASE("remove is one undo step") {
  BmSession* s = openHeli();
  size_t n = bm_session_piece_count(s);
  uint32_t first = 0;
  BmChange c = bm_session_remove(s, &first, 1);
  CHECK(c.refused.len == 0);
  CHECK(c.structure);
  bm_change_free(c);
  CHECK(bm_session_piece_count(s) == n - 1);
  CHECK(bm_session_dirty(s));
  CHECK(bm_session_can_undo(s));
  BmString name = bm_session_undo_name(s);
  CHECK(name.len > 0);
  bm_string_free(name);
  bm_change_free(bm_session_undo(s));
  CHECK(bm_session_piece_count(s) == n);
  CHECK(bm_session_can_redo(s));
  BmString redo = bm_session_redo_name(s);
  CHECK(redo.len > 0);
  bm_string_free(redo);
  bm_change_free(bm_session_redo(s));
  CHECK(bm_session_piece_count(s) == n - 1);
  bm_session_mark_saved(s);
  CHECK_FALSE(bm_session_dirty(s));
  bm_session_free(s);
}

TEST_CASE("remove of nothing is refused or a no-op") {
  BmSession* s = openHeli();
  uint64_t v = bm_session_version(s);
  bm_change_free(bm_session_remove(s, nullptr, 0));
  CHECK(bm_session_version(s) == v);
  bm_session_free(s);
}

TEST_CASE("outline rows and pieces of row") {
  BmSession* s = openHeli();
  BmOutline* o = bm_session_outline(s);
  REQUIRE(o);
  REQUIRE(bm_outline_len(o) >= 1);
  BmOutlineRow root = bm_outline_row(o, 0);
  CHECK(std::string(root.id) == "root");
  CHECK(root.depth == 0);
  CHECK(root.parent == -1);
  bm_outline_free(o);
  size_t n = bm_session_pieces_of_row(s, "root", nullptr, 0);
  CHECK(n == bm_session_piece_count(s));
  std::vector<uint32_t> pieces(n);
  CHECK(bm_session_pieces_of_row(s, "root", pieces.data(), pieces.size()) == n);
  uint64_t sv = bm_session_structure_version(s);
  uint32_t first = 0;
  bm_change_free(bm_session_remove(s, &first, 1));
  CHECK(bm_session_structure_version(s) != sv);
  bm_session_free(s);
}

TEST_CASE("snapshot follows selection") {
  BmSession* s = openHeli();
  uint32_t two[] = {0, 1};
  bm_session_select(s, two, 2, BM_SELECT_REPLACE);
  BmSnapshot* snap = bm_session_snapshot(s);
  REQUIRE(snap);
  BmSnapshotInfo info = bm_snapshot_info(snap);
  CHECK(info.selected == 2);
  CHECK(info.pieces == bm_session_piece_count(s));
  REQUIRE(bm_snapshot_piece_len(snap) == 2);
  BmPieceInfo p = bm_snapshot_piece(snap, 0);
  CHECK(std::string(p.part).size() > 0);
  bm_snapshot_free(snap);

  bm_session_select_all(s);
  CHECK(bm_session_selection(s, nullptr, 0) == bm_session_piece_count(s));
  bm_session_hide(s, two, 2);
  snap = bm_session_snapshot(s);
  CHECK(bm_snapshot_info(snap).hidden == 2);
  bm_snapshot_free(snap);
  bm_session_show_all(s);
  bm_session_select_none(s);
  CHECK(bm_session_selection(s, nullptr, 0) == 0);
  bm_session_free(s);
}

TEST_CASE("colours list") {
  BmSession* s = openHeli();
  BmColors* c = bm_colors(s);
  REQUIRE(c);
  CHECK(bm_colors_len(c) > 10);
  BmColor first = bm_colors_at(c, 0);
  CHECK(std::string(first.name).size() > 0);
  bm_colors_free(c);
  bm_session_free(s);
}

TEST_CASE("imported ldraw") {
  BmSession* s = openHeli();
  CHECK(bm_session_imported(s));
  bm_session_free(s);
}

TEST_CASE("struct sizes") {
  CHECK(bm_struct_size("BmOutlineRow") == sizeof(BmOutlineRow));
  CHECK(bm_struct_size("BmPieceInfo") == sizeof(BmPieceInfo));
  CHECK(bm_struct_size("BmSnapshotInfo") == sizeof(BmSnapshotInfo));
  CHECK(bm_struct_size("BmColor") == sizeof(BmColor));
  CHECK(bm_struct_size("BmChange") == sizeof(BmChange));
  CHECK(bm_struct_size("BmOpenResult") == sizeof(BmOpenResult));
  CHECK(bm_struct_size("BmString") == sizeof(BmString));
  CHECK(bm_struct_size("nope") == 0);
  CHECK(bm_struct_size(nullptr) == 0);
}
