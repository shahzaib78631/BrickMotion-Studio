#pragma once
#include <string>
#include <vector>

namespace bmapp {

enum class MovieSource { Build, Keyframes, Turntable };
enum class LogoCorner { TopLeft, TopRight, BottomLeft, BottomRight };

/// Movie settings for an isolated export viewport. Angles are radians.
struct MovieSettings {
  MovieSource source = MovieSource::Build;
  int width = 1920, height = 1080, fps = 30;
  int bitRate = 0;  ///< 0 uses the encoder's default
  bool viewportAngle = false, orthographic = false;
  bool standardPreview = false;
  /// A Build video is filmed with the project's Camera track (when it has keys) rather than the
  /// automatic camera: the web's exportCamera "track".
  bool cameraTrack = false;
  double yaw = 0, pitch = 0, fieldOfView = 0.6;
  double turntableSeconds = 8;
  std::string sceneCameraId;
  std::string snapRecordings;
  std::string snapWave;  ///< optional PCM intermediate for a generated native Build
  std::string logo;      ///< optional image file drawn over every frame, as the web's video logo
  LogoCorner logoCorner = LogoCorner::BottomRight;
};

/// Draws the logo over a PNG in place, as every video frame gets it. "" on success, else why.
std::string stampLogo(const std::string& png, const std::string& logo, LogoCorner corner);
/// Encodes the snap track (PCM WAV) as AAC and writes it under the picture-only movie at
/// `destination`. "" on success, else why.
std::string muxSnapAudio(const std::string& video, const std::string& wave, const std::string& destination);
/// The movie helper: `project [--out file] [options…]`. Prints why it failed to stderr; 0 on success.
int runEditorMovie(const std::vector<std::string>& args);

}  // namespace bmapp
