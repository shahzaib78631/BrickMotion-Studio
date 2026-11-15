#include <catch2/catch_test_macros.hpp>
#include <string>
#include "bm/version.h"

TEST_CASE("version is 0.1.0", "[version]") {
  REQUIRE(std::string(bm::version()) == "0.1.0");
}
