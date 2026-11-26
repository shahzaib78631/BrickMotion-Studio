# bmffi: one shared library holding the engine behind a flat C interface, for the Rust app.
# Added by native/CMakeLists.txt when BM_APP_LIB=ON.
file(GLOB BMFFI_SOURCES CONFIGURE_DEPENDS src/*.cpp src/*.mm)
add_library(bmffi SHARED ${BMFFI_SOURCES})
target_include_directories(bmffi PUBLIC include)
target_compile_options(bmffi PRIVATE -fvisibility=hidden -fvisibility-inlines-hidden
  $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmffi PRIVATE bmapp bm_warnings "-framework AVFoundation" "-framework CoreMedia"
  "-framework CoreVideo" "-framework CoreGraphics" "-framework Foundation")
set_target_properties(bmffi PROPERTIES INSTALL_NAME_DIR "@rpath" BUILD_WITH_INSTALL_NAME_DIR ON)
# Only the C interface leaves the library; the engine's C++ symbols stay inside.
target_link_options(bmffi PRIVATE "LINKER:-exported_symbol,_bm_*")

file(GLOB BMFFI_TESTS CONFIGURE_DEPENDS tests/*_test.cpp)
add_executable(bmffi_tests ${BMFFI_TESTS})
target_link_libraries(bmffi_tests PRIVATE bmffi bm_warnings Catch2::Catch2WithMain)
set_target_properties(bmffi_tests PROPERTIES BUILD_RPATH "$<TARGET_FILE_DIR:bmffi>")
target_compile_definitions(bmffi_tests PRIVATE BM_REPO="${CMAKE_SOURCE_DIR}/..")
list(APPEND CMAKE_MODULE_PATH ${catch2_SOURCE_DIR}/extras)
include(Catch)
catch_discover_tests(bmffi_tests)
