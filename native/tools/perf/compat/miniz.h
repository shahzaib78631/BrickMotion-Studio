#pragma once
// Test-only adapter for the subset of miniz used by studio_io.cpp.
// The production target uses miniz 3.0.2. Portable Linux verification can
// instead use the system zlib raw-DEFLATE decoder; do not use this adapter
// in the application, or claim it tests miniz's exact implementation.
#include <cstddef>
#include <cstdint>
#include <zlib.h>

#define MZ_CRC32_INIT 0
#define TINFL_DECOMPRESS_MEM_TO_MEM_FAILED (static_cast<size_t>(-1))

inline unsigned long mz_crc32(unsigned long seed, const unsigned char* data, size_t size) {
  return ::crc32(seed, data, static_cast<uInt>(size));
}

inline size_t tinfl_decompress_mem_to_mem(void* output, size_t outputSize,
                                         const void* input, size_t inputSize, int flags) {
  (void)flags;
  z_stream stream{};
  stream.next_in = reinterpret_cast<Bytef*>(const_cast<void*>(input));
  stream.avail_in = static_cast<uInt>(inputSize);
  stream.next_out = static_cast<Bytef*>(output);
  stream.avail_out = static_cast<uInt>(outputSize);
  if (inflateInit2(&stream, -MAX_WBITS) != Z_OK)
    return TINFL_DECOMPRESS_MEM_TO_MEM_FAILED;
  const int status = inflate(&stream, Z_FINISH);
  const size_t written = stream.total_out;
  inflateEnd(&stream);
  return status == Z_STREAM_END ? written : TINFL_DECOMPRESS_MEM_TO_MEM_FAILED;
}
