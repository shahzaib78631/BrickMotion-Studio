#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include "bmapp/inventory_import.h"
#include "bmapp/session.h"
#include "session_impl.h"

namespace {

namespace fs = std::filesystem;

struct InventoryFile {
  fs::path path;
  InventoryFile(const char* extension, const char* bytes) {
    const auto tick = std::chrono::steady_clock::now().time_since_epoch().count();
    path = fs::temp_directory_path() / ("brickmotion-inventory-" + std::to_string(tick) + extension);
    std::ofstream stream(path, std::ios::binary);
    stream << bytes;
  }
  ~InventoryFile() {
    std::error_code error;
    fs::remove(path, error);
  }
};

using Draft = std::unique_ptr<bmapp::InventoryImport, decltype(&bmappReleaseInventoryImport)>;

Draft capture(bmapp::Session& session, int step) {
  return {bmapp::InventoryImport::capture(&session, step), bmappReleaseInventoryImport};
}

}  // namespace

TEST_CASE("CSV imports available inventory in one undo step and leaves spares out", "[bmapp][inventory]") {
  bmapp::Session session;
  const auto model = fs::path(BM_FIXTURES) / "models" / "tower.plan.json";
  REQUIRE(session.open(model.string()).ok);
  auto& backing = session.impl();
  const auto assembly = backing.model->bounds(*backing.full);
  const auto count = session.pieceCount();
  const auto before = session.planBytes();
  const InventoryFile file(".csv",
      "\xef\xbb\xbf\"Quantity\",Color,Part,Is Spare\r\n"
      "2,4,\"3001.DAT\",False\r\n"
      "1,4,3001,false\r\n"
      "1,14,3022,false\r\n"
      "5,7,3022,yes\r\n"
      "2,4,brickmotion_unknown_part,false\r\n"
      "two,4,3001,false\r\n");
  const auto draft = capture(session, 0);
  REQUIRE(draft);
  const auto preview = draft->prepare(file.path.string());
  REQUIRE(preview.error.empty());
  CHECK(preview.pieces == 4);
  CHECK(preview.spares == 5);
  CHECK(preview.invalidRows == 1);
  CHECK(preview.missing == std::vector<std::string>{"brickmotion_unknown_part.dat"});
  CHECK(session.planBytes() == before);
  const auto depth = session.undoDepth();
  REQUIRE(session.importInventory(draft.get()).structure);
  CHECK(session.pieceCount() == count + 4);
  CHECK(session.undoDepth() == depth + 1);
  CHECK(session.undoName() == "Import 4 Pieces");
  REQUIRE(session.selection().size() == 4);
  size_t red = 0, yellow = 0;
  std::vector<bm::Box> boxes;
  for (uint32_t index : session.selection()) {
    const auto& piece = backing.model->pieces()[index];
    CHECK(piece.step == 0);
    red += piece.part == "3001.dat" && piece.color == 4;
    yellow += piece.part == "3022.dat" && piece.color == 14;
    const auto box = backing.model->mesh(piece.part, *backing.full)->bounds.transformed(piece.world);
    CHECK(box.min.x > assembly.max.x);
    CHECK(box.max.y == assembly.max.y);
    for (const auto& other : boxes) {
      CHECK((box.max.x < other.min.x || box.min.x > other.max.x ||
             box.max.z < other.min.z || box.min.z > other.max.z));
    }
    boxes.push_back(box);
  }
  CHECK(red == 3);
  CHECK(yellow == 1);
  const auto after = session.planBytes();
  session.undo();
  CHECK(session.planBytes() == before);
  session.redo();
  CHECK(session.planBytes() == after);
}

TEST_CASE("PBG uses the item section and rejects an outdated destination", "[bmapp][inventory]") {
  bmapp::Session session;
  REQUIRE(session.open((fs::path(BM_FIXTURES) / "models" / "tower.plan.json").string()).ok);
  const InventoryFile file(".pbg",
      "[options]\ncaption=Bin study\n"
      "<items>\n3001.dat:[sourceInv=ABC] [Color=4] [Count=2]\n"
      "3022.dat: [color=14]\n</items>\n3022.dat:[color=7] [count=99]\n");
  const auto draft = capture(session, -1);
  REQUIRE(draft);
  const auto preview = draft->prepare(file.path.string());
  REQUIRE(preview.error.empty());
  CHECK(preview.pieces == 3);
  CHECK(preview.invalidRows == 0);
  session.move({0}, {20, 0, 0}, false);
  const auto count = session.pieceCount();
  const auto depth = session.undoDepth();
  const auto result = session.importInventory(draft.get());
  CHECK_FALSE(result.refused.empty());
  CHECK(session.undoDepth() == depth);
  CHECK(session.pieceCount() == count);
}

TEST_CASE("an unrecognised CSV title line is not reported as an unreadable part", "[bmapp][inventory]") {
  bmapp::Session session;
  REQUIRE(session.open((fs::path(BM_FIXTURES) / "models" / "tower.plan.json").string()).ok);
  const InventoryFile file(".csv", "Part Number,Colour Code,Count\n3001,4,2\n3022,14,x\n");
  const auto draft = capture(session, -1);
  REQUIRE(draft);
  const auto preview = draft->prepare(file.path.string());
  REQUIRE(preview.error.empty());
  CHECK(preview.pieces == 2);
  CHECK(preview.invalidRows == 1);
}
