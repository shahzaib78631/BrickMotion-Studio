#pragma once
#include "bmapp/types.h"

namespace bmapp {

/// Browse the library itself, independent of any document. Empty query browses by category;
/// a nonempty query matches every word, with an exact part number first.
std::vector<PartMatch> libraryParts(const std::string& ldraw, const std::string& query,
                                    const std::string& category, size_t limit);
StringList partCategories(const std::string& ldraw);
std::vector<PartMatch> commonParts(const std::string& ldraw);

}  // namespace bmapp
