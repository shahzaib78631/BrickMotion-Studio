# BrickMotion.app: the native editor. Built only with -DBM_APP=ON, in its own tree
# (cmake -S native -B native/build-app -G Ninja -DBM_APP=ON), so a Swift problem never breaks
# the engine build.
enable_language(Swift)

# bmapp: the only C++ Swift sees.
file(GLOB BMAPP_SOURCES CONFIGURE_DEPENDS bmapp/src/*.cpp bmapp/src/*.mm)
add_library(bmapp STATIC ${BMAPP_SOURCES})
target_include_directories(bmapp PUBLIC bmapp/include PRIVATE bmapp/src)
target_compile_options(bmapp PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
# A developer build finds the repository's LDraw library even when Finder starts it (no env).
target_compile_definitions(bmapp PRIVATE BM_DEFAULT_LDRAW="${CMAKE_SOURCE_DIR}/../public/ldraw")
target_link_libraries(bmapp PUBLIC bmcore bmrender bmfilm bmtools_common PRIVATE bm_warnings
  "-framework Metal" "-framework QuartzCore" "-framework Foundation")

file(GLOB BMAPP_TESTS CONFIGURE_DEPENDS bmapp/tests/*_test.cpp bmapp/tests/*_test.mm)
add_executable(bmapp_tests ${BMAPP_TESTS})
target_compile_options(bmapp_tests PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmapp_tests PRIVATE bmapp bm_warnings Catch2::Catch2WithMain)
target_compile_definitions(bmapp_tests PRIVATE BM_FIXTURES="${CMAKE_SOURCE_DIR}/tests/fixtures" BM_REPO="${CMAKE_SOURCE_DIR}/..")
list(APPEND CMAKE_MODULE_PATH ${catch2_SOURCE_DIR}/extras)
include(Catch)
catch_discover_tests(bmapp_tests)

# The app. Swift reads bmapp's headers through bmapp/include/module.modulemap.
file(GLOB BRICKMOTION_SWIFT CONFIGURE_DEPENDS BrickMotion/*.swift)
add_executable(BrickMotion MACOSX_BUNDLE ${BRICKMOTION_SWIFT})
set_target_properties(BrickMotion PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST ${CMAKE_CURRENT_SOURCE_DIR}/BrickMotion/Info.plist.in
  MACOSX_BUNDLE_SHORT_VERSION_STRING ${PROJECT_VERSION}
  MACOSX_BUNDLE_BUNDLE_VERSION ${PROJECT_VERSION}
  OSX_DEPLOYMENT_TARGET 26.0
  Swift_LANGUAGE_VERSION 6)
target_compile_options(BrickMotion PRIVATE
  "SHELL:-cxx-interoperability-mode=default"
  "SHELL:-Xcc -std=c++20"
  "SHELL:-target arm64-apple-macosx26.0")
target_include_directories(BrickMotion PRIVATE bmapp/include)
target_link_libraries(BrickMotion PRIVATE bmapp
  "-framework AppKit" "-framework Metal" "-framework QuartzCore" "-framework SwiftUI")

# The bridge must hold the shapes the app relies on (Task 1 of the phase 8 plan).
add_test(NAME brickmotion_selftest_bridge
  COMMAND $<TARGET_FILE:BrickMotion> --selftest-bridge ${CMAKE_SOURCE_DIR}/../samples/helicopter/helicopter.mpd)
add_test(NAME brickmotion_check_plist COMMAND $<TARGET_FILE:BrickMotion> --check-plist)
