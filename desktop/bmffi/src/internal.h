#pragma once
// The handles behind the C interface's opaque types, shared by bmffi's source files.
#include "bmapp/session.h"
#include "bmapp/viewport.h"

struct BmSession {
  bmapp::Session* s;
};
struct BmViewport {
  bmapp::Viewport* v;
};
