# bmfilm: the camera. What happens in a build (beats), a director's shot list, and a camera
# body that films it for a frame shape. Portable C++ (no Metal): the render tools turn its
# frames into their cameras.
file(GLOB BMFILM_SOURCES CONFIGURE_DEPENDS src/*.cpp)
add_library(bmfilm STATIC ${BMFILM_SOURCES})
target_include_directories(bmfilm PUBLIC include)
target_link_libraries(bmfilm PUBLIC bmcore PRIVATE bm_warnings)

file(GLOB BMFILM_TESTS CONFIGURE_DEPENDS tests/*_test.cpp)
add_executable(bmfilm_tests ${BMFILM_TESTS})
target_link_libraries(bmfilm_tests PRIVATE bmfilm bm_warnings Catch2::Catch2WithMain)
target_compile_definitions(bmfilm_tests PRIVATE BM_FIXTURES="${CMAKE_SOURCE_DIR}/tests/fixtures")
catch_discover_tests(bmfilm_tests)
