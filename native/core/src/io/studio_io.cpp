// BrickLink Studio .io: a ZIP holding model.ldr. Some exports use legacy PKZIP encryption
// with the public format password. ZIP64, split archives and AES are rejected.
#include <cstring>
#include <array>
#include <miniz.h>
#include "bm/io.h"

namespace bm::io {
namespace {

constexpr size_t kMaxArchive = 96u * 1024 * 1024;
constexpr size_t kMaxModel = 32u * 1024 * 1024;
constexpr size_t kMaxEntries = 12000;
constexpr char kFormatPassword[] = "soho0909";

struct Entry {
  std::string name;
  uint32_t flags = 0, method = 0, time = 0, crc = 0, compressed = 0, size = 0, offset = 0;
};

std::string lower(std::string s) {
  for (char& c : s)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return s;
}

uint32_t crcStep(uint32_t crc, unsigned char byte) {
  static const auto table = [] {
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t c = i;
      for (int b = 0; b < 8; b++) c = (c >> 1) ^ ((c & 1) ? 0xEDB88320u : 0u);
      t[i] = c;
    }
    return t;
  }();
  return (crc >> 8) ^ table[(crc ^ byte) & 255];
}

/// Traditional PKZIP decryption. The first 12 bytes are a header whose last byte is a check.
std::string decrypt(std::string_view in, uint32_t expectedCrc, uint32_t checkTime, bool descriptor) {
  uint32_t k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
  auto advance = [&](unsigned char byte) {
    k0 = crcStep(k0, byte);
    k1 = (k1 + (k0 & 255)) * 134775813u + 1;
    k2 = crcStep(k2, static_cast<unsigned char>(k1 >> 24));
  };
  for (const char* p = kFormatPassword; *p; p++) advance(static_cast<unsigned char>(*p));
  if (in.size() < 12) throw Error("Studio archive contains an invalid encrypted model.");
  std::string out(in.size() - 12, '\0');
  unsigned char check = 0;
  for (size_t i = 0; i < in.size(); i++) {
    const uint32_t temp = k2 | 2;
    const unsigned char value = static_cast<unsigned char>(in[i]) ^ static_cast<unsigned char>((temp * (temp ^ 1)) >> 8);
    advance(value);
    if (i < 12) {
      if (i == 11) check = value;
    } else {
      out[i - 12] = static_cast<char>(value);
    }
  }
  const unsigned char expected = static_cast<unsigned char>(descriptor ? (checkTime >> 8) : (expectedCrc >> 24));
  if (check != expected) throw Error("Cannot decrypt this Studio model. Only standard .io encryption is supported.");
  return out;
}

}  // namespace

std::string readStudioIo(std::string_view bytes) {
  if (bytes.size() > kMaxArchive) throw Error("Studio .io archive exceeds the 96 MB import limit.");
  const size_t n = bytes.size();
  auto u16 = [&](size_t i) { return static_cast<uint32_t>(static_cast<unsigned char>(bytes[i])) | (static_cast<uint32_t>(static_cast<unsigned char>(bytes[i + 1])) << 8); };
  auto u32 = [&](size_t i) { return u16(i) | (u16(i + 2) << 16); };

  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  size_t eocd = std::string_view::npos;
  if (n >= 22) {
    const size_t lowest = n - 22 > 65535 ? n - 22 - 65535 : 0;
    for (size_t i = n - 22;; i--) {
      if (u32(i) == 0x06054B50u && i + 22 + u16(i + 20) == n) {
        eocd = i;
        break;
      }
      if (i == lowest) break;
    }
  }
  if (eocd == std::string_view::npos) throw Error("This .io file is not a supported BrickLink Studio ZIP archive.");
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) != u16(eocd + 10)) throw Error("Split ZIP archives cannot be imported.");
  const size_t count = u16(eocd + 10), directorySize = u32(eocd + 12), directoryOffset = u32(eocd + 16);
  if (count == 0xFFFF || directorySize == 0xFFFFFFFFu || directoryOffset == 0xFFFFFFFFu || count > kMaxEntries)
    throw Error("ZIP64 or unusually large Studio .io archives are not supported.");
  if (directoryOffset + directorySize > eocd) throw Error("Studio archive has an invalid directory.");

  std::vector<Entry> entries;
  size_t at = directoryOffset;
  for (size_t i = 0; i < count; i++) {
    if (at + 46 > eocd || u32(at) != 0x02014B50u) throw Error("Studio archive has a damaged directory entry.");
    const size_t nameLength = u16(at + 28), extra = u16(at + 30), comment = u16(at + 32);
    const size_t end = at + 46 + nameLength + extra + comment;
    if (end > eocd) throw Error("Studio archive directory entry extends past its bounds.");
    Entry e;
    e.name = std::string(bytes.substr(at + 46, nameLength));
    e.flags = u16(at + 8);
    e.method = u16(at + 10);
    e.time = u16(at + 12);
    e.crc = u32(at + 16);
    e.compressed = u32(at + 20);
    e.size = u32(at + 24);
    e.offset = u32(at + 42);
    entries.push_back(std::move(e));
    at = end;
  }

  // The exact Studio name first, then a model.ldr / model.mpd in any folder.
  const Entry* entry = nullptr;
  for (const Entry& e : entries)
    if (lower(e.name) == "model.ldr") {
      entry = &e;
      break;
    }
  if (!entry)
    for (const Entry& e : entries) {
      const std::string name = lower(e.name);
      const size_t slash = name.rfind('/');
      const std::string base = slash == std::string::npos ? name : name.substr(slash + 1);
      if (base == "model.ldr" || base == "model.mpd") {
        entry = &e;
        break;
      }
    }
  if (!entry) throw Error("No model.ldr found inside the Studio .io file. Export as LDraw .ldr or .mpd instead.");
  if (entry->size > kMaxModel || entry->compressed > kMaxArchive) throw Error("Studio model exceeds the import safety limits.");
  if (entry->flags & 0x40) throw Error("Strong encrypted Studio ZIP archives are not supported.");
  if (entry->method != 0 && entry->method != 8) throw Error("ZIP compression method " + std::to_string(entry->method) + " is not supported. Export as LDraw instead.");
  if (static_cast<size_t>(entry->offset) + 30 > directoryOffset || u32(entry->offset) != 0x04034B50u) throw Error("Studio archive has a damaged model header.");
  const size_t dataAt = static_cast<size_t>(entry->offset) + 30 + u16(entry->offset + 26) + u16(entry->offset + 28);
  if (dataAt + entry->compressed > n || dataAt + entry->compressed > directoryOffset) throw Error("Studio archive contains a truncated model.");

  std::string decrypted;
  std::string_view payload = bytes.substr(dataAt, entry->compressed);
  if (entry->flags & 1) {
    decrypted = decrypt(payload, entry->crc, entry->time, (entry->flags & 8) != 0);
    payload = decrypted;
  }
  std::string plain;
  if (entry->method == 0) {
    plain = std::string(payload);
  } else {
    // Inflated into a buffer of exactly the declared size, so a lying archive cannot grow it.
    plain.resize(entry->size);
    const size_t got = tinfl_decompress_mem_to_mem(plain.data(), plain.size(), payload.data(), payload.size(), 0);
    if (got == TINFL_DECOMPRESS_MEM_TO_MEM_FAILED) throw Error("Studio model could not be decompressed.");
    plain.resize(got);
  }
  const uint32_t crc = static_cast<uint32_t>(mz_crc32(MZ_CRC32_INIT, reinterpret_cast<const unsigned char*>(plain.data()), plain.size()));
  if (plain.size() != entry->size || crc != entry->crc) throw Error("Studio model failed its ZIP integrity check (length or CRC).");
  if (plain.rfind("\xEF\xBB\xBF", 0) == 0) plain.erase(0, 3);

  // It must look like LDraw: some line starts with a line type 0-5.
  bool ldraw = false;
  for (size_t i = 0; i < plain.size() && !ldraw;) {
    size_t j = i;
    while (j < plain.size() && (plain[j] == ' ' || plain[j] == '\t' || plain[j] == '\r')) j++;
    ldraw = j + 1 < plain.size() && plain[j] >= '0' && plain[j] <= '5' && (plain[j + 1] == ' ' || plain[j + 1] == '\t');
    const size_t nl = plain.find('\n', i);
    i = nl == std::string::npos ? plain.size() : nl + 1;
  }
  if (!ldraw) throw Error("The extracted Studio model is not an LDraw file.");
  return plain;
}

}  // namespace bm::io
