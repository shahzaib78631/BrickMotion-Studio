#include "bmr/denoise.h"

#if BM_HAVE_OIDN
#include <OpenImageDenoise/oidn.h>
#endif

namespace bmr {

bool denoiserAvailable() { return BM_HAVE_OIDN != 0; }

bool denoise(PathImage& image, DenoiseDevice device, std::string* error) {
  auto fail = [&](const std::string& why) {
    if (error) *error = why;
    return false;
  };
  const size_t floats = static_cast<size_t>(image.width) * image.height * 3;
  if (image.width < 1 || image.height < 1 || image.beauty.size() != floats) return fail("the picture is empty");
#if BM_HAVE_OIDN
  const bool guided = image.albedo.size() == floats && image.normal.size() == floats;
  const size_t bytes = floats * sizeof(float);
  OIDNDevice dev = oidnNewDevice(device == DenoiseDevice::Metal ? OIDN_DEVICE_TYPE_METAL : OIDN_DEVICE_TYPE_CPU);
  if (!dev) return fail(device == DenoiseDevice::Metal ? "OIDN has no Metal device here" : "OIDN has no CPU device here");
  oidnCommitDevice(dev);
  // Buffers OIDN owns, so the same code serves a device that cannot read this process's memory.
  OIDNBuffer color = oidnNewBuffer(dev, bytes), albedo = guided ? oidnNewBuffer(dev, bytes) : nullptr, normal = guided ? oidnNewBuffer(dev, bytes) : nullptr,
             output = oidnNewBuffer(dev, bytes);
  OIDNFilter filter = oidnNewFilter(dev, "RT");
  const char* message = nullptr;
  if (oidnGetDeviceError(dev, &message) == OIDN_ERROR_NONE) {
    oidnWriteBuffer(color, 0, bytes, image.beauty.data());
    oidnSetFilterImage(filter, "color", color, OIDN_FORMAT_FLOAT3, image.width, image.height, 0, 0, 0);
    if (guided) {
      oidnWriteBuffer(albedo, 0, bytes, image.albedo.data());
      oidnWriteBuffer(normal, 0, bytes, image.normal.data());
      oidnSetFilterImage(filter, "albedo", albedo, OIDN_FORMAT_FLOAT3, image.width, image.height, 0, 0, 0);
      oidnSetFilterImage(filter, "normal", normal, OIDN_FORMAT_FLOAT3, image.width, image.height, 0, 0, 0);
    }
    oidnSetFilterImage(filter, "output", output, OIDN_FORMAT_FLOAT3, image.width, image.height, 0, 0, 0);
    oidnSetFilterBool(filter, "hdr", true);
    oidnCommitFilter(filter);
    oidnExecuteFilter(filter);
  }
  const bool ok = oidnGetDeviceError(dev, &message) == OIDN_ERROR_NONE;
  std::vector<float> result;
  if (ok) {
    result.resize(floats);
    oidnReadBuffer(output, 0, bytes, result.data());
  }
  const std::string why = ok ? "" : std::string("OIDN: ") + (message ? message : "failed");
  oidnReleaseFilter(filter);
  for (OIDNBuffer b : {color, albedo, normal, output})
    if (b) oidnReleaseBuffer(b);
  oidnReleaseDevice(dev);
  if (!ok) return fail(why);
  image.beauty = std::move(result);
  if (error) error->clear();
  return true;
#else
  (void)device;
  return fail("built without OIDN (it was not in vendor/oidn when configured)");
#endif
}

}  // namespace bmr
