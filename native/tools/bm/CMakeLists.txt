file(GLOB BM_SOURCES CONFIGURE_DEPENDS *.cpp)
add_executable(bm ${BM_SOURCES})
target_link_libraries(bm PRIVATE bmcore bm_warnings)
