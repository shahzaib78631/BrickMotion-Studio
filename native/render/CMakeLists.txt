# bmrender: draws what bmcore holds. src/prep is portable C++ (no Apple headers); src/metal owns Metal.
file(GLOB BMRENDER_PREP CONFIGURE_DEPENDS src/prep/*.cpp)
file(GLOB BMRENDER_METAL CONFIGURE_DEPENDS src/metal/*.mm)
add_library(bmrender STATIC ${BMRENDER_PREP} ${BMRENDER_METAL})
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
