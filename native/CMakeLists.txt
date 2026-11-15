cmake_minimum_required(VERSION 3.28)
set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0" CACHE STRING "")
set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "")
project(BrickMotionNative VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG")
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELEASE ON)

# BM_SANITIZE: "" (off), "address" (ASan + UBSan) or "thread" (TSan), for the tests.
set(BM_SANITIZE "" CACHE STRING "Sanitizer for tests: address or thread")
if(BM_SANITIZE STREQUAL "address")
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
elseif(BM_SANITIZE STREQUAL "thread")
  add_compile_options(-fsanitize=thread)
  add_link_options(-fsanitize=thread)
endif()

include(FetchContent)
# miniz 3.0.2 declares a CMake minimum that CMake 4 no longer accepts by default.
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)
FetchContent_Declare(Catch2 GIT_REPOSITORY https://github.com/catchorg/Catch2.git GIT_TAG v3.7.1 GIT_SHALLOW ON)
FetchContent_Declare(json GIT_REPOSITORY https://github.com/nlohmann/json.git GIT_TAG v3.11.3 GIT_SHALLOW ON)
FetchContent_Declare(miniz GIT_REPOSITORY https://github.com/richgel999/miniz.git GIT_TAG 3.0.2 GIT_SHALLOW ON)
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(BUILD_EXAMPLES OFF CACHE INTERNAL "")
set(BUILD_TESTS OFF CACHE INTERNAL "")
FetchContent_MakeAvailable(Catch2 json miniz)

# Our own code is held to -Werror; third-party code is not.
add_library(bm_warnings INTERFACE)
target_compile_options(bm_warnings INTERFACE -Wall -Wextra -Werror)

add_subdirectory(core)
add_subdirectory(tools/bm)
enable_testing()
add_subdirectory(tests)
