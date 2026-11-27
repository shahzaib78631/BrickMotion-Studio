#import "ViewportView.h"

#import <QuartzCore/QuartzCore.h>
#include <algorithm>
#include <cmath>
#include <vector>
#include "bm/plan/timeline.h"
#include "bmr/camera.h"
#include "bmr/device.h"
#include "bmr/tolerances.h"

namespace {
constexpr double kWheelZoom = 0.1;        // a wheel notch zooms by e^-0.1
constexpr double kClickSlop = 3;          // points a press may wander and still be a click
constexpr double kReadoutSeconds = 0.25;
}  // namespace

@interface ViewportView () <CAMetalDisplayLinkDelegate>
@end

@implementation ViewportView {
  bmview::Session* _session;
  CAMetalDisplayLink* _link;
  NSTextField* _readout;
  NSTimer* _readoutTimer;

  bmr::OrbitCamera _orbit;
  bmr::FrameOptions _options;
  bool _dirty;
  CFTimeInterval _lastMotion;
  int _width, _height;  // pixels

  // Playback. _frame is -1 until there is a plan (the model is shown finished).
  double _frame;
  bool _playing, _userMoved;
  double _playStartTime;
  double _playStartFrame;

  // The mouse.
  NSPoint _pressedAt, _lastAt;
  bool _dragged;

  // Native 3D World scene camera (+Y up: seamless FPS flythrough & 3D orbit!).
  bm::Vec3 _wEye, _wTarget;
  double _wYaw, _wPitch, _wDist, _wFovDeg;
  bool _wFreeFly;
  uint32_t _wKeys;  // bit 0:W, 1:S, 2:A, 3:D, 4:E/2(up), 5:Q/1(down), 6:Shift
  CFTimeInterval _wLastTick;
  double _wSunAzimuth, _wSunElevation;

  // The readout's running sums since it last showed them.
  double _cpuSum, _gpuSum;
  int _framesSummed;
  bmr::FrameStats _lastStats;
}

- (instancetype)initWithFrame:(NSRect)frame session:(bmview::Session*)session {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  _session = session;
  _frame = -1;
  _dirty = true;
  // The shadow and height maps are drawn again over frames while the view turns or pieces move.
  _options.mapTrianglesPerFrame = bmr::kMapTrianglesPerFrame;
  _options.refractiveGlass = session->raytracedGlass;
  _options.screenSpaceGi = false;
  _options.hybridRt = false;
  _options.studioLook = !session->realtimePathTrace;
  _options.neuralShader = !session->realtimePathTrace;
  _options.realtimePathTrace = session->realtimePathTrace;
  _options.pathTraced = false;
  _options.pathMaxSamples = 64;
  _options.pathSamplesPerFrame = 2;
  self.wantsLayer = YES;
  self.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;

  _readout = [NSTextField labelWithString:@""];
  _readout.font = [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightMedium];
  _readout.textColor = session->isWorld ? NSColor.whiteColor : NSColor.secondaryLabelColor;
  if (session->isWorld) {
    _readout.wantsLayer = YES;
    _readout.drawsBackground = YES;
    _readout.backgroundColor = [NSColor colorWithWhite:0.06 alpha:0.62];
    _readout.layer.cornerRadius = 5;
    _readout.layer.masksToBounds = YES;
  }
  _readout.translatesAutoresizingMaskIntoConstraints = NO;
  [self addSubview:_readout];
  [NSLayoutConstraint activateConstraints:@[
    [_readout.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:12],
    [_readout.topAnchor constraintEqualToAnchor:self.topAnchor constant:10],
  ]];
  if (session->isWorld) {
    const float* s = session->worldOptions.sunDir;
    const double slen = std::max(1e-6, std::sqrt(double(s[0]) * s[0] + double(s[1]) * s[1] + double(s[2]) * s[2]));
    _wSunElevation = std::asin(std::clamp(double(s[1]) / slen, -0.95, 0.95));
    _wSunAzimuth = std::atan2(double(s[0]), double(s[2]));
    _wFreeFly = session->worldHasDefaultView;
    _wFovDeg = session->worldDefaultFovDeg;
    _wLastTick = CACurrentMediaTime();
  }
  return self;
}

- (CALayer*)makeBackingLayer {
  CAMetalLayer* layer = [CAMetalLayer layer];
  layer.device = (__bridge id<MTLDevice>)bmr::gpuDevice();
  layer.pixelFormat = MTLPixelFormatBGRA8Unorm_sRGB;
  layer.framebufferOnly = YES;
  CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  layer.colorspace = srgb;
  CGColorSpaceRelease(srgb);
  return layer;
}

- (CAMetalLayer*)metalLayer { return (CAMetalLayer*)self.layer; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isOpaque { return YES; }

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  if (!self.window) return;
  [self.window makeFirstResponder:self];
  [self updateSize];
  [self frameModel];  // now that the shape of the view is known
  if (!_link) {
    _link = [[CAMetalDisplayLink alloc] initWithMetalLayer:self.metalLayer];
    _link.delegate = self;
    _link.preferredFrameRateRange = CAFrameRateRangeMake(60, 120, 120);
    [_link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  }
  if (!_readoutTimer) {
    __weak ViewportView* weakSelf = self;
    _readoutTimer = [NSTimer scheduledTimerWithTimeInterval:kReadoutSeconds repeats:YES block:^(NSTimer*) { [weakSelf showReadout]; }];
  }
  [self changed];
}

- (void)stop {
  [_link invalidate];
  _link = nil;
  [_readoutTimer invalidate];
  _readoutTimer = nil;
}

// ---- size ----

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  [self updateSize];
}

- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  [self updateSize];
}

- (void)updateSize {
  const double scale = self.window ? self.window.backingScaleFactor : 2.0;
  self.metalLayer.contentsScale = scale;
  const int w = static_cast<int>(std::lround(self.bounds.size.width * scale)), h = static_cast<int>(std::lround(self.bounds.size.height * scale));
  if (w == _width && h == _height) return;
  _width = w, _height = h;
  if (w > 0 && h > 0) self.metalLayer.drawableSize = CGSizeMake(w, h);
  if (_session->isWorld) _session->world->resize(w, h);
  else _session->renderer->resize(w, h);
  [self changed];
}

- (double)aspect { return _height > 0 ? double(_width) / _height : 1.0; }

- (bmr::Camera)worldCamera {
  const bm::Box& b = _session->world->bounds();
  const double diag = b.empty() ? 10.0 : std::max(0.05, bm::length(b.max - b.min));
  bmr::Camera c;
  c.eye = _wEye;
  c.target = _wTarget;
  c.up = {0, 1, 0};
  c.fovY = _wFovDeg * M_PI / 180.0;
  c.aspect = self.aspect;
  c.near = std::max(diag * 2e-4, 0.01);
  c.far = std::max(bm::length(((b.min + b.max) * 0.5) - c.eye) + diag * 2.0, diag * 4.0);
  return c;
}

- (void)syncWorldFromEyeTarget {
  bm::Vec3 f = _wTarget - _wEye;
  _wDist = std::max(1e-3, bm::length(f));
  f = f * (1.0 / _wDist);
  _wPitch = std::asin(std::clamp(f.y, -0.995, 0.995));
  _wYaw = std::atan2(f.x, f.z);
}

- (void)syncWorldSun {
  const double ce = std::cos(_wSunElevation);
  _session->worldOptions.sunDir[0] = static_cast<float>(ce * std::sin(_wSunAzimuth));
  _session->worldOptions.sunDir[1] = static_cast<float>(std::sin(_wSunElevation));
  _session->worldOptions.sunDir[2] = static_cast<float>(ce * std::cos(_wSunAzimuth));
}

- (void)tickWorldKeys {
  const CFTimeInterval now = CACurrentMediaTime();
  const double dt = std::clamp(now - _wLastTick, 0.001, 0.1);
  _wLastTick = now;
  if ((_wKeys & 0x3Fu) == 0u) return;
  const bm::Box& b = _session->world->bounds();
  const double diag = b.empty() ? 10.0 : std::max(0.1, bm::length(b.max - b.min));
  const double speed = diag * 0.12 * dt * ((_wKeys & 64u) ? 3.5 : 1.0);
  const bm::Vec3 fwd = bm::normalized(_wTarget - _wEye);
  bm::Vec3 rgt = bm::cross(fwd, bm::Vec3{0, 1, 0});
  rgt = bm::length(rgt) > 1e-6 ? bm::normalized(rgt) : bm::Vec3{1, 0, 0};
  bm::Vec3 delta{0, 0, 0};
  if (_wKeys & 1u) delta = delta + fwd * speed;
  if (_wKeys & 2u) delta = delta - fwd * speed;
  if (_wKeys & 8u) delta = delta + rgt * speed;
  if (_wKeys & 4u) delta = delta - rgt * speed;
  if (_wKeys & 16u) delta.y += speed;
  if (_wKeys & 32u) delta.y -= speed;
  _wEye = _wEye + delta;
  _wTarget = _wTarget + delta;
  [self moved];
}

// ---- drawing ----

/// Something the picture shows has changed: draw on the next refresh.
- (void)changed {
  _dirty = true;
  _link.paused = NO;
}

- (void)metalDisplayLink:(CAMetalDisplayLink*)link needsUpdate:(CAMetalDisplayLinkUpdate*)update {
  if (_session->isWorld) {
    [self tickWorldKeys];
    if (!_dirty && (_wKeys & 0x3Fu) == 0u) {
      link.paused = YES;
      return;
    }
    bmr::WorldRenderer& w = *_session->world;
    const bmr::FrameStats s = w.draw([self worldCamera], _session->worldOptions, (__bridge void*)update.drawable);
    _dirty = ((_wKeys & 0x3Fu) != 0u) || s.settling || (!s.submitted && _width > 0 && _height > 0);
    if (s.submitted) {
      _lastStats = s;
      _cpuSum += s.cpuMs, _gpuSum += w.lastGpuMs(), _framesSummed++;
    }
    return;
  }
  if (_playing) [self advance];
  if (!_dirty) {
    link.paused = YES;  // nothing changed: an idle window draws nothing
    return;
  }
  bmr::Renderer& r = *_session->renderer;
  bmr::FrameOptions options = _options;
  // Once the view has been still for a moment, switch seamlessly to progressive path tracing
  // (exact offline bmexport quality) or ray-traced glass.
  const bool still = !_playing && CACurrentMediaTime() - _lastMotion >= 0.08;
  options.refractiveGlass = _options.refractiveGlass && still;
  options.pathTraced = _options.pathTraced && still;
  const bmr::FrameStats s = r.draw(_orbit.camera(self.aspect, r.scene().bounds), options, (__bridge void*)update.drawable);
  // A frame not sent (the drawable had not caught up with a resize) is drawn on the next
  // refresh, as is one whose maps or progressive path-traced samples are still converging.
  _dirty = _playing || (_options.refractiveGlass && !options.refractiveGlass) || (_options.pathTraced && !options.pathTraced) || s.settling || (!s.submitted && _width > 0 && _height > 0);
  if (s.submitted) {
    _lastStats = s;
    _cpuSum += s.cpuMs, _gpuSum += r.lastGpuMs(), _framesSummed++;
  }
}

/// Playback goes by the clock: frames that could not be drawn in time are skipped.
- (void)advance {
  const bmtools::Planned& p = *_session->planned;
  const double fps = bm::plan::Style{}.fps;
  const double f = std::min(static_cast<double>(p.timeline.frames), _playStartFrame + (CACurrentMediaTime() - _playStartTime) * fps);
  [self showFrame:f];
  if (f >= p.timeline.frames) _playing = false;
}

- (void)showFrame:(double)f {
  if (!_session->planned) return;
  const bmtools::Planned& p = *_session->planned;
  f = std::clamp(f, 0.0, static_cast<double>(p.timeline.frames));
  if (f == _frame) return;
  _frame = f;
  _session->renderer->setFrame(p.plan, p.timeline, f);
  if (_playing && !_userMoved && !p.timeline.camera.empty()) _orbit = bmr::OrbitCamera::along(p.timeline, f);
  [self changed];
}

/// W: the next flight shape (carried there, web, arc), laid out again from the same plan; no replanning.
- (void)switchFlight {
  if (!_session->planned) return;
  if (_session->planner == bm::plan::Planner::Legacy) {  // the web's planner has one flight shape
    std::fprintf(stderr, "bmview: --planner legacy has a single flight shape\n");
    return;
  }
  _session->flight = _session->flight == bm::plan::FlightShape::Auto ? bm::plan::FlightShape::Web
    : _session->flight == bm::plan::FlightShape::Web ? bm::plan::FlightShape::Arc : bm::plan::FlightShape::Auto;
  bm::plan::Style style = bm::plan::styleOf(_session->file);
  style.shape = _session->flight;
  style.planner = _session->planner;
  bmtools::Planned& p = *_session->planned;
  p.timeline = bm::plan::buildTimeline(*_session->model, *_session->full, p.plan, style);
  const char* name = _session->flight == bm::plan::FlightShape::Arc ? "arc" : _session->flight == bm::plan::FlightShape::Web ? "web" : "auto";
  std::fprintf(stderr, "bmview: flights %s\n", name);
  self.window.subtitle = [NSString stringWithFormat:@"flights: %s", name];
  const double at = std::min(_frame, static_cast<double>(p.timeline.frames));
  _frame = -2;  // drawn again at the same moment
  [self showFrame:at];
}

- (void)planReady:(BOOL)play {
  _frame = _session->planned->timeline.frames;  // the finished model, which is what is shown
  if (play) [self togglePlay];
  [self changed];
}

- (void)togglePlay {
  if (!_session->planned) return;
  if (_playing) {
    _playing = false;
  } else {
    if (_frame >= _session->planned->timeline.frames) [self showFrame:0];
    _playing = true, _userMoved = false;
    _playStartTime = CACurrentMediaTime(), _playStartFrame = _frame;
  }
  [self changed];
}

- (void)step:(int)by {
  _playing = false;
  [self showFrame:(by == INT_MIN ? 0 : by == INT_MAX ? _session->planned->timeline.frames : _frame + by)];
}

// ---- the readout ----

- (void)showReadout {
  if (_readout.hidden) return;
  if (_session->isWorld) {
    bmr::WorldRenderer& w = *_session->world;
    const double cpu = _framesSummed ? _cpuSum / _framesSummed : _lastStats.cpuMs;
    const double gpu = _framesSummed ? _gpuSum / _framesSummed : w.lastGpuMs();
    const double fps = gpu > 0.05 ? std::min(999.0, 1000.0 / gpu) : 0.0;
    const char* look = _session->worldOptions.clay ? "CLAY" : (_session->worldOptions.studioRig ? "STUDIO" : "PBR");
    const char* nav = _wFreeFly ? "FLY" : "ORBIT";
    _readout.stringValue = [NSString stringWithFormat:@" %.1f ms gpu (%.0f fps) · %.1f ms cpu · %.1fk tris · %u meshes · %u tex · RTPT %s (%u spp) · %s [WASD/QE · C Clay · L Rig · [/] Sun · O Nav] ",
                                                      gpu, fps, cpu, w.triangleCount() / 1000.0, w.meshCount(), w.textureCount(),
                                                      look, _lastStats.pathSamples, nav];
    _cpuSum = _gpuSum = 0, _framesSummed = 0;
    return;
  }
  const bmr::Scene& scene = _session->renderer->scene();
  const size_t total = scene.where.size();
  NSString* frame = _session->planned
      ? [NSString stringWithFormat:@"frame %d / %d", static_cast<int>(_frame), _session->planned->timeline.frames]
      : (_session->noPlan ? @"model" : @"planning…");
  const double cpu = _framesSummed ? _cpuSum / _framesSummed : _lastStats.cpuMs;
  const double gpu = _framesSummed ? _gpuSum / _framesSummed : _session->renderer->lastGpuMs();
  const double fps = gpu > 0.05 ? std::min(999.0, 1000.0 / gpu) : 0.0;
  NSString* mode = _options.realtimePathTrace
      ? [NSString stringWithFormat:@" · RTPT (%u spp)", _lastStats.pathSamples]
      : (_options.neuralShader
             ? @" · NEURAL"
             : (_options.studioLook
                    ? (_lastStats.worldGiReady
                           ? (_options.worldGiOcclusion ? @" · STUDIO + World GI + Vis" : @" · STUDIO + World GI")
                           : (_lastStats.worldGiBaking ? @" · STUDIO (World GI baking…)" : @" · STUDIO"))
                    : @""));
  _readout.stringValue = [NSString stringWithFormat:@"%@ · cpu %.1f ms · gpu %.1f ms (%.0f fps) · %.1fk tris · %u/%zu parts%@", frame, cpu, gpu, fps,
                                                    _lastStats.triangles / 1000.0, _lastStats.instances, total, mode];
  _cpuSum = _gpuSum = 0, _framesSummed = 0;
}

// ---- the camera ----

- (void)frameBounds:(const bm::Box&)box {
  if (box.empty()) return;
  _orbit = bmr::OrbitCamera::fitted(box, _orbit.fovY, self.aspect, _orbit.azimuth, _orbit.elevation);
  [self moved];
}

- (void)frameModel {
  if (_session->isWorld) {
    if (_session->worldHasDefaultView) {
      _wEye = _session->worldDefaultEye;
      _wTarget = _session->worldDefaultTarget;
      _wFovDeg = _session->worldDefaultFovDeg;
    } else {
      const bm::Box& b = _session->world->bounds();
      const bm::Vec3 center = b.empty() ? bm::Vec3{0, 0, 0} : (b.min + b.max) * 0.5;
      const double diag = b.empty() ? 5.0 : std::max(0.05, bm::length(b.max - b.min));
      const double fovRad = _wFovDeg * M_PI / 180.0;
      const double halfY = fovRad * 0.5;
      const double halfX = std::atan(std::tan(halfY) * self.aspect);
      const double dist = 1.02 * (diag * 0.5) / std::sin(std::min(halfY, halfX));
      const double az = 0.62, el = 0.24, ce = std::cos(el);
      _wTarget = center;
      _wEye = center + bm::Vec3{ce * std::sin(az), std::sin(el), ce * std::cos(az)} * dist;
    }
    [self syncWorldFromEyeTarget];
    [self moved];
    return;
  }
  [self frameBounds:_session->renderer->scene().bounds];
}

- (void)frameSelectionOrModel {
  const bm::Box box = _session->renderer->selectionBounds();  // where the selected pieces are shown now, mid-flight too
  if (box.empty()) [self frameModel];
  else [self frameBounds:box];
}

/// The user moved the camera.
- (void)moved {
  _lastMotion = CACurrentMediaTime();
  if (_playing) _userMoved = true;
  [self changed];
}

- (double)pixelsPerPoint { return self.window ? self.window.backingScaleFactor : 2.0; }

/// Zooms by `factor` keeping the point under `at` (view points) where it is on the screen.
- (void)zoom:(double)factor toward:(NSPoint)at {
  const double s = self.pixelsPerPoint;
  const double ox = (at.x - self.bounds.size.width / 2) * s, oy = (self.bounds.size.height / 2 - at.y) * s;  // pixels from the middle, down positive
  _orbit.pan(-(1 - factor) * ox, -(1 - factor) * oy, _height);
  _orbit.zoom(factor);
  [self moved];
}

// ---- the mouse ----

- (void)mouseDown:(NSEvent*)event {
  _pressedAt = _lastAt = [self convertPoint:event.locationInWindow fromView:nil];
  _dragged = false;
}

- (void)mouseDragged:(NSEvent*)event {
  const NSPoint at = [self convertPoint:event.locationInWindow fromView:nil];
  if (std::hypot(at.x - _pressedAt.x, at.y - _pressedAt.y) > kClickSlop) _dragged = true;
  if (!_dragged) return;
  const double dx = at.x - _lastAt.x, dy = at.y - _lastAt.y;
  _lastAt = at;
  if (_session->isWorld) {
    if (_wFreeFly) {
      _wYaw -= dx * 0.0055;
      _wPitch = std::clamp(_wPitch + dy * 0.0055, -1.48, 1.48);
      const double cp = std::cos(_wPitch);
      const bm::Vec3 fwd{cp * std::sin(_wYaw), std::sin(_wPitch), cp * std::cos(_wYaw)};
      _wTarget = _wEye + fwd * _wDist;
    } else {
      _wYaw -= dx * 0.007;
      _wPitch = std::clamp(_wPitch - dy * 0.007, -1.48, 1.48);
      const double cp = std::cos(_wPitch);
      const bm::Vec3 fwd{cp * std::sin(_wYaw), std::sin(_wPitch), cp * std::cos(_wYaw)};
      _wEye = _wTarget - fwd * _wDist;
    }
    [self moved];
    return;
  }
  _orbit.drag(dx, -dy);  // view points have y up; drag() takes it down
  [self moved];
}

- (void)mouseUp:(NSEvent*)event {
  if (_dragged) return;
  if (event.clickCount == 2) {
    if (_session->isWorld) [self frameModel];
    else [self frameSelectionOrModel];
    return;
  }
  if (_session->isWorld) return;
  const NSPoint at = [self convertPoint:event.locationInWindow fromView:nil];
  const double s = self.pixelsPerPoint;
  const uint32_t piece = _session->renderer->pick(static_cast<int>(at.x * s), static_cast<int>((self.bounds.size.height - at.y) * s));
  if (piece == UINT32_MAX) _session->renderer->select({});
  else _session->renderer->select({piece});
  [self changed];
}

- (void)rightMouseDown:(NSEvent*)event { _lastAt = [self convertPoint:event.locationInWindow fromView:nil]; }

- (void)rightMouseDragged:(NSEvent*)event {
  const NSPoint at = [self convertPoint:event.locationInWindow fromView:nil];
  const double s = self.pixelsPerPoint;
  if (_session->isWorld) {
    const double perPx = 2.0 * _wDist * std::tan(_wFovDeg * M_PI / 360.0) / std::max(1, _height);
    const bm::Vec3 fwd = bm::normalized(_wTarget - _wEye);
    const bm::Vec3 rgt = bm::normalized(bm::cross(fwd, bm::Vec3{0, 1, 0}));
    const bm::Vec3 up = bm::cross(rgt, fwd);
    const bm::Vec3 shift = rgt * (-(at.x - _lastAt.x) * s * perPx) + up * (-(at.y - _lastAt.y) * s * perPx);
    _wEye = _wEye + shift;
    _wTarget = _wTarget + shift;
    _lastAt = at;
    [self moved];
    return;
  }
  _orbit.pan((at.x - _lastAt.x) * s, -(at.y - _lastAt.y) * s, _height);
  _lastAt = at;
  [self moved];
}

- (void)scrollWheel:(NSEvent*)event {
  if (_session->isWorld) {
    const double dy = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY * 0.08 : event.scrollingDeltaY;
    const double factor = std::exp(-kWheelZoom * dy);
    if (_wFreeFly) {
      const bm::Box& b = _session->world->bounds();
      const double diag = b.empty() ? 10.0 : std::max(0.1, bm::length(b.max - b.min));
      const bm::Vec3 fwd = bm::normalized(_wTarget - _wEye);
      const bm::Vec3 step = fwd * (dy * diag * 0.008);
      _wEye = _wEye + step;
      _wTarget = _wTarget + step;
    } else {
      const bm::Vec3 fwd = bm::normalized(_wTarget - _wEye);
      _wDist = std::max(1e-3, _wDist * factor);
      _wEye = _wTarget - fwd * _wDist;
    }
    [self moved];
    return;
  }
  if (event.hasPreciseScrollingDeltas) {  // two fingers on a trackpad: pan
    const double s = self.pixelsPerPoint;
    _orbit.pan(event.scrollingDeltaX * s, event.scrollingDeltaY * s, _height);
    [self moved];
  } else if (event.scrollingDeltaY != 0) {  // a wheel: zoom
    [self zoom:std::exp(-kWheelZoom * event.scrollingDeltaY) toward:[self convertPoint:event.locationInWindow fromView:nil]];
  }
}

- (void)magnifyWithEvent:(NSEvent*)event {
  if (_session->isWorld) {
    const double factor = 1.0 / std::max(0.1, 1.0 + event.magnification);
    const bm::Vec3 fwd = bm::normalized(_wTarget - _wEye);
    _wDist = std::max(1e-3, _wDist * factor);
    _wEye = _wTarget - fwd * _wDist;
    [self moved];
    return;
  }
  [self zoom:1.0 / std::max(0.1, 1.0 + event.magnification) toward:[self convertPoint:event.locationInWindow fromView:nil]];
}

// ---- keys ----

- (void)flagsChanged:(NSEvent*)event {
  if (_session->isWorld) {
    if (event.modifierFlags & NSEventModifierFlagShift) _wKeys |= 64u;
    else _wKeys &= ~64u;
  }
  [super flagsChanged:event];
}

- (void)keyUp:(NSEvent*)event {
  if (_session->isWorld) {
    NSString* keys = event.charactersIgnoringModifiers;
    if (keys.length > 0) {
      switch ([keys characterAtIndex:0]) {
        case 'w': case 'W': _wKeys &= ~1u; return;
        case 's': case 'S': _wKeys &= ~2u; return;
        case 'a': case 'A': _wKeys &= ~4u; return;
        case 'd': case 'D': _wKeys &= ~8u; return;
        case 'e': case 'E': case '2': _wKeys &= ~16u; return;
        case 'q': case 'Q': case '1': _wKeys &= ~32u; return;
        default: break;
      }
    }
  }
  [super keyUp:event];
}

- (void)keyDown:(NSEvent*)event {
  NSString* keys = event.charactersIgnoringModifiers;
  if (keys.length == 0) return;
  const unichar k = [keys characterAtIndex:0];
  if (_session->isWorld) {
    if (event.modifierFlags & NSEventModifierFlagShift) _wKeys |= 64u;
    else _wKeys &= ~64u;
    switch (k) {
      case 'w': case 'W': _wKeys |= 1u; _wLastTick = CACurrentMediaTime(); [self changed]; return;
      case 's': case 'S': _wKeys |= 2u; _wLastTick = CACurrentMediaTime(); [self changed]; return;
      case 'a': case 'A': _wKeys |= 4u; _wLastTick = CACurrentMediaTime(); [self changed]; return;
      case 'd': case 'D': _wKeys |= 8u; _wLastTick = CACurrentMediaTime(); [self changed]; return;
      case 'e': case 'E': case '2': _wKeys |= 16u; _wLastTick = CACurrentMediaTime(); [self changed]; return;
      case 'q': case 'Q': case '1': _wKeys |= 32u; _wLastTick = CACurrentMediaTime(); [self changed]; return;
      case ' ': case 'f': case 'F': [self frameModel]; return;
      case 'c': case 'C': _session->worldOptions.clay = !_session->worldOptions.clay; [self changed]; return;
      case 'l': case 'L': _session->worldOptions.studioRig = !_session->worldOptions.studioRig; [self changed]; return;
      case 'g': case 'G': _session->worldOptions.floor = !_session->worldOptions.floor; [self changed]; return;
      case 'o': case 'O': _wFreeFly = !_wFreeFly; [self showReadout]; return;
      case '[': _wSunAzimuth -= 0.12; [self syncWorldSun]; [self changed]; return;
      case ']': _wSunAzimuth += 0.12; [self syncWorldSun]; [self changed]; return;
      case '-': case '_': _session->worldOptions.exposure = std::max(0.15f, _session->worldOptions.exposure * 0.85f); [self changed]; return;
      case '=': case '+': _session->worldOptions.exposure = std::min(8.0f, _session->worldOptions.exposure * 1.18f); [self changed]; return;
      case 'i': case 'I': _readout.hidden = !_readout.hidden; [self showReadout]; return;
      default: [super keyDown:event]; return;
    }
  }
  switch (k) {
    case ' ': [self togglePlay]; return;
    case NSLeftArrowFunctionKey: if (_session->planned) [self step:-1]; return;
    case NSRightArrowFunctionKey: if (_session->planned) [self step:1]; return;
    case NSHomeFunctionKey: if (_session->planned) [self step:INT_MIN]; return;
    case NSEndFunctionKey: if (_session->planned) [self step:INT_MAX]; return;
    case 'f': case 'F': [self frameModel]; return;
    case 'e': case 'E': _options.edges = !_options.edges; break;
    case 's': case 'S': _options.shadows = !_options.shadows; break;
    case 'a': case 'A': _options.ambientOcclusion = !_options.ambientOcclusion; break;
    case 'g': case 'G': _options.refractiveGlass = !_options.refractiveGlass; break;
    case 'r': case 'R': _options.screenSpaceGi = !_options.screenSpaceGi; break;
    case 'p': case 'P': _options.pathTraced = !_options.pathTraced; break;
    case 'h': case 'H': _options.hybridRt = !_options.hybridRt;
      if (_options.hybridRt) _options.studioLook = false; break;
    case 't': case 'T': _options.realtimePathTrace = !_options.realtimePathTrace;
      if (_options.realtimePathTrace) _options.studioLook = _options.neuralShader = _options.hybridRt = _options.screenSpaceGi = _options.pathTraced = false; break;
    case 'k': case 'K': _options.studioLook = !_options.studioLook;
      if (_options.studioLook) _options.realtimePathTrace = _options.hybridRt = _options.screenSpaceGi = _options.pathTraced = _options.neuralShader = false; break;
    case 'n': case 'N': _options.neuralShader = !_options.neuralShader;
      if (_options.neuralShader) _options.realtimePathTrace = _options.studioLook = _options.hybridRt = _options.screenSpaceGi = _options.pathTraced = false; break;
    case 'v': case 'V': _options.worldGiOcclusion = !_options.worldGiOcclusion; break;
    case 'i': case 'I': _readout.hidden = !_readout.hidden; [self showReadout]; return;
    case 'w': case 'W': [self switchFlight]; return;
    default: [super keyDown:event]; return;
  }
  [self changed];
}

@end
