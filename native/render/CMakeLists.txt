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

# Intel Open Image Denoise, from vendor/oidn (outside git; see the phase 7 design). Without it the
# library still builds; bmexport then refuses to denoise (exit 2) and writes --no-denoise pictures only.
set(BM_OIDN_DIR ${CMAKE_SOURCE_DIR}/../vendor/oidn/oidn-2.5.1.arm64.macos CACHE PATH "OIDN 2.5 (its lib/cmake config)")
find_package(OpenImageDenoise 2.5 CONFIG QUIET PATHS ${BM_OIDN_DIR} NO_DEFAULT_PATH)
if(OpenImageDenoise_FOUND)
  get_target_property(BM_OIDN_INCLUDE OpenImageDenoise INTERFACE_INCLUDE_DIRECTORIES)
  target_include_directories(bmrender SYSTEM PRIVATE ${BM_OIDN_INCLUDE})
  target_link_libraries(bmrender PRIVATE OpenImageDenoise)
  target_compile_definitions(bmrender PRIVATE BM_HAVE_OIDN=1)
  # Its core finds its CPU and Metal device libraries beside itself.
  target_link_options(bmrender INTERFACE "LINKER:-rpath,${BM_OIDN_DIR}/lib")
else()
  message(STATUS "OIDN not found in ${BM_OIDN_DIR}: bmexport will not denoise")
  target_compile_definitions(bmrender PRIVATE BM_HAVE_OIDN=0)
endif()

file(GLOB BMRENDER_TESTS CONFIGURE_DEPENDS tests/*_test.cpp tests/*_test.mm)
add_executable(bmrender_tests ${BMRENDER_TESTS})
target_include_directories(bmrender_tests PRIVATE src tests)
target_compile_options(bmrender_tests PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmrender_tests PRIVATE bmrender bm_warnings Catch2::Catch2WithMain "-framework Metal" "-framework Foundation")
target_compile_definitions(bmrender_tests PRIVATE BM_FIXTURES="${CMAKE_SOURCE_DIR}/tests/fixtures")
if(BM_SANITIZE)
  target_compile_definitions(bmrender_tests PRIVATE BM_SANITIZED=1)
endif()
target_compile_definitions(bmrender_tests PRIVATE BMEXPORT="$<TARGET_FILE:bmexport>")
add_dependencies(bmrender_tests bmexport)
catch_discover_tests(bmrender_tests)

# bmshot plans a model as `bm plan` does, so it shares bm's engine-data loader.
add_library(bmtools_common STATIC tools/common/engine.cpp ${CMAKE_SOURCE_DIR}/tools/bm/data.cpp)
target_include_directories(bmtools_common PUBLIC tools/common PRIVATE ${CMAKE_SOURCE_DIR}/tools/bm)
target_link_libraries(bmtools_common PUBLIC bmcore PRIVATE bm_warnings)
add_executable(bmshot tools/bmshot/main.mm tools/common/shot_options.cpp)
target_compile_options(bmshot PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmshot PRIVATE bmrender bmtools_common bm_warnings)

# bmexport: path-traced stills, frames, the snap track and the film.
add_executable(bmexport tools/bmexport/main.mm tools/common/shot_options.cpp)
target_compile_options(bmexport PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmexport PRIVATE bmrender bmtools_common bmsound bm_warnings)

# bmview: a window on the viewport.
add_executable(bmview MACOSX_BUNDLE tools/bmview/main.mm tools/bmview/AppDelegate.mm tools/bmview/ViewportView.mm)
set_target_properties(bmview PROPERTIES MACOSX_BUNDLE_BUNDLE_NAME bmview MACOSX_BUNDLE_GUI_IDENTIFIER com.brickmotion.bmview)
target_compile_options(bmview PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bmview PRIVATE bmrender bmtools_common bm_warnings "-framework AppKit" "-framework QuartzCore" "-framework Metal")
