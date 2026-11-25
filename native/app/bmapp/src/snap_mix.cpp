#include "snap_mix_impl.h"

#include <algorithm>
#include <cmath>
#include "bms/wav.h"

namespace bmapp {
namespace {

using Json = nlohmann::ordered_json;

struct Scale {
  const char* name;
  double SnapMix::* member;
  double min, max;
};

constexpr Scale scales[]{
    {"volume", &SnapMix::volume, 0, 1.5}, {"room", &SnapMix::room, 0, 1}, {"stereo", &SnapMix::stereo, 0, 1},
    {"click", &SnapMix::click, 0, 2}, {"brightness", &SnapMix::brightness, 500, 6000},
    {"thump", &SnapMix::thump, 0, 2}, {"thumpPitch", &SnapMix::thumpPitch, 0.5, 2},
    {"thumpLength", &SnapMix::thumpLength, 0.3, 2}, {"pitch", &SnapMix::pitch, 0.7, 1.4},
    {"variation", &SnapMix::variation, 0, 1}};

bool flag(const Json& object, const char* key, bool fallback) {
  const auto read = object.find(key);
  return read != object.end() && read->is_boolean() ? read->get<bool>() : fallback;
}

SnapMix webMix(const bms::WebSound& web) {
  SnapMix out;
  out.source = web.recorded ? SnapSource::Recorded : SnapSource::Synthesised;
  out.volume = web.volume, out.room = web.room, out.stereo = web.stereo;
  out.click = web.click, out.brightness = web.brightness;
  out.thump = web.thump, out.thumpPitch = web.thumpPitch, out.thumpLength = web.thumpLength;
  out.pitch = web.pitch, out.variation = web.variation, out.together = web.together;
  out.sizePitch = web.sizePitch, out.sizeMatch = web.sizeMatch;
  return out;
}

}  // namespace

SnapMix snapMixPreset(const std::string& name) {
  bms::WebSound style;
  return bms::webPreset(name, style) ? webMix(style) : SnapMix{};
}

SnapMix readSnapMix(const Json& video) {
  SnapMix out;
  out.enabled = flag(video, "snapSound", false);
  const auto sound = video.find("sound");
  if (sound == video.end() || !sound->is_object()) return out;
  const bool physical = video.contains("nativeSnapMode") && video["nativeSnapMode"] == "physical";
  if (!physical) {
    const bool enabled = out.enabled;
    out = webMix(bms::WebSound{});
    out.enabled = enabled;
    if (sound->contains("source") && (*sound)["source"] == "synth") out.source = SnapSource::Synthesised;
  }
  if (sound->contains("library")) {
    if ((*sound)["library"] == "freesound") out.library = SnapLibrary::Freesound;
    else if ((*sound)["library"] == "opengameart") out.library = SnapLibrary::OpenGameArt;
  }
  for (const auto& scale : scales) {
    const auto value = sound->find(scale.name);
    if (value != sound->end() && value->is_number() && std::isfinite(value->get<double>()))
      out.*(scale.member) = std::clamp(value->get<double>(), scale.min, scale.max);
  }
  out.sizePitch = flag(*sound, "sizePitch", out.sizePitch);
  out.sizeMatch = flag(*sound, "sizeMatch", out.sizeMatch);
  const auto together = sound->find("together");
  if (together != sound->end() && together->is_number() && std::isfinite(together->get<double>()))
    out.together = static_cast<int>(std::lround(std::clamp(together->get<double>(), 1.0, 3.0)));
  return out;
}

bool validSnapMix(const SnapMix& mix) {
  return mix.together >= 1 && mix.together <= 3 &&
      std::ranges::all_of(scales, [&](const auto& scale) {
        const double v = mix.*(scale.member);
        return v >= scale.min && v <= scale.max;
      });
}

void writeSnapMix(Json& video, const SnapMix& mix) {
  video["snapSound"] = mix.enabled;
  if (mix.source == SnapSource::Physical) video["nativeSnapMode"] = "physical";
  else video.erase("nativeSnapMode");
  auto& sound = video["sound"];
  if (!sound.is_object()) sound = Json::object();
  sound["source"] = mix.source == SnapSource::Recorded ? "recorded" : "synth";
  sound["library"] = mix.library == SnapLibrary::Freesound ? "freesound" :
                     mix.library == SnapLibrary::OpenGameArt ? "opengameart" : "all";
  sound["sizePitch"] = mix.sizePitch;
  sound["sizeMatch"] = mix.sizeMatch;
  sound["together"] = mix.together;
  for (const auto& scale : scales) sound[scale.name] = mix.*(scale.member);
}

bms::SoundOptions snapOptions(const SnapMix& mix, const std::string& recordings) {
  bms::SoundOptions output;
  output.recordings = recordings;
  if (mix.source == SnapSource::Physical) {
    output.peak = std::min(0.99, output.peak * mix.volume);
    output.room = mix.room;
    output.stereo = mix.stereo;
  } else {
    output.style = bms::SoundStyle::Web;
    auto& web = output.web;
    web.recorded = mix.source == SnapSource::Recorded;
    if (mix.library == SnapLibrary::Freesound) web.library = bms::WebSound::Library::Freesound;
    else if (mix.library == SnapLibrary::OpenGameArt) web.library = bms::WebSound::Library::OpenGameArt;
    web.volume = mix.volume, web.room = mix.room, web.stereo = mix.stereo;
    web.click = mix.click, web.brightness = mix.brightness, web.thump = mix.thump;
    web.thumpPitch = mix.thumpPitch, web.thumpLength = mix.thumpLength;
    web.pitch = mix.pitch, web.variation = mix.variation, web.together = mix.together;
    web.sizePitch = mix.sizePitch, web.sizeMatch = mix.sizeMatch;
  }
  return output;
}

bool writeSnapPreview(const SnapMix& mix, SnapExample example, const std::string& recordings, const std::string& file) {
  if (!validSnapMix(mix) || file.empty()) return false;
  bms::SnapEvent event;
  event.frame = 9;
  event.mates = example == SnapExample::Brick ? 6 : 2;
  event.ridge = example == SnapExample::Pin;
  event.grip = example == SnapExample::Pin ? 20 : 4;
  const bm::Vec3 size = example == SnapExample::Brick ? bm::Vec3{80, 24, 40} :
                        example == SnapExample::Plate ? bm::Vec3{40, 8, 20} : bm::Vec3{16, 16, 40};
  event.unit = {{0, -size.y, 0}, {size.x, 0, size.z}};
  event.touching = {{0, 0, 0}, {80, 24, 80}};
  event.built = event.touching;
  event.built.merge(event.unit);
  event.builtPieces = 12;
  event.seatSeconds = 0.12;
  bms::Mixer mixer({event}, 48, 30, snapOptions(mix, recordings));
  return bms::writeWav(mixer, file);
}

}  // namespace bmapp
