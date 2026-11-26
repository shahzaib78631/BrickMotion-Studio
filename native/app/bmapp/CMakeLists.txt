# bmapp: the C++ the app shells see (Swift app and Rust app). Needs no Swift.
file(GLOB BMAPP_SOURCES CONFIGURE_DEPENDS src/*.cpp src/*.mm)
add_library(bmapp STATIC ${BMAPP_SOURCES})
target_include_directories(bmapp PUBLIC include PRIVATE src)
target_compile_options(bmapp PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
# A developer build finds the repository's LDraw library even when Finder starts it (no env).
target_compile_definitions(bmapp PRIVATE BM_DEFAULT_LDRAW="${CMAKE_SOURCE_DIR}/../public/ldraw"
  BM_DEFAULT_HABITS="${CMAKE_SOURCE_DIR}/../public/data/suggest/habits.json")
target_link_libraries(bmapp PUBLIC bmcore bmrender bmfilm bmtools_common PRIVATE bm_warnings bmmovie bmsound
  "-framework Metal" "-framework QuartzCore" "-framework Foundation" "-framework ImageIO" "-framework CoreGraphics" "-framework AVFoundation" "-framework CoreMedia")

file(GLOB BMAPP_TESTS CONFIGURE_DEPENDS tests/*_test.cpp tests/*_test.mm)
add_executable(bmapp_tests ${BMAPP_TESTS})
target_compile_options(bmapp_tests PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmapp_tests PRIVATE bmapp bm_warnings Catch2::Catch2WithMain)
# The tests look inside a session (its document and flat model) through bmapp's private headers.
target_include_directories(bmapp_tests PRIVATE src)
target_compile_definitions(bmapp_tests PRIVATE BM_FIXTURES="${CMAKE_SOURCE_DIR}/tests/fixtures" BM_REPO="${CMAKE_SOURCE_DIR}/..")
list(APPEND CMAKE_MODULE_PATH ${catch2_SOURCE_DIR}/extras)
include(Catch)
catch_discover_tests(bmapp_tests)

