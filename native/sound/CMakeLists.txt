# bmsound: the snap of each seating, simulated from the connections made, mixed in blocks.
# Portable C++ (no Apple headers): bmexport writes its track, phase 9's app will play it.
file(GLOB BMSOUND_SOURCES CONFIGURE_DEPENDS src/*.cpp)
add_library(bmsound STATIC ${BMSOUND_SOURCES})
target_include_directories(bmsound PUBLIC include)
target_link_libraries(bmsound PUBLIC bmcore PRIVATE bm_warnings)

file(GLOB BMSOUND_TESTS CONFIGURE_DEPENDS tests/*_test.cpp)
add_executable(bmsound_tests ${BMSOUND_TESTS})
target_link_libraries(bmsound_tests PRIVATE bmsound bm_warnings Catch2::Catch2WithMain)
target_compile_definitions(bmsound_tests PRIVATE BM_FIXTURES="${CMAKE_SOURCE_DIR}/tests/fixtures")
catch_discover_tests(bmsound_tests)
