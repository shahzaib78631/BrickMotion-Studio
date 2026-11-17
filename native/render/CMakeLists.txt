# bmrender: draws what bmcore holds. src/prep is portable C++ (no Apple headers); src/metal owns Metal.
file(GLOB BMRENDER_PREP CONFIGURE_DEPENDS src/prep/*.cpp)
file(GLOB BMRENDER_METAL CONFIGURE_DEPENDS src/metal/*.mm)
# The shaders travel inside the library as text (see cmake/embed_shaders.cmake).
file(GLOB BMRENDER_SHADERS CONFIGURE_DEPENDS shaders/*.metal)
set(BMRENDER_SHADER_CPP ${CMAKE_CURRENT_BINARY_DIR}/shaders_embedded.cpp)
add_custom_command(OUTPUT ${BMRENDER_SHADER_CPP}
  COMMAND ${CMAKE_COMMAND} -DSHADER_DIR=${CMAKE_CURRENT_SOURCE_DIR}/shaders -DOUT=${BMRENDER_SHADER_CPP} -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_shaders.cmake
  DEPENDS ${BMRENDER_SHADERS} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_shaders.cmake VERBATIM)
add_library(bmrender STATIC ${BMRENDER_PREP} ${BMRENDER_METAL} ${BMRENDER_SHADER_CPP})
target_include_directories(bmrender PUBLIC include PRIVATE src)
target_compile_options(bmrender PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmrender PUBLIC bmcore PRIVATE bm_warnings
  "-framework Metal" "-framework QuartzCore" "-framework ImageIO" "-framework CoreGraphics" "-framework Foundation")

file(GLOB BMRENDER_TESTS CONFIGURE_DEPENDS tests/*_test.cpp tests/*_test.mm)
add_executable(bmrender_tests ${BMRENDER_TESTS})
target_include_directories(bmrender_tests PRIVATE src tests)
target_compile_options(bmrender_tests PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmrender_tests PRIVATE bmrender bm_warnings Catch2::Catch2WithMain "-framework Metal" "-framework Foundation")
target_compile_definitions(bmrender_tests PRIVATE BM_FIXTURES="${CMAKE_SOURCE_DIR}/tests/fixtures")
if(BM_SANITIZE)
  target_compile_definitions(bmrender_tests PRIVATE BM_SANITIZED=1)
endif()
catch_discover_tests(bmrender_tests)

# bmshot plans a model as `bm plan` does, so it shares bm's engine-data loader.
add_library(bmtools_common STATIC tools/common/engine.cpp ${CMAKE_SOURCE_DIR}/tools/bm/data.cpp)
target_include_directories(bmtools_common PUBLIC tools/common PRIVATE ${CMAKE_SOURCE_DIR}/tools/bm)
target_link_libraries(bmtools_common PUBLIC bmcore PRIVATE bm_warnings)
add_executable(bmshot tools/bmshot/main.mm)
target_compile_options(bmshot PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmshot PRIVATE bmrender bmtools_common bm_warnings)

# bmview: a window on the viewport.
add_executable(bmview MACOSX_BUNDLE tools/bmview/main.mm tools/bmview/AppDelegate.mm tools/bmview/ViewportView.mm)
set_target_properties(bmview PROPERTIES MACOSX_BUNDLE_BUNDLE_NAME bmview MACOSX_BUNDLE_GUI_IDENTIFIER com.brickmotion.bmview)
target_compile_options(bmview PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmview PRIVATE bmrender bmtools_common bm_warnings "-framework AppKit" "-framework QuartzCore" "-framework Metal")
