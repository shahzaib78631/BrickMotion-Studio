# BrickMotion.app: the native editor. Built only with -DBM_APP=ON, in its own tree
# (cmake -S native -B native/build-app -G Ninja -DBM_APP=ON), so a Swift problem never breaks
# the engine build.
enable_language(Swift)

# bmapp: the only C++ Swift sees. Defined in bmapp/ so the Rust app (BM_APP_LIB) builds it without Swift.
add_subdirectory(bmapp)

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
add_executable(BrickMotionThumbnails MACOSX_BUNDLE ThumbnailExtension/ThumbnailProvider.swift)
set_target_properties(BrickMotionThumbnails PROPERTIES
  BUNDLE_EXTENSION appex
  MACOSX_BUNDLE_INFO_PLIST ${CMAKE_CURRENT_SOURCE_DIR}/ThumbnailExtension/Info.plist.in
  MACOSX_BUNDLE_SHORT_VERSION_STRING ${PROJECT_VERSION}
  MACOSX_BUNDLE_BUNDLE_VERSION ${PROJECT_VERSION}
  OSX_DEPLOYMENT_TARGET 26.0
  Swift_LANGUAGE_VERSION 6)
target_compile_options(BrickMotionThumbnails PRIVATE -parse-as-library "SHELL:-target arm64-apple-macosx26.0")
target_link_options(BrickMotionThumbnails PRIVATE "LINKER:-e,_NSExtensionMain")
target_link_libraries(BrickMotionThumbnails PRIVATE "-framework QuickLookThumbnailing" "-framework ImageIO" "-framework Foundation")
add_custom_command(TARGET BrickMotionThumbnails POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E rm -f "$<TARGET_FILE:BrickMotionThumbnails>.d"
  COMMAND /usr/bin/codesign --force --sign - --entitlements "${CMAKE_CURRENT_SOURCE_DIR}/ThumbnailExtension/Entitlements.plist" "$<TARGET_BUNDLE_DIR:BrickMotionThumbnails>")

add_dependencies(BrickMotion bmexport BrickMotionThumbnails)
add_custom_command(TARGET BrickMotion POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_BUNDLE_CONTENT_DIR:BrickMotion>/Helpers"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:bmexport>" "$<TARGET_BUNDLE_CONTENT_DIR:BrickMotion>/Helpers/bmexport"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../public/sounds/snaps" "$<TARGET_BUNDLE_CONTENT_DIR:BrickMotion>/Resources/SnapSounds"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/../public/data/suggest/habits.json" "$<TARGET_BUNDLE_CONTENT_DIR:BrickMotion>/Resources/Suggest/habits.json"
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_BUNDLE_CONTENT_DIR:BrickMotion>/PlugIns"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "$<TARGET_BUNDLE_DIR:BrickMotionThumbnails>" "$<TARGET_BUNDLE_CONTENT_DIR:BrickMotion>/PlugIns/BrickMotionThumbnails.appex")

# The bridge must hold the shapes the app relies on (Task 1 of the phase 8 plan).
add_test(NAME brickmotion_selftest_bridge
  COMMAND $<TARGET_FILE:BrickMotion> --selftest-bridge ${CMAKE_SOURCE_DIR}/../samples/helicopter/helicopter.mpd)
add_test(NAME brickmotion_selftest_edit COMMAND $<TARGET_FILE:BrickMotion> --selftest-edit ${CMAKE_SOURCE_DIR}/../samples/helicopter/helicopter.mpd)
add_test(NAME brickmotion_selftest_panes COMMAND $<TARGET_FILE:BrickMotion> --selftest-panes ${CMAKE_SOURCE_DIR}/../samples/helicopter/helicopter.mpd)
add_test(NAME brickmotion_selftest_motion COMMAND $<TARGET_FILE:BrickMotion> --selftest-motion ${CMAKE_SOURCE_DIR}/../samples/helicopter/helicopter.mpd)
add_test(NAME brickmotion_selftest_placement COMMAND $<TARGET_FILE:BrickMotion> --selftest-placement)
add_test(NAME brickmotion_import_check COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/tests/import_check.sh $<TARGET_FILE:BrickMotion>)
add_test(NAME brickmotion_check_plist COMMAND $<TARGET_FILE:BrickMotion> --check-plist)
add_test(NAME brickmotion_snapshot
  COMMAND swift ${CMAKE_CURRENT_SOURCE_DIR}/tests/snapshot_check.swift $<TARGET_FILE:BrickMotion>
          ${CMAKE_SOURCE_DIR}/../samples/helicopter/helicopter.mpd ${CMAKE_CURRENT_BINARY_DIR})
add_test(NAME brickmotion_movie_export
  COMMAND swift ${CMAKE_CURRENT_SOURCE_DIR}/tests/movie_export_check.swift $<TARGET_FILE:BrickMotion>)
add_test(NAME brickmotion_selftest_render_queue COMMAND $<TARGET_FILE:BrickMotion> --selftest-render-queue)
