#import "metal/device.h"

#include <mutex>
#include <string>
#include "bmr/device.h"

namespace bmr {
extern const char* const kShaderSource[];

namespace {
std::once_flag gOnce;
Device* gDevice = nullptr;
std::string gError;

void make() {
  @autoreleasepool {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) {
      gError = "no Metal device";
      return;
    }
    // The shaders are compiled here, from their text, because the offline compiler is an
    // optional download that this project does not require. A test compiles them too, so a
    // mistake in one fails the test run rather than the first launch.
    NSMutableString* source = [NSMutableString string];
    for (size_t i = 0; kShaderSource[i]; i++) [source appendString:[NSString stringWithUTF8String:kShaderSource[i]]];
    MTLCompileOptions* options = [MTLCompileOptions new];
    options.languageVersion = MTLLanguageVersion3_1;
    NSError* error = nil;
    id<MTLLibrary> library = [device newLibraryWithSource:source options:options error:&error];
    if (!library) {
      gError = error ? std::string(error.localizedDescription.UTF8String) : "the shaders did not compile";
      return;
    }
    gDevice = new Device{device, [device newCommandQueue], library};
  }
}
}  // namespace

Device* sharedDevice() {
  std::call_once(gOnce, make);
  return gDevice;
}

bool gpuAvailable() { return sharedDevice() != nullptr; }
const char* shaderError() {
  sharedDevice();
  return gError.c_str();
}

}  // namespace bmr
