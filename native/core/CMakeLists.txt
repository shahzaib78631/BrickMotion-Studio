file(GLOB_RECURSE BMCORE_SOURCES CONFIGURE_DEPENDS src/*.cpp)
add_library(bmcore STATIC ${BMCORE_SOURCES})
target_include_directories(bmcore PUBLIC include)
target_link_libraries(bmcore PUBLIC nlohmann_json::nlohmann_json PRIVATE miniz bm_warnings)
