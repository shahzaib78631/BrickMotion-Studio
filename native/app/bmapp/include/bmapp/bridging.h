#pragma once
// Swift's annotations for C++ types, empty when the header is not on the path.
#if __has_include(<swift/bridging>)
#include <swift/bridging>
#else
#define SWIFT_SHARED_REFERENCE(retain, release)
#define SWIFT_RETURNS_RETAINED
#define SWIFT_NAME(name)
#endif
