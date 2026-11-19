#pragma once
// The kinds of file the app opens. The project is the document; the rest are imports.
#include <string>
#include <vector>

namespace bmapp {

struct DocType {
  std::string uti;        ///< e.g. "com.brickmotion.project"
  std::string extension;  ///< without the dot
  std::string name;       ///< shown in Open and Save panels
  bool project = false;   ///< the app's own document; every other type opens as a new project
};

/// The project first, then imports, in the order the Open panel lists them.
std::vector<DocType> documentTypes();
/// True for the project's extension, whatever its case.
bool isProjectExtension(const std::string& extension);

}  // namespace bmapp
