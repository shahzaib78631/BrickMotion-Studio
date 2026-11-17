#import "ViewportView.h"

#import <QuartzCore/QuartzCore.h>
#include <algorithm>
#include <cmath>
#include <vector>
#include "bm/plan/timeline.h"
#include "bmr/camera.h"
#include "bmr/device.h"

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
  int _width, _height;  // pixels

  // Playback. _frame is -1 until there is a plan (the model is shown finished).
  int _frame;
  bool _playing, _userMoved;
  double _playStartTime;
  int _playStartFrame;

  // The mouse.
  NSPoint _pressedAt, _lastAt;
  bool _dragged;

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
  self.wantsLayer = YES;
  self.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;

  _readout = [NSTextField labelWithString:@""];
  _readout.font = [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular];
  _readout.textColor = NSColor.secondaryLabelColor;
  _readout.translatesAutoresizingMaskIntoConstraints = NO;
  [self addSubview:_readout];
  [NSLayoutConstraint activateConstraints:@[
    [_readout.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:12],
    [_readout.topAnchor constraintEqualToAnchor:self.topAnchor constant:10],
  ]];
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
  _session->renderer->resize(w, h);
  [self changed];
}

- (double)aspect { return _height > 0 ? double(_width) / _height : 1.0; }

// ---- drawing ----

/// Something the picture shows has changed: draw on the next refresh.
- (void)changed {
  _dirty = true;
  _link.paused = NO;
}

- (void)metalDisplayLink:(CAMetalDisplayLink*)link needsUpdate:(CAMetalDisplayLinkUpdate*)update {
  if (_playing) [self advance];
  if (!_dirty) {
    link.paused = YES;  // nothing changed: an idle window draws nothing
    return;
  }
  bmr::Renderer& r = *_session->renderer;
  const bmr::FrameStats s = r.draw(_orbit.camera(self.aspect, r.scene().bounds), _options, (__bridge void*)update.drawable);
  // A frame not sent (the drawable had not caught up with a resize) is drawn on the next refresh.
  _dirty = _playing || (!s.submitted && _width > 0 && _height > 0);
  if (s.submitted) {
    _lastStats = s;
    _cpuSum += s.cpuMs, _gpuSum += r.lastGpuMs(), _framesSummed++;
  }
}

/// Playback goes by the clock: frames that could not be drawn in time are skipped.
- (void)advance {
  const bmtools::Planned& p = *_session->planned;
  const double fps = bm::plan::Style{}.fps;
  const int f = std::min(p.timeline.frames, _playStartFrame + static_cast<int>((CACurrentMediaTime() - _playStartTime) * fps));
  [self showFrame:f];
  if (f >= p.timeline.frames) _playing = false;
}

- (void)showFrame:(int)f {
  if (!_session->planned) return;
  const bmtools::Planned& p = *_session->planned;
  f = std::clamp(f, 0, p.timeline.frames);
  if (f == _frame) return;
  _frame = f;
  _session->renderer->setFrame(p.plan, p.timeline, f);
  if (_playing && !_userMoved && !p.timeline.camera.empty()) _orbit = bmr::OrbitCamera::along(p.timeline, f);
  [self changed];
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
  const bmr::Scene& scene = _session->renderer->scene();
  const size_t total = scene.where.size();
  NSString* frame = _session->planned ? [NSString stringWithFormat:@"frame %d / %d", _frame, _session->planned->timeline.frames] : @"planning…";
  const double cpu = _framesSummed ? _cpuSum / _framesSummed : _lastStats.cpuMs;
  const double gpu = _framesSummed ? _gpuSum / _framesSummed : _session->renderer->lastGpuMs();
  _readout.stringValue = [NSString stringWithFormat:@"%@ · cpu %.1f ms · gpu %.1f ms · %u/%zu pieces · F %u L %u B %u", frame, cpu, gpu, _lastStats.instances, total,
                                                    _lastStats.byDetail[0], _lastStats.byDetail[1], _lastStats.byDetail[2]];
  _cpuSum = _gpuSum = 0, _framesSummed = 0;
}

// ---- the camera ----

- (void)frameBounds:(const bm::Box&)box {
  if (box.empty()) return;
  _orbit = bmr::OrbitCamera::fitted(box, _orbit.fovY, self.aspect, _orbit.azimuth, _orbit.elevation);
  [self moved];
}

- (void)frameModel { [self frameBounds:_session->renderer->scene().bounds]; }

- (void)frameSelectionOrModel {
  const bmr::Scene& scene = _session->renderer->scene();
  bm::Box box;
  for (const auto& [g, k] : scene.where)
    if (g < scene.groups.size() && (scene.groups[g].instances[k].flags & bmr::kSelected)) box.merge(scene.groups[g].restBoxes[k]);
  if (box.empty()) [self frameModel];
  else [self frameBounds:box];
}

/// The user moved the camera.
- (void)moved {
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
  _orbit.drag(at.x - _lastAt.x, -(at.y - _lastAt.y));  // view points have y up; drag() takes it down
  _lastAt = at;
  [self moved];
}

- (void)mouseUp:(NSEvent*)event {
  if (_dragged) return;
  if (event.clickCount == 2) {
    [self frameSelectionOrModel];
    return;
  }
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
  _orbit.pan((at.x - _lastAt.x) * s, -(at.y - _lastAt.y) * s, _height);
  _lastAt = at;
  [self moved];
}

- (void)scrollWheel:(NSEvent*)event {
  if (event.hasPreciseScrollingDeltas) {  // two fingers on a trackpad: pan
    const double s = self.pixelsPerPoint;
    _orbit.pan(event.scrollingDeltaX * s, event.scrollingDeltaY * s, _height);
    [self moved];
  } else if (event.scrollingDeltaY != 0) {  // a wheel: zoom
    [self zoom:std::exp(-kWheelZoom * event.scrollingDeltaY) toward:[self convertPoint:event.locationInWindow fromView:nil]];
  }
}

- (void)magnifyWithEvent:(NSEvent*)event {
  [self zoom:1.0 / std::max(0.1, 1.0 + event.magnification) toward:[self convertPoint:event.locationInWindow fromView:nil]];
}

// ---- keys ----

- (void)keyDown:(NSEvent*)event {
  NSString* keys = event.charactersIgnoringModifiers;
  if (keys.length == 0) return;
  const unichar k = [keys characterAtIndex:0];
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
    case 'i': case 'I': _readout.hidden = !_readout.hidden; [self showReadout]; return;
    default: [super keyDown:event]; return;
  }
  [self changed];
}

@end
