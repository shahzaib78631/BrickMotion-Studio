// bmexport, run as the owner runs it.
#include <catch2/catch_test_macros.hpp>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <unistd.h>
#include "bmr/denoise.h"
#include "bmr/device.h"
#include "bmr/path_scene.h"

namespace fs = std::filesystem;

namespace {
fs::path scratch() {
  const fs::path dir = fs::temp_directory_path() / ("bmexport_test_" + std::to_string(::getpid()));
  fs::create_directories(dir);
  return dir;
}
/// A two-brick model of the real library (BM_LDRAW_DIR).
fs::path model() {
  const fs::path file = scratch() / "two.ldr";
  std::ofstream(file) << "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 15 0 -24 0 1 0 0 0 1 0 0 0 1 3003.dat\n";
  return file;
}
struct Run {
  int code;
  std::string output;
};
Run run(const std::string& args, const std::string& env = "") {
  const fs::path log = scratch() / "log.txt";
  const std::string command = env + " '" + std::string(BMEXPORT) + "' " + args + " > '" + log.string() + "' 2>&1";
  const int status = std::system(command.c_str());
  std::ifstream in(log);
  return {WIFEXITED(status) ? WEXITSTATUS(status) : -1, std::string(std::istreambuf_iterator<char>(in), {})};
}
std::string bytes(const fs::path& file) {
  std::ifstream in(file, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(in), {});
}
bool canTrace() { return bmr::gpuAvailable() && bmr::PathScene::create(nullptr) != nullptr && std::getenv("BM_LDRAW_DIR"); }
/// A still is denoised unless --no-denoise: these need OIDN in the build as well.
bool canDenoise() { return canTrace() && bmr::denoiserAvailable(); }
}  // namespace

TEST_CASE("a still is the same file twice", "[bmexport]") {
  if (!canDenoise()) SKIP("no compute ray tracing, OIDN or BM_LDRAW_DIR");
  const fs::path a = scratch() / "a.png", b = scratch() / "b.png";
  const std::string args = "still '" + model().string() + "' --size 96x64 --samples 8 --out ";
  const Run first = run(args + "'" + a.string() + "'");
  INFO(first.output);
  REQUIRE(first.code == 0);
  REQUIRE(run(args + "'" + b.string() + "'").code == 0);
  REQUIRE(bytes(a).size() > 100);
  REQUIRE(bytes(a) == bytes(b));
}

TEST_CASE("a still without denoising is written too, and differs", "[bmexport]") {
  if (!canDenoise()) SKIP("no compute ray tracing, OIDN or BM_LDRAW_DIR");
  const fs::path a = scratch() / "raw.png", b = scratch() / "clean.png";
  const std::string args = "still '" + model().string() + "' --size 96x64 --samples 4 --out ";
  REQUIRE(run(args + "'" + a.string() + "' --no-denoise").code == 0);
  REQUIRE(run(args + "'" + b.string() + "'").code == 0);
  REQUIRE(bytes(a).size() > 100);
  REQUIRE(bytes(a) != bytes(b));
}

TEST_CASE("without ray tracing, bmexport says so in one line", "[bmexport]") {
  const Run r = run("still '" + model().string() + "' --size 32x32 --out '" + (scratch() / "none.png").string() + "'", "BM_FORCE_NO_RT=1");
  REQUIRE(r.code == 2);
  REQUIRE(r.output.find("ray-trace") != std::string::npos);
  REQUIRE(r.output.find('\n') == r.output.size() - 1);
}

TEST_CASE("without OIDN, a still asks for --no-denoise in one line", "[bmexport]") {
  if (bmr::denoiserAvailable() || !bmr::PathScene::create(nullptr)) SKIP("this build has OIDN, or cannot ray-trace");
  const Run r = run("still '" + model().string() + "' --size 32x32 --out '" + (scratch() / "n.png").string() + "'");
  REQUIRE(r.code == 2);
  REQUIRE(r.output.find("--no-denoise") != std::string::npos);
  REQUIRE(r.output.find('\n') == r.output.size() - 1);
}

TEST_CASE("an unknown rig is refused with the rigs there are", "[bmexport]") {
  const Run r = run("still '" + model().string() + "' --rig sunset --out '" + (scratch() / "x.png").string() + "'");
  REQUIRE(r.code == 2);
  REQUIRE(r.output.find("build-fl") != std::string::npos);
}

TEST_CASE("the snap track's style is a switch: physics, or the web app's", "[bmexport][sound]") {
  if (!std::getenv("BM_LDRAW_DIR")) SKIP("no BM_LDRAW_DIR");
  const fs::path physics = scratch() / "physics.wav", web = scratch() / "web.wav", product = scratch() / "product.wav";
  const std::string args = "sound '" + model().string() + "' --out ";
  const Run first = run(args + "'" + physics.string() + "'");
  INFO(first.output);
  REQUIRE(first.code == 0);
  const Run second = run(args + "'" + web.string() + "' --style web");
  INFO(second.output);
  REQUIRE(second.code == 0);
  REQUIRE(run(args + "'" + product.string() + "' --web-preset product").code == 0);
  REQUIRE(bytes(physics).size() > 1000);
  REQUIRE(bytes(web).size() == bytes(physics).size());
  REQUIRE(bytes(web) != bytes(physics));
  REQUIRE(bytes(product) != bytes(web));
  REQUIRE(run(args + "'" + web.string() + "' --style swish").code != 0);
  REQUIRE(run(args + "'" + web.string() + "' --web-preset sunset").code != 0);
}

TEST_CASE("a still takes no --strip: contact sheets are bmshot's", "[bmexport]") {
  if (!canTrace()) SKIP("no compute ray tracing or BM_LDRAW_DIR");
  const Run r = run("still '" + model().string() + "' --size 32x32 --strip 4 --no-denoise --out '" + (scratch() / "strip.png").string() + "'");
  INFO(r.output);
  REQUIRE(r.code == 2);
  REQUIRE(r.output.find("usage") != std::string::npos);
}
