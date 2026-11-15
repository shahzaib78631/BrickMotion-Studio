#include <catch2/catch_test_macros.hpp>
#include <random>
#include <string>
#include "bm/ldraw/parse.h"

using namespace bm::ldraw;

TEST_CASE("a part reference carries colour, position and name", "[ldraw][parse]") {
  const File f = parse("0 A model\n1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n", "Main.LDR");
  REQUIRE(f.name == "main.ldr");
  REQUIRE(f.description == "A model");
  REQUIRE(f.cmds.size() == 1);
  const Command& c = f.cmds[0];
  REQUIRE(c.type == Cmd::Ref);
  REQUIRE(c.color == 4);
  REQUIRE(c.file == "3001.dat");
  REQUIRE((c.xf.t.x == 0 && c.xf.t.y == -24 && c.xf.t.z == 0));
  REQUIRE(c.xf.r.m[0] == 1);
  REQUIRE(c.xf.r.m[4] == 1);
  REQUIRE(f.skipped == 0);
}

TEST_CASE("names keep spaces and are normalised", "[ldraw][parse]") {
  const File f = parse("1 4 0 0 0 1 0 0 0 1 0 0 0 1 s\\My Part.DAT\n");
  REQUIRE(f.cmds.at(0).file == "s/my part.dat");
  REQUIRE(normalizeName("  Parts\\S\\3001S01.DAT ") == "parts/s/3001s01.dat");
}

TEST_CASE("CRLF input parses like LF input", "[ldraw][parse]") {
  const std::string lf = "0 Thing\n1 1 1 2 3 1 0 0 0 1 0 0 0 1 a.dat\n0 STEP\n3 16 0 0 0 1 0 0 0 1 0\n";
  std::string crlf;
  for (char ch : lf) { if (ch == '\n') crlf += '\r'; crlf += ch; }
  const File a = parse(lf), b = parse(crlf);
  REQUIRE(a.description == b.description);
  REQUIRE(a.cmds.size() == b.cmds.size());
  REQUIRE(b.cmds.at(0).file == "a.dat");
  REQUIRE(b.cmds.at(2).type == Cmd::Tri);
}

TEST_CASE("INVERTNEXT marks the next reference only", "[ldraw][parse]") {
  const File f = parse("0 x\n0 BFC INVERTNEXT\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.dat\n");
  REQUIRE(f.cmds.size() == 2);
  REQUIRE(f.cmds[0].invert);
  REQUIRE_FALSE(f.cmds[1].invert);
}

TEST_CASE("meta commands: STEP, BFC, category, help, groups", "[ldraw][parse]") {
  const File f = parse(
      "0 Brick\n0 !CATEGORY Brick Special\n0 !HELP Use with care\n0 BFC CERTIFY CW\n0 BFC NOCLIP\n0 BFC CCW CLIP\n"
      "0 STEP\n0 MLCAD BTG Wheels\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n"
      "0 !LEOCAD GROUP BEGIN Door\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.dat\n0 !LEOCAD GROUP END\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 c.dat\n"
      "2 24 0 0 0 1 1 1\n4 16 0 0 0 1 0 0 1 1 0 0 1 0\n5 24 0 0 0 1 1 1 2 2 2 3 3 3\n");
  REQUIRE(f.description == "Brick");
  REQUIRE(f.category == "Brick Special");
  REQUIRE(f.help == std::vector<std::string>{"Use with care"});
  REQUIRE(f.cmds.size() == 9);
  REQUIRE((f.cmds[0].type == Cmd::Bfc && f.cmds[0].cert == Command::Cert::CW));
  REQUIRE((f.cmds[1].type == Cmd::Bfc && f.cmds[1].clip == 0));
  REQUIRE((f.cmds[2].winding == Command::Wind::CCW && f.cmds[2].clip == 1));
  REQUIRE(f.cmds[3].type == Cmd::Step);
  REQUIRE(f.cmds[4].group == "Wheels");
  REQUIRE(f.cmds[5].group == "Door");
  REQUIRE(f.cmds[6].group.empty());
  REQUIRE(f.cmds[7].type == Cmd::Line);
  REQUIRE((f.cmds[8].type == Cmd::Quad && f.cmds[8].pts[10] == 1));
  REQUIRE(f.skipped == 0);  // conditional lines (type 5) are ignored, not errors
}

TEST_CASE("malformed lines are skipped and counted", "[ldraw][parse][focus]") {
  const File f = parse(
      "0 ok\n"
      "1 4 0 0 0\n"
      "3 16 1 2 x 4 5 6 7 8 9\n"
      "9 garbage\n"
      "1 4 nan 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
      "1 4 0 0 0 1 0 0 0 1 0 0 0 1 good.dat\n");
  REQUIRE(f.skipped == 4);
  REQUIRE(f.cmds.size() == 1);
  REQUIRE(f.cmds[0].file == "good.dat");
}

TEST_CASE("random bytes never crash the parser", "[ldraw][parse][focus]") {
  std::mt19937 rng(7);
  std::string junk(5 * 1024 * 1024, '\0');
  for (char& c : junk) c = static_cast<char>(rng());
  const File f = parse(junk);
  REQUIRE(f.cmds.size() + static_cast<size_t>(f.skipped) >= 0);
  const File g = parse("");
  REQUIRE(g.cmds.empty());
  const File h = parse("1 4 0 0 0 1 0 0 0 1 0 0 0 1");  // no name, no newline
  REQUIRE(h.skipped == 1);
}

TEST_CASE("an MPD splits into its files", "[ldraw][parse]") {
  const std::string text =
      "0 FILE Main Model.ldr\n0 The main\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub one.ldr\n0 NOFILE\n"
      "0 FILE Sub One.LDR\n0 A sub\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"
      "0 !DATA sticker.png\n0 !: aGVsbG8=\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 ghost.dat\n"
      "0 FILE custom.dat\n0 Custom part\n3 16 0 0 0 1 0 0 0 1 0\n";
  const std::vector<File> files = parseMpd(text, "set.mpd");
  REQUIRE(files.size() == 3);
  REQUIRE(files[0].name == "main model.ldr");
  REQUIRE(files[0].description == "The main");
  REQUIRE(files[0].cmds.at(0).file == "sub one.ldr");
  REQUIRE(files[1].name == "sub one.ldr");
  REQUIRE(files[1].cmds.size() == 1);  // the !DATA block's lines are not part of the file
  REQUIRE(files[2].name == "custom.dat");
  REQUIRE(files[2].cmds.at(0).type == Cmd::Tri);
}

TEST_CASE("a plain file is an MPD with one file", "[ldraw][parse]") {
  const std::vector<File> files = parseMpd("0 Car\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n", "Car.ldr");
  REQUIRE(files.size() == 1);
  REQUIRE(files[0].name == "car.ldr");
  REQUIRE(files[0].description == "Car");
}

TEST_CASE("a byte-order mark at the start is not part of the first line", "[ldraw][parse][review]") {
  const File f = parse("\xEF\xBB\xBF" "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
  REQUIRE(f.skipped == 0);
  REQUIRE(f.cmds.size() == 1);
  const std::vector<File> files = parseMpd("\xEF\xBB\xBF" "0 FILE main.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n0 FILE sub.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n", "x.mpd");
  REQUIRE(files.size() == 2);
  REQUIRE(files[0].name == "main.ldr");
}

TEST_CASE("geometry before the first FILE line is the main file", "[ldraw][parse][review]") {
  const std::vector<File> files = parseMpd("0 Untitled\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n0 FILE sub.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n", "Top.mpd");
  REQUIRE(files.size() == 2);
  REQUIRE(files[0].name == "top.mpd");
  REQUIRE(files[0].cmds.at(0).file == "sub.ldr");
  // Only comments before the first FILE: no extra file.
  REQUIRE(parseMpd("0 Just a header comment\n0 FILE a.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n", "x.mpd").size() == 1);
}
