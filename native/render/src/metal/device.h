// Private to bmrender's Metal half: the one device, queue and compiled shader library.
#pragma once
#import <Metal/Metal.h>

namespace bmr {

struct Device {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  id<MTLLibrary> library;  ///< every shader in native/render/shaders
};

/// The process's device, made on first use; nullptr when the machine has no Metal device or
/// the shaders do not compile. Thread-safe.
Device* sharedDevice();

}  // namespace bmr
