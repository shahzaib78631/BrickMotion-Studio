#import "AppDelegate.h"

#include <cmath>
#include <algorithm>
#include <exception>
#include <memory>
#include <string>
#include "bm/io.h"
#include "bmr/device.h"
#import "ViewportView.h"

namespace {
/// Shows `message` in an alert and ends the app with status 1.
[[noreturn]] void fail(NSString* title, const std::string& message) {
  NSAlert* alert = [NSAlert new];
  alert.alertStyle = NSAlertStyleCritical;
  alert.messageText = title;
  alert.informativeText = [NSString stringWithUTF8String:message.c_str()] ?: @"";
  [alert runModal];
  std::exit(1);
}

std::string describe(const bm::LoadReport& r) {
  std::string out;
  auto list = [&](const char* what, const std::vector<std::string>& items) {
    if (items.empty()) return;
    out += std::string(what) + ": ";
    for (size_t i = 0; i < items.size() && i < 12; i++) out += (i ? ", " : "") + items[i];
    if (items.size() > 12) out += ", and " + std::to_string(items.size() - 12) + " more";
    out += "\n";
  };
  list("Missing", r.missing);
  list("Loops", r.cycles);
  list("Unknown colours", r.unknownColors);
  if (r.skippedLines) out += std::to_string(r.skippedLines) + " malformed lines\n";
  return out;
}
}  // namespace

@implementation AppDelegate {
  NSString* _path;
  BOOL _play, _raytracedGlass, _rtpt, _noPlan, _correct, _cleanGrown;
  bm::plan::Order _order;
  bm::plan::FlightShape _flight;
  bm::plan::Planner _planner;
  BmViewWorldLaunch _worldLaunch;
  std::unique_ptr<bmview::Session> _session;
  NSWindow* _window;
  ViewportView* _view;
  dispatch_group_t _planning;
}

- (instancetype)initWithFile:(NSString*)path play:(BOOL)play raytracedGlass:(BOOL)raytracedGlass rtpt:(BOOL)rtpt noPlan:(BOOL)noPlan correct:(BOOL)correct cleanGrown:(BOOL)cleanGrown order:(bm::plan::Order)order flight:(bm::plan::FlightShape)flight planner:(bm::plan::Planner)planner worldLaunch:(BmViewWorldLaunch)worldLaunch {
  self = [super init];
  if (self) _path = path, _play = play, _raytracedGlass = raytracedGlass, _rtpt = rtpt, _noPlan = noPlan, _correct = correct, _cleanGrown = cleanGrown, _order = order, _flight = flight, _planner = planner, _worldLaunch = std::move(worldLaunch), _planning = dispatch_group_create();
  return self;
}

- (void)applicationDidFinishLaunching:(NSNotification*)note {
  [self makeMenu];
  if (!bmr::gpuAvailable()) fail(@"This Mac cannot draw the model.", bmr::shaderError());
  auto s = std::make_unique<bmview::Session>();
  s->file = std::filesystem::path(_path.UTF8String);
  s->raytracedGlass = _raytracedGlass;
  s->realtimePathTrace = _rtpt;
  s->noPlan = _noPlan;
  s->flight = _flight;
  s->planner = _planner;

  if (bmr::isWorldAssetFile(s->file)) {
    std::string err;
    bmr::WorldAsset asset = bmr::loadWorldAsset(s->file, &err);
    if (asset.meshes.empty()) {
      fail([NSString stringWithFormat:@"“%@” could not be opened.", _path.lastPathComponent], err);
    }
    s->world = bmr::WorldRenderer::create(asset, &err);
    if (!s->world) fail(@"This Mac cannot draw the 3D scene.", err);
    if (!_worldLaunch.hdrPath.empty()) {
      if (!s->world->loadEnvironmentHdr(_worldLaunch.hdrPath)) {
        std::fprintf(stderr, "bmview: warning: could not load HDR skybox %s\n", _worldLaunch.hdrPath.c_str());
      }
    }
    s->isWorld = true;
    s->noPlan = true;
    s->worldOptions.clay = _worldLaunch.clay;
    s->worldOptions.studioRig = _worldLaunch.studioRig;
    s->worldOptions.floor = _worldLaunch.floorExplicit ? _worldLaunch.floor : _worldLaunch.studioRig;
    if (_worldLaunch.hasEye) {
      s->worldHasDefaultView = true;
      s->worldDefaultEye = {_worldLaunch.eye[0], _worldLaunch.eye[1], _worldLaunch.eye[2]};
      s->worldDefaultTarget = {_worldLaunch.target[0], _worldLaunch.target[1], _worldLaunch.target[2]};
      s->worldDefaultFovDeg = _worldLaunch.fovDeg > 5.0 ? _worldLaunch.fovDeg : 50.0;
    } else if (asset.hasDefaultView) {
      s->worldHasDefaultView = true;
      s->worldDefaultEye = asset.defaultEye;
      s->worldDefaultTarget = asset.defaultTarget;
      s->worldDefaultFovDeg = _worldLaunch.fovDeg > 5.0 ? _worldLaunch.fovDeg : asset.defaultFovDeg;
    } else if (_worldLaunch.fovDeg > 5.0) {
      s->worldDefaultFovDeg = _worldLaunch.fovDeg;
    }
    _session = std::move(s);
    _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1280, 800)
                                          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
    _window.delegate = self;
    _window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    _window.contentMinSize = NSMakeSize(320, 200);
    _view = [[ViewportView alloc] initWithFrame:NSMakeRect(0, 0, 1280, 800) session:_session.get()];
    _window.contentView = _view;
    _window.title = [_path.lastPathComponent stringByAppendingString:@" — BrickMotion New-Era RTPT"];
    [_window center];
    [_window makeKeyAndOrderFront:nil];
    [NSApp activate];
    return;
  }

  s->ldraw = bmtools::ldrawDir();
  if (s->ldraw.empty()) fail(@"No LDraw library was found.", "Set BM_LDRAW_DIR to the folder that holds LDConfig.ldr.");
  try {
    s->library = std::make_unique<bm::ldraw::Library>(s->ldraw);
    s->full = std::make_unique<bm::ldraw::PartCache>(*s->library, bm::ldraw::PartCache::defaultDirectory());
    bm::ldraw::FlattenOptions lowOptions;
    lowOptions.lowResPrimitives = true;
    s->low = std::make_unique<bm::ldraw::PartCache>(*s->library, bm::ldraw::PartCache::defaultDirectory().parent_path() / "parts-low", lowOptions);
    s->model = std::make_unique<bm::Model>(bm::io::load(s->file, *s->library, s->full.get()));
  } catch (const std::exception& e) {
    fail([NSString stringWithFormat:@"“%@” could not be opened.", _path.lastPathComponent], e.what());
  }
  if (s->model->pieces().empty()) fail([NSString stringWithFormat:@"“%@” has no pieces.", _path.lastPathComponent], describe(s->model->report()));
  s->renderer = bmr::Renderer::create(*s->model, *s->full, *s->low);
  if (!s->renderer) fail(@"This Mac cannot draw the model.", bmr::shaderError());
  _session = std::move(s);

  _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1280, 800)
                                        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                          backing:NSBackingStoreBuffered
                                            defer:NO];
  _window.delegate = self;
  _window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
  _window.contentMinSize = NSMakeSize(320, 200);
  _view = [[ViewportView alloc] initWithFrame:NSMakeRect(0, 0, 1280, 800) session:_session.get()];
  _window.contentView = _view;
  [self setTitle:!_noPlan];
  [_window center];
  [_window makeKeyAndOrderFront:nil];
  [NSApp activate];
  if (_noPlan) return;

  // The plan is made while the model is already on screen.
  bmview::Session* session = _session.get();
  __weak AppDelegate* weakSelf = self;
  const BOOL play = _play, correct = _correct, cleanGrown = _cleanGrown;
  const bm::plan::Order order = _order;
  dispatch_group_async(_planning, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    std::optional<bmtools::Planned> planned;
    // --correct: planned on a copy, which takes the place of the model shown once planned when
    // any piece was set in place, so what is drawn is what was planned (bm plan --correct).
    std::shared_ptr<bm::Model> corrected;
    std::string error;
    try {
      bm::plan::Options options;
      options.cancel = &session->cancel;
      options.correctPlacements = correct;
      options.cleanGrownUnits = cleanGrown;
      options.order = order;
      if (correct) corrected = std::make_shared<bm::Model>(*session->model);
      planned = bmtools::planModel(correct ? *corrected : *session->model, *session->library, *session->full, session->ldraw, options, [&] { bm::plan::Style style = bm::plan::styleOf(session->file); style.shape = session->flight, style.planner = session->planner; return style; }());
      if (correct) bmtools::reportCorrections("bmview", *corrected, planned->corrections);
      bmtools::keysFromTrack(planned->track, planned->timeline);  // the build plays the director's camera
    } catch (const std::exception& e) {
      error = e.what();
    }
    if (session->cancel.cancelled()) return;
    dispatch_async(dispatch_get_main_queue(), ^{
      AppDelegate* me = weakSelf;
      if (!me || session->cancel.cancelled()) return;
      if (!planned) {
        me->_window.subtitle = [NSString stringWithFormat:@"could not plan: %s", error.c_str()];
        me->_window.title = me->_path.lastPathComponent;
        return;
      }
      const bool moved = corrected && std::any_of(planned->corrections.begin(), planned->corrections.end(), [](const bm::connect::Correction& c) { return c.applied; });
      if (moved) {
        auto model = std::make_unique<bm::Model>(std::move(*corrected));
        auto renderer = bmr::Renderer::create(*model, *session->full, *session->low);
        if (renderer) {
          const double scale = me->_window.backingScaleFactor;
          renderer->resize(static_cast<int>(std::lround(me->_view.bounds.size.width * scale)), static_cast<int>(std::lround(me->_view.bounds.size.height * scale)));
          session->renderer = std::move(renderer);  // the old renderer goes while the model it drew still exists
          session->model = std::move(model);
        } else {
          me->_window.subtitle = @"could not draw the corrected model";  // its plan is not shown on the model as drawn
          return;
        }
      }
      session->planned = std::move(planned);
      [me setTitle:NO];
      [me->_view planReady:play];
    });
  });
}

- (void)setTitle:(BOOL)planning {
  NSString* name = _path.lastPathComponent;
  _window.title = planning ? [name stringByAppendingString:@" — planning…"] : name;
}

- (void)makeMenu {
  NSMenu* bar = [NSMenu new];
  NSMenuItem* appItem = [NSMenuItem new];
  [bar addItem:appItem];
  NSMenu* app = [NSMenu new];
  [app addItemWithTitle:@"Quit bmview" action:@selector(terminate:) keyEquivalent:@"q"];
  appItem.submenu = app;
  NSMenuItem* viewItem = [NSMenuItem new];
  [bar addItem:viewItem];
  NSMenu* view = [[NSMenu alloc] initWithTitle:@"View"];
  NSMenuItem* full = [view addItemWithTitle:@"Enter Full Screen" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];
  full.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
  viewItem.submenu = view;
  NSApp.mainMenu = bar;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)app { return YES; }

- (void)windowWillClose:(NSNotification*)note { [self shutDown]; }
- (void)applicationWillTerminate:(NSNotification*)note { [self shutDown]; }

/// Stops drawing and planning before the session goes.
- (void)shutDown {
  if (!_session) return;
  [_view stop];
  _session->cancel.cancel();
  dispatch_group_wait(_planning, DISPATCH_TIME_FOREVER);
}

@end
