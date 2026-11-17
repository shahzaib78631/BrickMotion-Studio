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
add_executable(bmshot tools/bmshot/main.mm ${CMAKE_SOURCE_DIR}/tools/bm/data.cpp)
target_include_directories(bmshot PRIVATE ${CMAKE_SOURCE_DIR}/tools/bm)
target_compile_options(bmshot PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmshot PRIVATE bmrender bm_warnings)
