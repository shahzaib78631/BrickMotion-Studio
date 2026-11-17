# Writes OUT, a C++ file that defines `const char* const bmr::kShaderSource[]`: the text of
# common.metal followed by every other .metal file in SHADER_DIR in name order, as string
# literals ending with a null pointer. The offline Metal compiler is not needed: the text is
# compiled when the program starts. Run as: cmake -DSHADER_DIR=... -DOUT=... -P embed_shaders.cmake
file(GLOB files "${SHADER_DIR}/*.metal")
list(SORT files)
set(ordered "${SHADER_DIR}/common.metal")
foreach(f ${files})
  if(NOT f STREQUAL "${SHADER_DIR}/common.metal")
    list(APPEND ordered "${f}")
  endif()
endforeach()
set(out "// Generated from native/render/shaders by embed_shaders.cmake. Do not edit.\nnamespace bmr {\nextern const char* const kShaderSource[];\nconst char* const kShaderSource[] = {\n")
foreach(f ${ordered})
  file(READ "${f}" text)
  get_filename_component(name "${f}" NAME)
  string(APPEND out "R\"BMSL(\n// ---- ${name}\n)BMSL\",\n")
  string(LENGTH "${text}" length)
  set(at 0)
  # One literal has a size limit in some compilers: pieces of 12,000 characters.
  while(at LESS length)
    string(SUBSTRING "${text}" ${at} 12000 piece)
    string(APPEND out "R\"BMSL(${piece})BMSL\",\n")
    math(EXPR at "${at} + 12000")
  endwhile()
endforeach()
string(APPEND out "nullptr};\n}  // namespace bmr\n")
file(WRITE "${OUT}" "${out}")
