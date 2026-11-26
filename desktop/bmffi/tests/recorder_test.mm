// The viewport recorder's finish when its writer has already stopped.
#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <string>
#include <vector>

#include "bmffi.h"
#include "recorder_internal.h"

namespace fs = std::filesystem;

TEST_CASE("finish after the writer stopped reports the encoder", "[recorder]") {
  const fs::path file = fs::temp_directory_path() / "bmffi-recorder-stopped.mp4";
  fs::remove(file);
  BmString error{};
  BmRecorder* r = bm_recorder_start(file.c_str(), 64, 48, &error);
  REQUIRE(r);
  std::vector<uint8_t> rgba(64 * 48 * 4, 200);
  REQUIRE(bm_recorder_append(r, rgba.data(), rgba.size(), 64, 48, 0.0));
  // As if the encoder had failed: the writer is no longer writing.
  [r->writer cancelWriting];
  BmString message = bm_recorder_finish(r);
  const std::string text = message.ptr ? std::string(message.ptr, message.len) : "";
  bm_string_free(message);
  CHECK(text == "The movie encoder stopped. Try a smaller window.");
  fs::remove(file);
}
