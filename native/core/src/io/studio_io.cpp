// BrickLink Studio .io: bounded, in-memory ZIP reader plus reachability-based CustomParts
// import. Supports store/deflate and Studio's traditional PKZIP password protection.
// ZIP64, split archives, strong/AES encryption and unsafe paths are rejected.
#include <algorithm>
#include <array>
#include <cstdint>
#include <deque>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <miniz.h>
#include "bm/io.h"

namespace bm::io {
namespace {

constexpr size_t kMaxArchive = 96u * 1024 * 1024;
constexpr size_t kMaxModel = 32u * 1024 * 1024;
constexpr size_t kMaxEntries = 12000;
constexpr size_t kMaxCustomParts = 4096;
constexpr size_t kMaxCustomPart = 16u * 1024 * 1024;
constexpr size_t kMaxCustomTotal = 64u * 1024 * 1024;
constexpr size_t kMaxPartCommands = 250000;
constexpr size_t kMaxTotalCommands = 750000;
constexpr char kFormatPassword[] = "soho0909";

struct Entry {
  std::string name;
  uint32_t flags = 0, method = 0, time = 0, crc = 0, compressed = 0, size = 0, offset = 0;
};

std::string lower(std::string_view text) {
  std::string out(text);
  for (char& c : out) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (c == '\\') c = '/';
  }
  return out;
}

bool endsWith(std::string_view s, std::string_view suffix) {
  return s.size() >= suffix.size() && s.substr(s.size() - suffix.size()) == suffix;
}

// Neither disk extraction nor filesystem paths are used, but unsafe names must not become
// Library keys (or aliases to legitimate names). Reject traversal, absolute paths, NUL,
// and control characters. Spaces and Unicode are valid in real LDraw part names.
void checkPath(std::string_view path) {
  if (path.empty() || path.size() > 512 || path.front() == '/') throw Error("Studio CustomParts entry has an unsafe path.");
  size_t at = 0;
  while (at < path.size()) {
    const size_t end = path.find('/', at);
    const std::string_view segment = path.substr(at, end == std::string_view::npos ? path.size() - at : end - at);
    if (segment.empty() || segment == "." || segment == ".." || segment.find(':') != std::string_view::npos)
      throw Error("Studio CustomParts entry has an unsafe path.");
    for (unsigned char c : segment)
      if (c < 32 || c == 127) throw Error("Studio CustomParts entry has an unsafe path.");
    if (end == std::string_view::npos) break;
    at = end + 1;
    if (at == path.size()) throw Error("Studio CustomParts entry has an unsafe path.");
  }
}

// Studio archives contain CustomParts/<name>.dat for parts,
// CustomParts/p/<primitive>.dat for primitives and CustomParts/s/s/<name>.dat for
// subparts. LDraw references the latter as s/<name>.dat, and primitives without p/.
// Also handle the conventional "parts/s" spelling used by some ZIP producers.
std::string partName(std::string_view archiveName) {
  const std::string name = lower(archiveName);
  constexpr std::string_view prefix = "customparts/";
  if (name.rfind(prefix, 0) != 0 || !endsWith(name, ".dat")) return {};
  std::string_view rest(name.data() + prefix.size(), name.size() - prefix.size());
  checkPath(rest);
  if (rest.rfind("parts/", 0) == 0) rest.remove_prefix(6);
  else if (rest.rfind("p/", 0) == 0) rest.remove_prefix(2);
  else if (rest.rfind("s/s/", 0) == 0) rest.remove_prefix(2);
  if (rest.empty()) throw Error("Studio CustomParts entry has an empty part name.");
  checkPath(rest);
  return std::string(rest);
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

// Traditional PKZIP decryption. Byte 11 of the 12-byte header contains an integrity
// hint; the uncompressed CRC is always checked separately after decompression.
std::string decrypt(std::string_view in, uint32_t expectedCrc, uint32_t checkTime, bool descriptor) {
  uint32_t k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
  auto advance = [&](unsigned char byte) {
    k0 = crcStep(k0, byte);
    k1 = (k1 + (k0 & 255)) * 134775813u + 1;
    k2 = crcStep(k2, static_cast<unsigned char>(k1 >> 24));
  };
  for (const char* p = kFormatPassword; *p; p++) advance(static_cast<unsigned char>(*p));
  if (in.size() < 12) throw Error("Studio archive contains an invalid encrypted entry.");
  std::string out(in.size() - 12, '\0');
  unsigned char check = 0;
  for (size_t i = 0; i < in.size(); i++) {
    const uint32_t temp = k2 | 2;
    const unsigned char value = static_cast<unsigned char>(in[i]) ^ static_cast<unsigned char>((temp * (temp ^ 1)) >> 8);
    advance(value);
    if (i == 11) check = value;
    else if (i > 11) out[i - 12] = static_cast<char>(value);
  }
  const unsigned char expected = static_cast<unsigned char>(descriptor ? (checkTime >> 8) : (expectedCrc >> 24));
  if (check != expected) throw Error("Cannot decrypt this Studio entry. Only standard .io encryption is supported.");
  return out;
}

// Work exclusively inside the provided byte span. Every offset and declared inflate size
// is validated before allocation or read. Non-geometric resources are never inflated.
class ZipArchive {
 public:
  explicit ZipArchive(std::string_view bytes) : bytes_(bytes) {
    if (bytes.size() > kMaxArchive) throw Error("Studio .io archive exceeds the 96 MB import limit.");
    const size_t n = bytes.size();
    size_t eocd = std::string_view::npos;
    if (n >= 22) {
      const size_t lowest = n - 22 > 65535 ? n - 22 - 65535 : 0;
      for (size_t i = n - 22;; i--) {
        if (u32(i) == 0x06054B50u && i + 22 + u16(i + 20) == n) { eocd = i; break; }
        if (i == lowest) break;
      }
    }
    if (eocd == std::string_view::npos) throw Error("This .io file is not a supported BrickLink Studio ZIP archive.");
    if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) != u16(eocd + 10))
      throw Error("Split ZIP archives cannot be imported.");
    const size_t count = u16(eocd + 10);
    const size_t directorySize = u32(eocd + 12);
    const size_t directoryOffset = u32(eocd + 16);
    if (count == 0xFFFF || directorySize == 0xFFFFFFFFu || directoryOffset == 0xFFFFFFFFu || count > kMaxEntries)
      throw Error("ZIP64 or unusually large Studio .io archives are not supported.");
    if (directoryOffset > eocd || directorySize > eocd - directoryOffset)
      throw Error("Studio archive has an invalid directory.");
    directoryOffset_ = directoryOffset;
    entries_.reserve(count);
    size_t at = directoryOffset;
    for (size_t i = 0; i < count; i++) {
      if (at > eocd || eocd - at < 46 || u32(at) != 0x02014B50u)
        throw Error("Studio archive has a damaged directory entry.");
      const size_t nameLength = u16(at + 28), extra = u16(at + 30), comment = u16(at + 32);
      const size_t total = 46 + nameLength + extra + comment;
      if (total > eocd - at) throw Error("Studio archive directory entry extends past its bounds.");
      if (u16(at + 34) != 0) throw Error("Multi-disk Studio archives are not supported.");
      Entry e;
      e.name = std::string(bytes.substr(at + 46, nameLength));
      e.flags = u16(at + 8);
      e.method = u16(at + 10);
      e.time = u16(at + 12);
      e.crc = u32(at + 16);
      e.compressed = u32(at + 20);
      e.size = u32(at + 24);
      e.offset = u32(at + 42);
      if (e.compressed == 0xFFFFFFFFu || e.size == 0xFFFFFFFFu || e.offset == 0xFFFFFFFFu)
        throw Error("ZIP64 Studio archive entries are not supported.");
      entries_.push_back(std::move(e));
      at += total;
    }
    if (at != directoryOffset + directorySize)
      throw Error("Studio archive has an invalid central directory size.");
  }

  const std::vector<Entry>& entries() const { return entries_; }

  std::string read(const Entry& e, size_t limit) const {
    if (e.size > limit || e.compressed > kMaxArchive) throw Error("Studio archive entry exceeds its import safety limit: " + e.name);
    if (e.flags & (0x40u | 0x2000u)) throw Error("Strong encrypted Studio ZIP entries are not supported: " + e.name);
    if (e.method != 0 && e.method != 8)
      throw Error("ZIP compression method " + std::to_string(e.method) + " is not supported: " + e.name);
    const size_t off = e.offset;
    if (off > directoryOffset_ || directoryOffset_ - off < 30 || u32(off) != 0x04034B50u)
      throw Error("Studio archive has a damaged local ZIP header: " + e.name);
    const size_t nameLength = u16(off + 26), extraLength = u16(off + 28);
    const size_t headerLength = 30 + nameLength + extraLength;
    if (headerLength > directoryOffset_ - off || static_cast<size_t>(e.compressed) > directoryOffset_ - off - headerLength)
      throw Error("Studio archive has a truncated entry: " + e.name);
    if (u16(off + 6) != e.flags || u16(off + 8) != e.method ||
        bytes_.substr(off + 30, nameLength) != e.name ||
        (!(e.flags & 8) && (u32(off + 14) != e.crc || u32(off + 18) != e.compressed || u32(off + 22) != e.size)))
      throw Error("Studio archive entry disagrees with its local header: " + e.name);
    std::string decrypted;
    std::string_view payload = bytes_.substr(off + headerLength, e.compressed);
    if (e.flags & 1) {
      decrypted = decrypt(payload, e.crc, e.time, (e.flags & 8) != 0);
      payload = decrypted;
    }
    std::string plain;
    if (e.method == 0) {
      plain.assign(payload);
    } else {
      // A lying size cannot inflate into an oversized buffer. Always check exact length
      // and checksum, even when the encryption header appeared correct.
      plain.resize(e.size);
      const size_t got = tinfl_decompress_mem_to_mem(plain.data(), plain.size(), payload.data(), payload.size(), 0);
      if (got == TINFL_DECOMPRESS_MEM_TO_MEM_FAILED || got != e.size)
        throw Error("Studio archive entry could not be decompressed: " + e.name);
    }
    const uint32_t crc = static_cast<uint32_t>(mz_crc32(MZ_CRC32_INIT, reinterpret_cast<const unsigned char*>(plain.data()), plain.size()));
    if (plain.size() != e.size || crc != e.crc)
      throw Error("Studio archive entry failed its ZIP integrity check: " + e.name);
    if (plain.rfind("\xEF\xBB\xBF", 0) == 0) plain.erase(0, 3);
    return plain;
  }

 private:
  uint32_t u16(size_t i) const {
    return static_cast<uint32_t>(static_cast<unsigned char>(bytes_[i])) |
           (static_cast<uint32_t>(static_cast<unsigned char>(bytes_[i + 1])) << 8);
  }
  uint32_t u32(size_t i) const { return u16(i) | (u16(i + 2) << 16); }

  std::string_view bytes_;
  size_t directoryOffset_ = 0;
  std::vector<Entry> entries_;
};

const Entry* modelEntry(const ZipArchive& zip) {
  const Entry* fallback = nullptr;
  for (const Entry& entry : zip.entries()) {
    const std::string name = lower(entry.name);
    if (name == "model.ldr") return &entry;
    const size_t slash = name.rfind('/');
    const std::string_view base(name.data() + (slash == std::string::npos ? 0 : slash + 1),
                                name.size() - (slash == std::string::npos ? 0 : slash + 1));
    if (!fallback && (base == "model.ldr" || base == "model.mpd")) fallback = &entry;
  }
  return fallback;
}

bool looksLikeLDraw(std::string_view plain) {
  for (size_t i = 0; i < plain.size();) {
    size_t j = i;
    while (j < plain.size() && (plain[j] == ' ' || plain[j] == '\t' || plain[j] == '\r')) j++;
    if (j + 1 < plain.size() && plain[j] >= '0' && plain[j] <= '5' && (plain[j + 1] == ' ' || plain[j + 1] == '\t')) return true;
    const size_t nl = plain.find('\n', i);
    i = nl == std::string_view::npos ? plain.size() : nl + 1;
  }
  return false;
}

// Traverse type-1 references once; embedded part files can refer to other embedded parts,
// subparts, and 8/ or 48/ primitives. The engine's LDraw parser provides the canonical
// reference spelling and handles MPD model sections without ad-hoc text scanning.
void enqueueReferences(const ldraw::File& file, std::deque<std::string>& pending) {
  for (const ldraw::Command& cmd : file.cmds) {
    if (cmd.type != ldraw::Cmd::Ref) continue;
    std::string name = cmd.file;
    if (name.find('.') == std::string::npos) name += ".dat";
    pending.push_back(std::move(name));
  }
}

StudioArchive readArchive(std::string_view bytes, bool includeParts) {
  const ZipArchive zip(bytes);
  const Entry* model = modelEntry(zip);
  if (!model) throw Error("No model.ldr found inside the Studio .io file. Export as LDraw .ldr or .mpd instead.");
  StudioArchive result;
  result.model = zip.read(*model, kMaxModel);
  if (!looksLikeLDraw(result.model)) throw Error("The extracted Studio model is not an LDraw file.");
  if (!includeParts) return result;

  std::unordered_map<std::string, const Entry*> embedded;
  for (const Entry& entry : zip.entries()) {
    const std::string name = partName(entry.name);
    if (name.empty()) continue;
    if (embedded.size() >= kMaxCustomParts) throw Error("Studio .io archive contains too many custom part files.");
    if (!embedded.emplace(name, &entry).second)
      throw Error("Studio archive has conflicting custom part names: " + name);
  }
  result.availableCustomParts = embedded.size();
  if (embedded.empty()) return result;

  // MPD's own declarations must have precedence over the ZIP's CustomParts entries.
  const auto modelFiles = ldraw::parseMpd(result.model, "model.ldr");
  std::unordered_set<std::string> modelNames;
  std::deque<std::string> pending;
  for (const ldraw::File& file : modelFiles) {
    modelNames.insert(file.name);
    enqueueReferences(file, pending);
  }

  std::unordered_set<std::string> seen;
  size_t totalInflated = 0, totalCommands = 0;
  result.customParts.reserve(std::min(embedded.size(), pending.size()));
  while (!pending.empty()) {
    std::string name = std::move(pending.front());
    pending.pop_front();
    if (!seen.insert(name).second || modelNames.count(name)) continue;
    const auto found = embedded.find(name);
    if (found == embedded.end()) continue;
    const Entry& entry = *found->second;
    if (entry.size > kMaxCustomPart || static_cast<size_t>(entry.size) > kMaxCustomTotal - totalInflated)
      throw Error("Studio custom part geometry exceeds the import safety limits: " + name);
    totalInflated += entry.size;
    ldraw::File file = ldraw::parse(zip.read(entry, kMaxCustomPart), name);
    if (file.cmds.size() > kMaxPartCommands || file.cmds.size() > kMaxTotalCommands - totalCommands)
      throw Error("Studio custom part geometry contains too many LDraw commands: " + name);
    totalCommands += file.cmds.size();
    enqueueReferences(file, pending);
    result.customParts.push_back(std::move(file));
  }
  return result;
}

}  // namespace

std::string readStudioIo(std::string_view bytes) { return readArchive(bytes, false).model; }
StudioArchive readStudioArchive(std::string_view bytes) { return readArchive(bytes, true); }

}  // namespace bm::io
