#pragma once
// Plan ids and the references between items (assembly.attachTo / after), which are scoped to the
// model an item is in. Items moved between models keep both consistent with these.
#include <set>
#include <string>
#include <vector>
#include "bm/doc/source.h"

namespace bmapp {

/// The plan ids ("id" in an item's object) of every item in `def`.
std::set<std::string> planIds(const bm::doc::Def& def);

/// Gives each of `moving` whose id is in `taken`, or repeats one before it, a fresh id ("a-2",
/// "a-3", ...), and points their references to each other at the new ids.
void repairIds(std::vector<bm::doc::Item>& moving, const std::set<std::string>& taken);

/// Drops every reference in `def` to an item that is not in `def`; an assembly left empty goes.
void keepRefsInside(bm::doc::Def& def);

/// The items of `def` (step, index) that reference one of `ids`.
std::vector<std::pair<size_t, size_t>> referencing(const bm::doc::Def& def, const std::set<std::string>& ids);

}  // namespace bmapp
