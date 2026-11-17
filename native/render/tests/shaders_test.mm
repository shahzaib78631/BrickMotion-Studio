#import <Metal/Metal.h>
#include <catch2/catch_test_macros.hpp>
#include "bmr/device.h"

TEST_CASE("every shader compiles", "[gpu][shaders]") {
  if (!MTLCreateSystemDefaultDevice()) SKIP("no Metal device");
  INFO(bmr::shaderError());
  REQUIRE(bmr::gpuAvailable());
  REQUIRE(std::string(bmr::shaderError()).empty());
}
