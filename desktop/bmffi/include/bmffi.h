#pragma once
// bmffi: the flat C interface the Rust desktop app uses to reach the engine (bmapp).
// Every BmString returned is owned by the caller and freed with bm_string_free.
// crates/bm-sys/src/lib.rs mirrors this file by hand; a test checks every BMFFI_API name.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BMFFI_API __attribute__((visibility("default")))

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BmSession BmSession;
typedef struct BmViewport BmViewport;
typedef struct { char* ptr; size_t len; } BmString;
typedef struct { bool ok; BmString error; BmString warnings; } BmOpenResult;
typedef enum { BM_VIEW_FRONT, BM_VIEW_BACK, BM_VIEW_RIGHT, BM_VIEW_LEFT, BM_VIEW_TOP, BM_VIEW_BOTTOM } BmViewPreset;
typedef enum { BM_SELECT_REPLACE, BM_SELECT_ADD, BM_SELECT_TOGGLE } BmSelectMode;
#define BM_NO_PIECE UINT32_MAX

BMFFI_API void bm_string_free(BmString s);
/// "" when no LDraw library was found.
BMFFI_API BmString bm_ldraw_directory(void);
BMFFI_API BmString bm_engine_version(void);

BMFFI_API BmSession* bm_session_new(void);
BMFFI_API void bm_session_free(BmSession* s);
/// Safe on any thread for a session no other thread uses.
BMFFI_API BmOpenResult bm_session_open(BmSession* s, const char* utf8_path);
BMFFI_API void bm_open_result_free(BmOpenResult r);
BMFFI_API BmString bm_session_title(const BmSession* s);
BMFFI_API size_t bm_session_piece_count(const BmSession* s);
BMFFI_API uint64_t bm_session_generation(const BmSession* s);
BMFFI_API void bm_session_select(BmSession* s, const uint32_t* pieces, size_t n, BmSelectMode mode);
/// Returns the total; writes min(total, cap) pieces into `out`.
BMFFI_API size_t bm_session_selection(const BmSession* s, uint32_t* out, size_t cap);

/// NULL when this Mac has no Metal device.
BMFFI_API BmViewport* bm_viewport_new(BmSession* s);
/// True when this Mac has a Metal device to draw with.
BMFFI_API bool bm_metal_available(void);
BMFFI_API void bm_viewport_free(BmViewport* v);
BMFFI_API bool bm_viewport_ok(const BmViewport* v);
/// Ignored when either side is zero or negative.
BMFFI_API void bm_viewport_resize(BmViewport* v, int px_w, int px_h, double scale);
/// Draws into the viewport's own picture. True when another frame is wanted soon.
BMFFI_API bool bm_viewport_draw(BmViewport* v);
BMFFI_API bool bm_viewport_needs_draw(const BmViewport* v);
/// Copies the last frame (top row first, sRGB RGBA). False when `cap` is too small; w and h
/// are always set.
BMFFI_API bool bm_viewport_readback(BmViewport* v, uint8_t* rgba, size_t cap, int* w, int* h);
BMFFI_API void bm_viewport_orbit(BmViewport* v, double dx_pt, double dy_pt);
BMFFI_API void bm_viewport_pan(BmViewport* v, double dx_pt, double dy_pt);
BMFFI_API void bm_viewport_zoom_toward(BmViewport* v, double factor, double x_pt, double y_pt);
BMFFI_API void bm_viewport_fit_all(BmViewport* v);
BMFFI_API void bm_viewport_view(BmViewport* v, BmViewPreset preset);
BMFFI_API void bm_viewport_set_background(BmViewport* v, double r, double g, double b);
BMFFI_API void bm_viewport_set_orthographic(BmViewport* v, bool on);
/// BM_NO_PIECE on empty space.
BMFFI_API uint32_t bm_viewport_pick(BmViewport* v, double x_pt, double y_pt);
/// The shown pieces inside the rectangle (points from the top left, either corner first);
/// `touching` also takes pieces it only overlaps. Writes up to `cap`, returns the total.
BMFFI_API size_t bm_viewport_marquee(BmViewport* v, double x0, double y0, double x1, double y1, bool touching,
                                     uint32_t* out, size_t cap);
BMFFI_API void bm_viewport_frame_selection(BmViewport* v);

// ---- Documents ----
/// What an edit, undo or redo changed. `refused` is empty unless nothing changed, and then says why.
typedef struct { bool structure; uint64_t version; BmString refused; } BmChange;
BMFFI_API void bm_change_free(BmChange c);

/// An untitled project with one empty step. Starts afresh like an open.
BMFFI_API BmOpenResult bm_session_new_blank(BmSession* s);
/// The document as .brickmotion project bytes.
BMFFI_API BmString bm_session_project_bytes(const BmSession* s);
/// True unless the file was a .brickmotion project.
BMFFI_API bool bm_session_imported(const BmSession* s);
BMFFI_API bool bm_session_dirty(const BmSession* s);
BMFFI_API void bm_session_mark_saved(BmSession* s);
/// Goes up with every change, undo and redo included.
BMFFI_API uint64_t bm_session_version(const BmSession* s);
/// Goes up with edits that add, remove or regroup items.
BMFFI_API uint64_t bm_session_structure_version(const BmSession* s);

BMFFI_API bool bm_session_can_undo(const BmSession* s);
BMFFI_API bool bm_session_can_redo(const BmSession* s);
BMFFI_API BmString bm_session_undo_name(const BmSession* s);
BMFFI_API BmString bm_session_redo_name(const BmSession* s);
BMFFI_API BmChange bm_session_undo(BmSession* s);
BMFFI_API BmChange bm_session_redo(BmSession* s);
/// One undo step.
BMFFI_API BmChange bm_session_remove(BmSession* s, const uint32_t* pieces, size_t n);

BMFFI_API void bm_session_select_all(BmSession* s);
BMFFI_API void bm_session_select_none(BmSession* s);
BMFFI_API void bm_session_hide(BmSession* s, const uint32_t* pieces, size_t n);
BMFFI_API void bm_session_show_all(BmSession* s);
/// Returns the total; writes min(total, cap) pieces into `out`.
BMFFI_API size_t bm_session_pieces_of_row(const BmSession* s, const char* outline_id, uint32_t* out,
                                          size_t cap);

// ---- Lists ----
// A list handle owns its strings; the `const char*` in a row stay valid until the handle is freed.
typedef struct BmOutline BmOutline;
typedef struct BmSnapshot BmSnapshot;
typedef struct BmColors BmColors;
typedef struct {
  const char *id, *def, *name, *group;
  int32_t depth, parent;
  size_t pieces, uses;
  bool shared, unused;
} BmOutlineRow;
typedef struct { uint64_t version; size_t pieces, selected, hidden; bool dirty; } BmSnapshotInfo;
typedef struct {
  uint32_t piece;
  const char *part, *description, *color_name, *submodel_path;
  int32_t color, step;
  bool in_shared_submodel;
} BmPieceInfo;
typedef struct { int32_t code; const char* name; uint32_t rgb; float alpha; int32_t group; } BmColor;

BMFFI_API BmOutline* bm_session_outline(const BmSession* s);
BMFFI_API size_t bm_outline_len(const BmOutline* o);
/// A zeroed row (empty strings) when `i` is out of range.
BMFFI_API BmOutlineRow bm_outline_row(const BmOutline* o, size_t i);
BMFFI_API void bm_outline_free(BmOutline* o);

BMFFI_API BmSnapshot* bm_session_snapshot(const BmSession* s);
/// `selected` is the whole selection; the described pieces are its first 200.
BMFFI_API BmSnapshotInfo bm_snapshot_info(const BmSnapshot* s);
BMFFI_API size_t bm_snapshot_piece_len(const BmSnapshot* s);
BMFFI_API BmPieceInfo bm_snapshot_piece(const BmSnapshot* s, size_t i);
BMFFI_API void bm_snapshot_free(BmSnapshot* s);

BMFFI_API BmColors* bm_colors(const BmSession* s);
BMFFI_API size_t bm_colors_len(const BmColors* c);
BMFFI_API BmColor bm_colors_at(const BmColors* c, size_t i);
BMFFI_API void bm_colors_free(BmColors* c);

/// sizeof the named struct, so the Rust mirrors can check their layout; 0 for an unknown name.
BMFFI_API size_t bm_struct_size(const char* name);

// ---- Edits & camera ----
typedef struct { double x, y; } BmVec2;
typedef struct { double x, y, z; } BmVec3;
/// Row-major 3x3, as bmapp::Mat3.
typedef struct { double m[9]; } BmMat3;
typedef struct {
  double yaw, pitch, distance;
  BmVec3 target;
  bool orthographic;
  double vertical_fov;
} BmCamera;
typedef enum { BM_ARROW_LEFT, BM_ARROW_RIGHT, BM_ARROW_UP, BM_ARROW_DOWN } BmArrow;

BMFFI_API BmChange bm_session_move(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 delta, bool continuing);
BMFFI_API BmChange bm_session_rotate(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 axis, double degrees,
                                     BmVec3 pivot, bool continuing);
BMFFI_API BmChange bm_session_recolor(BmSession* s, const uint32_t* pieces, size_t n, int32_t code);
BMFFI_API BmChange bm_session_duplicate(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 offset);
BMFFI_API BmChange bm_session_replace_part(BmSession* s, const uint32_t* pieces, size_t n, const char* part);
BMFFI_API void bm_session_end_gesture(BmSession* s);
BMFFI_API BmMat3 bm_session_axes_of(const BmSession* s, uint32_t piece);
BMFFI_API BmString bm_session_copy(const BmSession* s, const uint32_t* pieces, size_t n);
BMFFI_API BmChange bm_session_paste(BmSession* s, const char* ldraw_text, BmVec3 offset);
BMFFI_API BmCamera bm_viewport_camera(const BmViewport* v);
BMFFI_API BmVec3 bm_viewport_selection_center(BmViewport* v);
BMFFI_API BmVec3 bm_arrow_axis(BmCamera camera, BmArrow arrow);

// ---- Gizmo ----
typedef enum { BM_GIZMO_MOVE = 1, BM_GIZMO_ROTATE = 2 } BmGizmoKind;
typedef enum {
  BM_HANDLE_NONE,
  BM_HANDLE_X,
  BM_HANDLE_Y,
  BM_HANDLE_Z,
  BM_HANDLE_XY,
  BM_HANDLE_YZ,
  BM_HANDLE_XZ,
  BM_HANDLE_VIEW
} BmHandle;
typedef struct BmGizmo BmGizmo;

BMFFI_API BmGizmo* bm_gizmo_shape(BmCamera camera, BmVec2 view_points, BmVec3 origin, BmMat3 axes, BmGizmoKind kind);
BMFFI_API void bm_gizmo_free(BmGizmo* g);
BMFFI_API size_t bm_gizmo_line_len(const BmGizmo* g);
BMFFI_API void bm_gizmo_line(const BmGizmo* g, size_t i, BmVec2* a, BmVec2* b, BmHandle* h);
BMFFI_API size_t bm_gizmo_ring_len(const BmGizmo* g);
BMFFI_API BmHandle bm_gizmo_ring_handle(const BmGizmo* g, size_t i);
BMFFI_API size_t bm_gizmo_ring(const BmGizmo* g, size_t i, BmVec2* out, size_t cap);
BMFFI_API BmHandle bm_gizmo_hit(const BmGizmo* g, BmVec2 point, double tolerance);
BMFFI_API BmVec3 bm_handle_axis(BmCamera camera, BmMat3 axes, BmHandle handle);
BMFFI_API BmVec3 bm_drag_move(BmCamera camera, BmVec2 view, BmVec3 origin, BmMat3 axes, BmHandle handle, BmVec2 a,
                              BmVec2 b, BmVec3 snap);
BMFFI_API double bm_drag_rotate(BmCamera camera, BmVec2 view, BmVec3 origin, BmMat3 axes, BmHandle handle, BmVec2 a,
                                BmVec2 b, bool free);
BMFFI_API bool bm_project_point(BmCamera camera, BmVec2 view, BmVec3 p, BmVec2* out);

// ---- Library & part previews ----
typedef struct BmParts BmParts;
typedef struct { const char *name, *description, *category; } BmPartMatch;
typedef struct BmStrings BmStrings;
typedef struct BmPartPreview BmPartPreview;
typedef struct BmPicture BmPicture;

BMFFI_API BmParts* bm_library_parts(const char* query, const char* category, size_t limit);
BMFFI_API BmParts* bm_common_parts(void);
BMFFI_API size_t bm_parts_len(const BmParts* p);
BMFFI_API BmPartMatch bm_parts_at(const BmParts* p, size_t i);
BMFFI_API void bm_parts_free(BmParts* p);

BMFFI_API BmStrings* bm_part_categories(void);
BMFFI_API size_t bm_strings_len(const BmStrings* s);
BMFFI_API const char* bm_strings_at(const BmStrings* s, size_t i);
BMFFI_API void bm_strings_free(BmStrings* s);

BMFFI_API BmPartPreview* bm_part_preview_new(void);
BMFFI_API void bm_part_preview_free(BmPartPreview* p);
BMFFI_API BmPicture* bm_part_preview_render(BmPartPreview* p, const char* part, int32_t color, bool dark);
BMFFI_API void bm_picture_info(const BmPicture* p, int* w, int* h);
BMFFI_API const uint8_t* bm_picture_rgba(const BmPicture* p);
BMFFI_API void bm_picture_free(BmPicture* p);

// ---- Placement ----
typedef enum {
  BM_PLACE_INACTIVE,
  BM_PLACE_PREPARING,
  BM_PLACE_FREE,
  BM_PLACE_SNAPPED,
  BM_PLACE_REFERENCE,
  BM_PLACE_BLOCKED,
  BM_PLACE_UNAVAILABLE
} BmPlacementState;

typedef struct {
  const char* part;
  int32_t color, grip, turns;
  bool mirrored, snap, reference, collision;
  uint32_t anchor;
  BmVec2 grab;
  const uint32_t* selection;
  size_t selection_len;
} BmPlacementInput;

typedef struct {
  BmPlacementState state;
  BmMat3 rotation;
  BmVec3 position, contact;
  uint32_t grip, grip_count;
  uint64_t generation, version, request;
  BmString reason;
} BmPlacementPreview;

BMFFI_API void bm_placement_preview_free(BmPlacementPreview p);
BMFFI_API uint64_t bm_viewport_preview_part(BmViewport* v, const BmPlacementInput* input, BmVec2 point);
BMFFI_API BmPlacementPreview bm_viewport_placement_preview(const BmViewport* v);
BMFFI_API void bm_viewport_clear_placement_preview(BmViewport* v);
BMFFI_API void bm_viewport_show_rest(BmViewport* v);
BMFFI_API BmChange bm_session_place_part(BmSession* s, const char* part, int32_t color, BmMat3 rotation,
                                         BmVec3 position, int32_t step, int32_t before, uint64_t generation,
                                         uint64_t version);

// ---- Steps ----
typedef struct BmSteps BmSteps;
typedef struct {
  size_t index;
  const char *title, *notes;
  double pause_after;
  bool pin_order, automatic;
  size_t items, pieces, submodels;
} BmStepRow;

typedef struct BmItems BmItems;
typedef struct {
  uint64_t item;
  const char *name, *description, *color_name, *group;
  int32_t color;
  bool submodel;
  size_t step, index, pieces;
} BmItemRow;

BMFFI_API BmSteps* bm_session_steps(const BmSession* s);
BMFFI_API size_t bm_steps_len(const BmSteps* st);
BMFFI_API BmStepRow bm_steps_at(const BmSteps* st, size_t i);
BMFFI_API void bm_steps_free(BmSteps* st);

BMFFI_API BmItems* bm_session_step_items(const BmSession* s, size_t step);
BMFFI_API size_t bm_items_len(const BmItems* it);
BMFFI_API BmItemRow bm_items_at(const BmItems* it, size_t i);
BMFFI_API size_t bm_item_pieces(const BmItems* it, size_t i, uint32_t* out, size_t cap);
BMFFI_API void bm_items_free(BmItems* it);

BMFFI_API size_t bm_session_pieces_of_step(const BmSession* s, size_t step, uint32_t* out, size_t cap);

BMFFI_API BmChange bm_session_insert_step(BmSession* s, size_t at);
BMFFI_API BmChange bm_session_delete_step(BmSession* s, size_t at);
BMFFI_API BmChange bm_session_move_step(BmSession* s, size_t from, size_t to);
BMFFI_API BmChange bm_session_split_step(BmSession* s, size_t at, const uint32_t* pieces, size_t n);
BMFFI_API BmChange bm_session_merge_steps(BmSession* s, size_t first);
BMFFI_API BmChange bm_session_set_step_fields(BmSession* s, size_t at, const char* title, const char* notes,
                                              double pause_after, bool pin_order, bool continuing);
BMFFI_API BmChange bm_session_move_to_step(BmSession* s, const uint32_t* pieces, size_t n, size_t step);
BMFFI_API BmChange bm_session_reorder_in_step(BmSession* s, size_t step, size_t from, size_t to);

// ---- Playback, plan and timeline ----
typedef enum { BM_PLAN_IDLE, BM_PLAN_PLANNING, BM_PLAN_READY, BM_PLAN_FAILED } BmPlanState;
typedef enum {
  BM_STAGE_WAITING,
  BM_STAGE_SOLVING,
  BM_STAGE_CHECKING_FLIGHTS,
  BM_STAGE_PREPARING,
  BM_STAGE_STANDARD_PREVIEW
} BmPlanStage;
typedef enum { BM_PREVIEW_ASSEMBLED, BM_PREVIEW_SEPARATED, BM_PREVIEW_LAID_OUT, BM_PREVIEW_EXPLODED } BmAssemblyPreview;
typedef enum { BM_SEGMENT_INTRO, BM_SEGMENT_BUILD, BM_SEGMENT_HERO } BmSegment;

typedef struct {
  double seconds, duration;
  bool playing, waiting_to_play, at_rest, stale;
  BmPlanState plan;
  uint64_t version;
  BmPlanStage stage;
} BmPlaybackState;

typedef struct {
  bool edges, floor, shadows, ambient_occlusion, auto_plan, scene_backdrop;
} BmViewportPreferences;

BMFFI_API void bm_viewport_play(BmViewport* v, bool on);
BMFFI_API void bm_viewport_play_range(BmViewport* v, double start, double end);
BMFFI_API void bm_viewport_seek(BmViewport* v, double seconds);
BMFFI_API void bm_viewport_set_playback_rate(BmViewport* v, double rate);
BMFFI_API void bm_viewport_set_playback_loop(BmViewport* v, bool loop);
BMFFI_API void bm_viewport_request_plan(BmViewport* v);
BMFFI_API void bm_viewport_regenerate_plan(BmViewport* v, bool standard_preview);
BMFFI_API BmPlaybackState bm_viewport_playback_state(const BmViewport* v);
BMFFI_API BmString bm_viewport_plan_error(const BmViewport* v);
BMFFI_API uint64_t bm_viewport_planned_version(const BmViewport* v);
BMFFI_API void bm_viewport_set_preferences(BmViewport* v, BmViewportPreferences p);
/// `step` < 0: the whole model at rest (full inventory).
BMFFI_API void bm_viewport_arrange(BmViewport* v, int32_t step, BmAssemblyPreview mode);
/// Two-call: returns the total, writes min(total, cap).
BMFFI_API size_t bm_viewport_build_order(BmViewport* v, uint32_t* out, size_t cap);

/// An owned snapshot of the planned build; its strings live until bm_timeline_free.
typedef struct BmTimeline BmTimeline;
typedef struct {
  uint64_t version;
  double duration, fps, build_start, build_end, planning_ms;
  bool standard_preview;
} BmTimelineInfo;
typedef struct {
  uint32_t piece;
  int32_t step, depth, color;
  double start, end;
  const char *name, *flag, *blocker;
  bool independent;
} BmFlightRow;

BMFFI_API BmTimeline* bm_viewport_build_timeline(const BmViewport* v);
BMFFI_API BmTimelineInfo bm_timeline_info(const BmTimeline* t);
BMFFI_API size_t bm_timeline_flights_len(const BmTimeline* t);
BMFFI_API BmFlightRow bm_timeline_flight_at(const BmTimeline* t, size_t i);
BMFFI_API size_t bm_timeline_notes_len(const BmTimeline* t);
BMFFI_API const char* bm_timeline_note_at(const BmTimeline* t, size_t i);
BMFFI_API void bm_timeline_free(BmTimeline* t);

/// The Build timeline's lanes over a timeline (bmapp/build_lanes.h).
typedef struct BmLanes BmLanes;
typedef struct {
  size_t id;
  int32_t step;
  double start, end, next;
} BmLaneRun;
typedef struct {
  int32_t step;
  double start, end, pause_end;
  size_t flights;
} BmLaneStep;
typedef struct {
  bool scheduled;
  int32_t flight;
  uint64_t item;
  int32_t depth;
  double start, end, attach;
  bool has_attach;
  const char* name;  ///< the last element of its path
  size_t pieces;
} BmLaneSubmodel;

/// `s` may be NULL (submodel uses are then not resolved).
BMFFI_API BmLanes* bm_lanes_new(const BmTimeline* t, const BmSession* s);
BMFFI_API size_t bm_lanes_runs_len(const BmLanes* l);
BMFFI_API BmLaneRun bm_lanes_run_at(const BmLanes* l, size_t i);
BMFFI_API size_t bm_lanes_steps_len(const BmLanes* l);
BMFFI_API BmLaneStep bm_lanes_step_at(const BmLanes* l, size_t i);
BMFFI_API size_t bm_lanes_step_flights(const BmLanes* l, size_t i, size_t* out, size_t cap);
BMFFI_API size_t bm_lanes_submodels_len(const BmLanes* l);
BMFFI_API BmLaneSubmodel bm_lanes_submodel_at(const BmLanes* l, size_t i);
BMFFI_API size_t bm_lanes_submodel_pieces(const BmLanes* l, size_t i, uint32_t* out, size_t cap);
BMFFI_API size_t bm_lanes_diagnostics(const BmLanes* l, size_t* out, size_t cap);
/// -1 with no runs.
BMFFI_API int64_t bm_lanes_run_index_at(const BmLanes* l, double seconds);
BMFFI_API double bm_lanes_travel(const BmLanes* l, double time, double duration, bool forward);
BMFFI_API bool bm_lanes_arrival_target(const BmLanes* l, const BmTimeline* t, const BmSession* s, double time,
                                       const uint32_t* excluding, size_t n, int32_t* step, size_t* before,
                                       double* at);
BMFFI_API void bm_lanes_free(BmLanes* l);

/// Packs spans sorted by x into rows; writes each span's row, returns the row count.
BMFFI_API size_t bm_pack_lane(const double* x, const double* width, size_t n, uint32_t* rows_out);

/// Zoom and scroll of a timeline track area (bmapp/timeline_view.h). Mutators return true on a change.
typedef struct {
  double zoom, offset, viewport_width, lead_inset, trail_inset;
} BmTimelineView;
BMFFI_API bool bm_timeline_view_magnify(BmTimelineView* view, double factor, double screen_x);
BMFFI_API bool bm_timeline_view_zoom_by(BmTimelineView* view, double factor, double playhead, double duration);
BMFFI_API bool bm_timeline_view_fit(BmTimelineView* view);
BMFFI_API bool bm_timeline_view_reveal(BmTimelineView* view, double time, double duration, bool centred);
BMFFI_API bool bm_timeline_view_pan_at_edge(BmTimelineView* view, double screen_x);
BMFFI_API double bm_timeline_view_time_at(BmTimelineView view, double screen_x, double duration);
BMFFI_API double bm_tick_interval(double duration, double width);

// ---- Arrivals, sequence and step order ----
BMFFI_API BmChange bm_session_move_arrival(BmSession* s, const uint32_t* pieces, size_t n, size_t step, size_t before,
                                           bool force);
BMFFI_API BmChange bm_session_reorder_arrival(BmSession* s, size_t step, size_t from, size_t to);
BMFFI_API BmChange bm_session_set_arrival_pinned(BmSession* s, const uint32_t* pieces, size_t n, bool pinned);
BMFFI_API size_t bm_session_arrival_pins(const BmSession* s, uint32_t* out, size_t cap);
BMFFI_API BmChange bm_session_set_sequence_duration(BmSession* s, BmSegment segment, double seconds);
BMFFI_API BmChange bm_session_regenerate_steps(BmSession* s, const uint32_t* order, size_t n);
BMFFI_API BmChange bm_session_move_to_new_step(BmSession* s, const uint32_t* pieces, size_t n, size_t index);
/// How many edits undo can take back.
BMFFI_API size_t bm_session_undo_depth(const BmSession* s);

// ---- Build, staging, waiting parts and snap sound settings ----
typedef enum { BM_ORDER_TAKE_APART, BM_ORDER_BOTTOM_UP } BmBuildOrder;
typedef enum { BM_FLIGHT_AUTOMATIC, BM_FLIGHT_WEB, BM_FLIGHT_ARC } BmFlightShape;

typedef struct {
  bool standard_planner;
  BmBuildOrder order;
  BmFlightShape flight;
  bool clean_grown_units;
  double pieces_per_second, gap, step_pause, clearance, corner, video_seconds;
} BmBuildSettings;

BMFFI_API BmBuildSettings bm_session_build_settings(const BmSession* s);
BMFFI_API BmChange bm_session_set_build_settings(BmSession* s, BmBuildSettings settings);

/// Returned strings point into thread-local storage valid until the next staging read; copy at once.
typedef struct {
  const char *layout, *group, *sides, *match;
  double aspect;
} BmStagingSettings;

BMFFI_API BmStagingSettings bm_session_staging_settings(const BmSession* s);
BMFFI_API BmChange bm_session_set_staging_settings(BmSession* s, BmStagingSettings settings);
BMFFI_API double bm_session_staging_turn(const BmSession* s);
BMFFI_API BmChange bm_session_set_staging_turn(BmSession* s, double degrees);
BMFFI_API size_t bm_session_moved_waiting_parts(const BmSession* s);
BMFFI_API BmChange bm_session_put_back_waiting_parts(BmSession* s);
BMFFI_API BmChange bm_session_apply_staging(BmSession* s, BmStagingSettings settings, double turn, bool straighten);
BMFFI_API BmChange bm_session_turn_waiting_part(BmSession* s, uint32_t piece, double degrees);
BMFFI_API bool bm_viewport_can_turn_waiting_part(const BmViewport* v, uint32_t piece);
BMFFI_API double bm_viewport_waiting_turn_to_match(const BmViewport* v, uint32_t piece);
BMFFI_API bool bm_viewport_can_move_waiting_part(const BmViewport* v, uint32_t piece);
BMFFI_API bool bm_viewport_begin_waiting_drag(BmViewport* v, uint32_t piece, double x, double y);
BMFFI_API BmVec3 bm_viewport_drag_waiting_part(BmViewport* v, double x, double y);
BMFFI_API BmVec3 bm_viewport_end_waiting_drag(BmViewport* v);
BMFFI_API BmChange bm_session_shift_waiting_part(BmSession* s, uint32_t piece, BmVec3 delta);
BMFFI_API BmVec3 bm_session_waiting_shift(const BmSession* s, uint32_t piece);

typedef enum { BM_SNAP_PHYSICAL, BM_SNAP_RECORDED, BM_SNAP_SYNTHESISED } BmSnapSource;
typedef enum { BM_SNAP_ALL, BM_SNAP_FREESOUND, BM_SNAP_OPENGAMEART } BmSnapLibrary;
typedef enum { BM_SNAP_PLATE, BM_SNAP_BRICK, BM_SNAP_PIN } BmSnapExample;

typedef struct {
  bool enabled;
  BmSnapSource source;
  BmSnapLibrary library;
  double volume, room, stereo, click, brightness, thump, thump_pitch, thump_length, pitch, variation;
  bool size_pitch, size_match;
  int32_t together;
} BmSnapMix;

BMFFI_API BmSnapMix bm_session_snap_mix(const BmSession* s);
BMFFI_API BmChange bm_session_set_snap_mix(BmSession* s, BmSnapMix mix);
BMFFI_API BmSnapMix bm_snap_mix_preset(const char* name);
/// Free function: safe to call on a worker thread.
BMFFI_API bool bm_write_snap_preview(BmSnapMix mix, BmSnapExample example, const char* recordings, const char* file);
/// Empty string on success; otherwise a human-readable error.
BMFFI_API BmString bm_viewport_write_snap_track(BmViewport* v, const char* file, const char* recordings);

// ---- Keyframes (keys.cpp) ----
/// Channels in bmapp order: position x/y/z, rotation x/y/z, scale x/y/z, visibility.
typedef enum {
  BM_KEY_POSITION_X, BM_KEY_POSITION_Y, BM_KEY_POSITION_Z, BM_KEY_ROTATION_X, BM_KEY_ROTATION_Y,
  BM_KEY_ROTATION_Z, BM_KEY_SCALE_X, BM_KEY_SCALE_Y, BM_KEY_SCALE_Z, BM_KEY_VISIBILITY
} BmKeyChannel;
typedef enum { BM_INTERP_SMOOTH, BM_INTERP_LINEAR, BM_INTERP_HOLD } BmKeyInterpolation;
typedef enum { BM_GIZMO_TOOL_MOVE, BM_GIZMO_TOOL_ROTATE, BM_GIZMO_TOOL_SCALE } BmGizmoTool;
/// `channel` is a BmKeyChannel, `interpolation` a BmKeyInterpolation.
typedef struct {
  int32_t channel;
  int32_t frame;
  double value;
  int32_t interpolation;
} BmKeyframe;
typedef struct {
  int32_t fps, first, last;
  bool build_linked;
  int32_t build_start;
  double build_speed;
} BmKeyScene;
typedef struct {
  uint32_t piece;
  int32_t frame;
  bool submodel;
} BmKeyRowPick;
typedef struct {
  int32_t frame;
  BmVec3 at;
} BmFlightPathPoint;
/// A flight pose: position plus rotation quaternion.
typedef struct {
  BmVec3 position;
  double qx, qy, qz, qw;
} BmFlightPose;
/// `name` lives until bm_key_objects_free.
typedef struct {
  uint32_t piece;
  bool submodel;
  const char* name;
  bool baked, keyed;
  size_t keys, members, markers;
} BmKeyObjectRow;

typedef struct BmKeyObjects BmKeyObjects;
typedef struct BmFlightPath BmFlightPath;

BMFFI_API BmKeyScene bm_session_key_scene(const BmSession* s);
BMFFI_API BmChange bm_session_set_key_scene(BmSession* s, BmKeyScene scene);
BMFFI_API BmKeyObjects* bm_session_key_objects(const BmSession* s);
BMFFI_API size_t bm_key_objects_len(const BmKeyObjects* o);
BMFFI_API BmKeyObjectRow bm_key_objects_at(const BmKeyObjects* o, size_t i);
/// Two-call arrays: each returns the full count and copies at most `cap`.
BMFFI_API size_t bm_key_objects_keys(const BmKeyObjects* o, size_t i, BmKeyframe* out, size_t cap);
BMFFI_API size_t bm_key_objects_members(const BmKeyObjects* o, size_t i, uint32_t* out, size_t cap);
BMFFI_API size_t bm_key_objects_markers(const BmKeyObjects* o, size_t i, int32_t* frames, size_t* channels, size_t cap);
BMFFI_API void bm_key_objects_free(BmKeyObjects* o);
/// The nearest marker frame strictly after (or before) `frame` among `frames`.
BMFFI_API bool bm_key_adjacent_frame(const int32_t* frames, size_t n, int32_t frame, bool after, int32_t* out);

BMFFI_API double bm_session_key_value(const BmSession* s, uint32_t piece, int32_t channel, double frame, bool submodel);
BMFFI_API BmChange bm_session_set_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n, bool continuing,
                                       bool submodel);
BMFFI_API BmChange bm_session_remove_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n, bool submodel);
BMFFI_API BmChange bm_session_move_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n, int32_t offset,
                                        bool submodel);
BMFFI_API BmChange bm_session_move_key_rows(BmSession* s, const BmKeyRowPick* picks, size_t n, int32_t offset);
BMFFI_API BmChange bm_session_remove_key_rows(BmSession* s, const BmKeyRowPick* picks, size_t n);
BMFFI_API BmChange bm_session_set_baked_keys(BmSession* s, uint32_t piece, const BmKeyframe* keys, size_t n);
BMFFI_API bool bm_session_has_editable_flight_keys(const BmSession* s, uint32_t piece);
BMFFI_API BmChange bm_session_add_flight_path_point(BmSession* s, uint32_t piece, int32_t frame);
BMFFI_API BmChange bm_session_set_flight_path_point(BmSession* s, uint32_t piece, int32_t frame, BmVec3 at,
                                                    bool continuing);
BMFFI_API BmChange bm_session_delete_flight_path_point(BmSession* s, uint32_t piece, int32_t frame);
BMFFI_API BmChange bm_session_return_flight_to_planner(BmSession* s, uint32_t piece);
BMFFI_API BmChange bm_session_use_flight_in_build(BmSession* s, uint32_t piece, const BmFlightPose* route, size_t n);

/// The viewport plays the key scene (true) or the planned Build (false).
BMFFI_API void bm_viewport_use_keyframes(BmViewport* v, bool enabled);
/// NULL when the piece has no baked one-piece flight path.
BMFFI_API BmFlightPath* bm_viewport_flight_path(BmViewport* v, uint32_t piece);
BMFFI_API size_t bm_flight_path_line(const BmFlightPath* p, BmFlightPathPoint* out, size_t cap);
BMFFI_API size_t bm_flight_path_keys(const BmFlightPath* p, BmFlightPathPoint* out, size_t cap);
BMFFI_API void bm_flight_path_free(BmFlightPath* p);
BMFFI_API BmVec3 bm_viewport_drag_facing_view(const BmViewport* v, BmVec3 through, double x0, double y0, double x1,
                                              double y1);
BMFFI_API size_t bm_viewport_edited_flight_route(BmViewport* v, uint32_t piece, BmFlightPose* out, size_t cap);

BMFFI_API void bm_key_offset_limits(BmKeyScene scene, int32_t earliest, int32_t latest, int32_t* lower, int32_t* upper);
BMFFI_API BmKeyScene bm_linked_key_scene(BmKeyScene scene, bool enabled, double build_duration);
BMFFI_API double bm_flight_keys_start(BmKeyScene scene, double flight_start);
/// Writes three keys (fewer if `cap` < 3); returns 3.
BMFFI_API size_t bm_auto_key_values(int32_t tool, BmVec3 origin, BmVec3 change, int32_t frame, BmKeyframe* out,
                                    size_t cap);
/// `key_submodel` < 0: none. False when Auto Key cannot key this selection.
BMFFI_API bool bm_auto_key_target(const BmSession* s, const uint32_t* selection, size_t n, bool auto_key,
                                  int64_t key_submodel, uint32_t* piece, bool* submodel);

// ---- Camera track, Auto-direct and scene cameras (camera.cpp) ----
typedef enum { BM_CLOCK_BUILD, BM_CLOCK_TIMELINE } BmCameraClock;
/// Strings: read from a list handle, they live until it is freed; passed in, they are copied.
typedef struct {
  const char* id;
  const char* name;
  BmVec3 position, target;
  double field_of_view, near_clip, far_clip;
  bool orthographic;
} BmSceneCamera;
typedef struct {
  const char* id;
  double seconds;
  const char* target;  ///< "model", "build", "piece" or "point"
  const char* preset;
  double azimuth, elevation, lens_mm;
  bool fitted, user;
  double margin, distance, roll;
  bool focus_target;
  double focus, blur;
  BmVec3 point, eye;
} BmCameraKey;
typedef struct {
  const char* from;
  const char* to;
  const char* preset;
  bool user, cut, flow_through;
  const char* curve;
  double strength;
  bool straight;
  const char* orbit;
  int32_t extra_turns;
  double overshoot, motion_blur, shake, shake_frequency, turn_last;
} BmCameraMove;
typedef struct {
  const char* id;
  const char* label;
  const char* hint;
} BmCameraPreset;
/// `clock` is a BmCameraClock.
typedef struct {
  int32_t clock;
  double fps, duration;
  bool ready;
} BmCameraClockInfo;

typedef struct BmCameraKeys BmCameraKeys;
typedef struct BmCameraMoves BmCameraMoves;
typedef struct BmCameraPresets BmCameraPresets;
typedef struct BmSceneCameras BmSceneCameras;

BMFFI_API BmCameraKeys* bm_session_camera_keys(const BmSession* s, int32_t clock);
BMFFI_API size_t bm_camera_keys_len(const BmCameraKeys* k);
BMFFI_API BmCameraKey bm_camera_keys_at(const BmCameraKeys* k, size_t i);
/// The key within half a frame of `now`, or -1.
BMFFI_API int64_t bm_camera_key_at(const BmCameraKeys* k, double now, double fps);
BMFFI_API void bm_camera_keys_free(BmCameraKeys* k);
BMFFI_API BmCameraMoves* bm_session_camera_moves(const BmSession* s, int32_t clock);
BMFFI_API size_t bm_camera_moves_len(const BmCameraMoves* m);
BMFFI_API BmCameraMove bm_camera_moves_at(const BmCameraMoves* m, size_t i);
BMFFI_API void bm_camera_moves_free(BmCameraMoves* m);
BMFFI_API BmCameraPresets* bm_camera_presets(void);
BMFFI_API size_t bm_camera_presets_len(const BmCameraPresets* p);
BMFFI_API BmCameraPreset bm_camera_presets_at(const BmCameraPresets* p, size_t i);
BMFFI_API void bm_camera_presets_free(BmCameraPresets* p);

BMFFI_API BmString bm_session_camera_director_style(const BmSession* s, int32_t clock);
BMFFI_API BmChange bm_session_add_camera_key(BmSession* s, int32_t clock, double seconds, BmSceneCamera view, double fps,
                                             double duration);
BMFFI_API BmChange bm_session_set_camera_key_view(BmSession* s, int32_t clock, const char* id, BmSceneCamera view);
BMFFI_API BmChange bm_session_move_camera_key(BmSession* s, int32_t clock, const char* id, double seconds, double fps,
                                              double duration);
BMFFI_API BmChange bm_session_remove_camera_key(BmSession* s, int32_t clock, const char* id);
BMFFI_API BmChange bm_session_set_camera_key_target(BmSession* s, int32_t clock, const char* id, const char* target);
BMFFI_API BmChange bm_session_set_camera_key(BmSession* s, int32_t clock, BmCameraKey key, bool continuing);
BMFFI_API BmChange bm_session_set_camera_move(BmSession* s, int32_t clock, BmCameraMove move, bool continuing);
BMFFI_API BmChange bm_session_choose_camera_preset(BmSession* s, int32_t clock, const char* from, const char* preset,
                                                   double distance);
BMFFI_API BmChange bm_session_clear_camera_track(BmSession* s, int32_t clock);
/// "track", "automatic" or "buildView".
BMFFI_API BmString bm_session_export_camera(const BmSession* s);
BMFFI_API BmChange bm_session_set_export_camera(BmSession* s, const char* camera);

BMFFI_API BmSceneCameras* bm_session_scene_cameras(const BmSession* s);
BMFFI_API size_t bm_scene_cameras_len(const BmSceneCameras* c);
BMFFI_API BmSceneCamera bm_scene_cameras_at(const BmSceneCameras* c, size_t i);
BMFFI_API const char* bm_scene_cameras_active_id(const BmSceneCameras* c);
BMFFI_API bool bm_scene_cameras_use_for_video(const BmSceneCameras* c);
BMFFI_API void bm_scene_cameras_free(BmSceneCameras* c);
BMFFI_API BmChange bm_session_save_scene_camera(BmSession* s, BmSceneCamera camera);
BMFFI_API BmChange bm_session_remove_scene_camera(BmSession* s, const char* id);
/// "" uses the automatic camera for video.
BMFFI_API BmChange bm_session_activate_scene_camera(BmSession* s, const char* id);

/// The view as a scene camera; its strings are owned by the caller: free with bm_scene_camera_free.
BMFFI_API BmSceneCamera bm_viewport_capture_scene_camera(const BmViewport* v);
BMFFI_API BmSceneCamera bm_viewport_camera_track_view(BmViewport* v, double seconds);
BMFFI_API void bm_scene_camera_free(BmSceneCamera camera);
BMFFI_API bool bm_viewport_recall_scene_camera(BmViewport* v, const char* id);
BMFFI_API bool bm_viewport_follows_camera_track(BmViewport* v);
BMFFI_API void bm_viewport_set_director_preview(BmViewport* v, bool directed);

BMFFI_API BmCameraClockInfo bm_camera_clock_info(int32_t clock, const BmSession* s, double build_fps,
                                                 double build_duration, bool build_ready);
BMFFI_API bool bm_can_auto_direct(int32_t clock, const BmSession* s, bool build_ready);
/// A key filming the viewport's view at `now`; the key already there takes the view. `id` gets
/// the key to select (caller frees), `added` whether a key was made.
BMFFI_API BmChange bm_add_camera_key_from_view(BmSession* s, BmViewport* v, int32_t clock, double now,
                                               BmCameraClockInfo info, BmString* id, bool* added);
BMFFI_API BmChange bm_aim_camera_key(BmSession* s, BmViewport* v, int32_t clock, BmCameraKey key, const char* target);
BMFFI_API BmChange bm_auto_direct(BmSession* s, BmViewport* v, int32_t clock, const char* style);

// ---- Motion, flight bake, motion check and joints (motion.cpp) ----
typedef enum { BM_MOTION_PROJECT, BM_MOTION_STEP, BM_MOTION_PARTS } BmMotionScope;
/// Negative fields are inherited. `ease`: -1 inherited, then smooth, gentle, soft, linear.
typedef struct {
  double time, landing, hover;
  int32_t ease;
} BmMotionFields;
typedef struct {
  int32_t flights, keys;
  BmString error;
} BmFlightBakeResult;
/// `part` and `blocker` live until bm_motion_report_free.
typedef struct {
  uint32_t a, b;
  int32_t first_frame, last_frame;
  const char* part;
  const char* blocker;
} BmMotionContact;
typedef enum { BM_JOINT_FIXED, BM_JOINT_HINGE, BM_JOINT_SLIDER, BM_JOINT_CYLINDRICAL, BM_JOINT_BALL, BM_JOINT_FLEXIBLE } BmJointType;
/// `type` is a BmJointType.
typedef struct {
  uint32_t a, b;
  int32_t type;
  BmVec3 point, axis, release;
  double angle, clearance;
  size_t mate_count;
} BmJointRow;

typedef struct BmFlightBake BmFlightBake;
typedef struct BmMotionAudit BmMotionAudit;
typedef struct BmMotionReport BmMotionReport;
typedef struct BmInspection BmInspection;
typedef struct BmJoints BmJoints;
typedef struct BmJointEdit BmJointEdit;

BMFFI_API BmMotionFields bm_session_motion_fields(const BmSession* s, int32_t scope, size_t step, const uint32_t* pieces,
                                                  size_t n);
BMFFI_API BmChange bm_session_set_motion_fields(BmSession* s, int32_t scope, size_t step, const uint32_t* pieces,
                                                size_t n, BmMotionFields fields);
BMFFI_API BmMotionFields bm_effective_motion(const BmSession* s, int32_t scope, size_t step, BmMotionFields fields);
BMFFI_API void bm_flight_phases(BmMotionFields effective, double* travel, double* hover, double* landing);

/// NULL when nothing is planned to bake. A bake handle may move to one worker thread.
BMFFI_API BmFlightBake* bm_viewport_capture_flight_bake(BmViewport* v, const uint32_t* pieces, size_t n, bool detach);
BMFFI_API bool bm_flight_bake_replaces_keys(const BmFlightBake* b);
/// Slow; run it off the UI thread. The error string is owned by the caller.
BMFFI_API BmFlightBakeResult bm_flight_bake_prepare(BmFlightBake* b);
BMFFI_API BmChange bm_session_apply_flight_bake(BmSession* s, BmFlightBake* b);
BMFFI_API void bm_flight_bake_free(BmFlightBake* b);

/// NULL when the piece has nothing to check. An audit handle may move to one worker thread.
BMFFI_API BmMotionAudit* bm_viewport_audit_motion(BmViewport* v, uint32_t piece);
/// Slow; run it off the UI thread.
BMFFI_API BmMotionReport* bm_motion_audit_check(BmMotionAudit* a);
BMFFI_API void bm_motion_audit_free(BmMotionAudit* a);
BMFFI_API void bm_motion_report_counts(const BmMotionReport* r, int32_t* tested_frames, int32_t* stride,
                                       int32_t* intervals);
BMFFI_API const char* bm_motion_report_error(const BmMotionReport* r);
BMFFI_API size_t bm_motion_report_contacts_len(const BmMotionReport* r);
BMFFI_API BmMotionContact bm_motion_report_contact_at(const BmMotionReport* r, size_t i);
BMFFI_API void bm_motion_report_free(BmMotionReport* r);

/// A snapshot of the model for joint work; may move to one worker thread.
BMFFI_API BmInspection* bm_inspection_capture(const BmSession* s);
BMFFI_API BmJoints* bm_inspection_joints(BmInspection* i, const uint32_t* selection, size_t n, bool show_all,
                                         bool check_geometry);
BMFFI_API size_t bm_joints_len(const BmJoints* j);
BMFFI_API BmJointRow bm_joints_at(const BmJoints* j, size_t i);
BMFFI_API const char* bm_joints_error(const BmJoints* j);
BMFFI_API void bm_joints_free(BmJoints* j);
BMFFI_API size_t bm_inspection_body(BmInspection* i, uint32_t piece, uint32_t* out, size_t cap);
BMFFI_API BmJointEdit* bm_inspection_change_joint(BmInspection* i, uint32_t fixed, uint32_t moving, double degrees,
                                                  bool collision);
BMFFI_API size_t bm_joint_edit_pieces(const BmJointEdit* e, uint32_t* out, size_t cap);
BMFFI_API uint32_t bm_joint_edit_pivot(const BmJointEdit* e);
BMFFI_API void bm_joint_edit_pose(const BmJointEdit* e, BmMat3* rotation, BmVec3* position);
BMFFI_API const char* bm_joint_edit_error(const BmJointEdit* e);
BMFFI_API void bm_joint_edit_free(BmJointEdit* e);
BMFFI_API void bm_inspection_free(BmInspection* i);

/// Commits moved pieces at `anchor`'s pose; refused unless generation and version still match.
BMFFI_API BmChange bm_session_place_moved(BmSession* s, const uint32_t* pieces, size_t n, uint32_t anchor,
                                          BmMat3 rotation, BmVec3 position, uint64_t generation, uint64_t version);
BMFFI_API BmVec3 bm_session_insertion_direction(const BmSession* s, uint32_t piece);
BMFFI_API BmChange bm_session_set_insertion_direction(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 direction);

// ---- Look, file exports, export options and the viewport recorder (export.cpp, recorder.mm) ----
/// `scene` lives until the next bm_session_render_look call on this thread. `shading`: 0 standard,
/// 1 studio, 2 neural, 3 hybrid RT, 4 screen-space GI, 5 path traced.
typedef struct {
  const char* scene;
  int32_t shading;
  bool edges, shadows, ambient_occlusion, floor, raytraced_glass, world_gi_occlusion, lights_follow_camera;
  int32_t path_samples;
} BmRenderLook;
/// `collection`: 0 photo, 1 render, 2 classic. Strings live until bm_scenes_free.
typedef struct {
  const char *id, *label, *hint;
  int32_t collection;
  BmVec3 background;
  bool floor;
} BmScenePreset;
typedef struct { int32_t width, height; } BmFrameSize;
typedef struct {
  bool present;
  double yaw_deg, pitch_deg, fov_deg;
  bool orthographic;
} BmViewAngles;
/// Enums as bmapp's, in order: source Build/Keyframes/Turntable; shape Landscape/Vertical/Portrait/
/// Square; resolution Small/Standard/Large; quality Compact/Standard/High; camera Director/Track/
/// Viewport/Saved; logo_corner TL/TR/BL/BR. NULL strings are empty.
typedef struct {
  int32_t source, shape, resolution, quality, fps, turntable_seconds, camera;
  const char* scene_camera_id;
  bool snap_audio, standard_preview;
  BmViewAngles angles;
  const char* const* model_path;
  size_t model_path_len;
  const char* logo;
  int32_t logo_corner;
} BmMovieChoice;
/// `samples`: 32 draft, 128 standard, 512 final.
typedef struct {
  int32_t shape;
  bool large;
  int32_t samples;
  bool viewport_angle;
  BmViewAngles angles;
} BmStillChoice;
typedef struct BmScenes BmScenes;
typedef struct BmVideoTargets BmVideoTargets;
typedef struct BmRecorder BmRecorder;

BMFFI_API BmRenderLook bm_session_render_look(const BmSession* s);
BMFFI_API BmChange bm_session_set_render_look(BmSession* s, BmRenderLook look);
BMFFI_API BmScenes* bm_scenes(void);
BMFFI_API size_t bm_scenes_len(const BmScenes* s);
BMFFI_API BmScenePreset bm_scenes_at(const BmScenes* s, size_t i);
BMFFI_API void bm_scenes_free(BmScenes* s);
BMFFI_API BmString bm_session_plan_bytes(const BmSession* s);
BMFFI_API BmString bm_session_mpd_bytes(const BmSession* s);
BMFFI_API BmString bm_session_submodel_mpd_bytes(const BmSession* s, const char* model);
BMFFI_API BmString bm_session_submodel_project_bytes(const BmSession* s, const char* model);

BMFFI_API BmFrameSize bm_movie_size(int32_t shape, int32_t resolution);
BMFFI_API BmFrameSize bm_still_size(int32_t shape, bool large);
BMFFI_API int32_t bm_movie_bit_rate(int32_t width, int32_t height, int32_t fps, int32_t quality);
BMFFI_API BmViewAngles bm_view_angles(BmCamera camera);
BMFFI_API BmStrings* bm_movie_arguments(BmMovieChoice choice);
BMFFI_API BmString bm_movie_summary(BmMovieChoice choice);
BMFFI_API BmStrings* bm_still_arguments(BmStillChoice choice, BmRenderLook look);
BMFFI_API BmString bm_still_summary(BmStillChoice choice, bool logo);
/// A MovieCamera: 0 director, 1 track, 2 viewport, 3 saved (the scene's active camera).
BMFFI_API int32_t bm_default_movie_camera(const BmSession* s, bool batch, bool has_angle);
BMFFI_API bool bm_movie_allows_track(const BmSession* s, BmMovieChoice choice, bool batch, bool focused_model_chosen);
/// With `filter`, only the outline rows whose ids are in `ids`.
BMFFI_API BmVideoTargets* bm_submodel_video_targets(const BmSession* s, const char* const* ids, size_t n, bool filter);
BMFFI_API size_t bm_video_targets_len(const BmVideoTargets* t);
BMFFI_API const char* bm_video_targets_title(const BmVideoTargets* t, size_t i);
BMFFI_API size_t bm_video_targets_path_len(const BmVideoTargets* t, size_t i);
BMFFI_API const char* bm_video_targets_path_at(const BmVideoTargets* t, size_t i, size_t j);
BMFFI_API void bm_video_targets_free(BmVideoTargets* t);
BMFFI_API BmString bm_safe_file_stem(const char* name);
/// A model's name as people read it: no .ldr/.dat/.mpd, runs of spaces made one.
BMFFI_API BmString bm_display_name(const char* raw);
/// "" on success, else why.
BMFFI_API BmString bm_stamp_logo(const char* png, const char* logo, int32_t corner);
/// The movie helper (`project --out file options…`); prints why it failed to stderr; 0 on success.
BMFFI_API int32_t bm_run_editor_movie(const char* const* args, size_t n);

/// An H.264 movie of viewport frames at even dimensions (the longest side at most 3840). NULL
/// with `error` set when it cannot start. A recorder may move to one other thread.
BMFFI_API BmRecorder* bm_recorder_start(const char* path, int32_t width, int32_t height, BmString* error);
/// Draws an RGBA frame (top row first) fitted into the movie at `seconds`; false when dropped.
BMFFI_API bool bm_recorder_append(BmRecorder* r, const uint8_t* rgba, size_t len, int32_t width, int32_t height,
                                  double seconds);
BMFFI_API BmFrameSize bm_recorder_size(const BmRecorder* r);
/// Finishes the file and frees the recorder; "" on success, else why.
BMFFI_API BmString bm_recorder_finish(BmRecorder* r);
/// Frees a recorder without finishing (the file is left incomplete).
BMFFI_API void bm_recorder_free(BmRecorder* r);
/// The video track's frame count, or -1 when the file has none.
BMFFI_API int64_t bm_movie_frame_count(const char* path);
/// The audio track's length in seconds, or -1 when the file has none.
BMFFI_API double bm_movie_audio_seconds(const char* path);

// ---- Model checks, loose pieces, habit fits, fitting parts and inventory (inspection.cpp, inventory.cpp) ----
typedef struct {
  uint32_t piece, onto;
  BmMat3 rotation;
  BmVec3 position;
  double offset, angle;
  bool safe;
} BmLoosePiece;
typedef struct {
  int32_t color;
  BmMat3 rotation;
  BmVec3 position;
  uint32_t models, total, links;
} BmHabitFit;
typedef struct {
  uint32_t piece;
  BmMat3 rotation;
  BmVec3 position;
} BmPieceMove;
typedef struct BmModelChecks BmModelChecks;
typedef struct BmLoosePieces BmLoosePieces;
typedef struct BmHabitFits BmHabitFits;
typedef struct BmFittingParts BmFittingParts;
typedef struct BmInventory BmInventory;
typedef struct BmInventoryReport BmInventoryReport;

BMFFI_API void bm_session_show(BmSession* s, const uint32_t* pieces, size_t n);
BMFFI_API void bm_session_part_at(const BmSession* s, uint32_t piece, BmString* name, BmString* description,
                                  BmString* category);
BMFFI_API int32_t bm_session_part_color(const BmSession* s, uint32_t piece);

BMFFI_API BmModelChecks* bm_inspection_check_model(BmInspection* i);
BMFFI_API size_t bm_model_checks_len(const BmModelChecks* c);
BMFFI_API int32_t bm_model_checks_kind(const BmModelChecks* c, size_t i);
BMFFI_API const char* bm_model_checks_title(const BmModelChecks* c, size_t i);
BMFFI_API const char* bm_model_checks_detail(const BmModelChecks* c, size_t i);
BMFFI_API size_t bm_model_checks_pieces(const BmModelChecks* c, size_t i, uint32_t* out, size_t cap);
BMFFI_API const char* bm_model_checks_error(const BmModelChecks* c);
BMFFI_API void bm_model_checks_free(BmModelChecks* c);

BMFFI_API BmLoosePieces* bm_inspection_loose_pieces(BmInspection* i);
BMFFI_API size_t bm_loose_pieces_len(const BmLoosePieces* l);
BMFFI_API BmLoosePiece bm_loose_pieces_at(const BmLoosePieces* l, size_t i);
BMFFI_API const char* bm_loose_pieces_note(const BmLoosePieces* l, size_t i);
BMFFI_API const char* bm_loose_pieces_error(const BmLoosePieces* l);
BMFFI_API void bm_loose_pieces_free(BmLoosePieces* l);
BMFFI_API size_t bm_loose_initial_choice(const BmLoosePieces* l, uint32_t* out, size_t cap);
BMFFI_API uint32_t bm_loose_waiting_on(const BmLoosePieces* l, uint32_t piece, const uint32_t* chosen, size_t n);
BMFFI_API size_t bm_loose_uncheck(const BmLoosePieces* l, uint32_t piece, const uint32_t* chosen, size_t n,
                                  uint32_t* out, size_t cap);
BMFFI_API BmString bm_loose_detail(const BmLoosePieces* l, size_t i, const char* onto_name);

BMFFI_API BmHabitFits* bm_inspection_habit_fits(BmInspection* i, uint32_t piece, size_t limit);
BMFFI_API size_t bm_habit_fits_len(const BmHabitFits* h);
BMFFI_API BmHabitFit bm_habit_fits_at(const BmHabitFits* h, size_t i);
BMFFI_API const char* bm_habit_fits_name(const BmHabitFits* h, size_t i);
BMFFI_API const char* bm_habit_fits_description(const BmHabitFits* h, size_t i);
BMFFI_API const char* bm_habit_fits_joint(const BmHabitFits* h, size_t i);
BMFFI_API const char* bm_habit_fits_why(const BmHabitFits* h, size_t i);
BMFFI_API void bm_habit_fits_free(BmHabitFits* h);

BMFFI_API BmFittingParts* bm_inspection_fitting_parts(BmInspection* i, uint32_t piece, const char* const* candidates,
                                                      size_t n, size_t limit);
BMFFI_API size_t bm_fitting_parts_len(const BmFittingParts* f);
BMFFI_API const char* bm_fitting_parts_name(const BmFittingParts* f, size_t i);
BMFFI_API BmVec3 bm_fitting_parts_contact(const BmFittingParts* f, size_t i);
BMFFI_API void bm_fitting_parts_free(BmFittingParts* f);
// Where `piece` sits in the open model: rotation (with any scale) and position.
BMFFI_API BmPieceMove bm_session_pose_of(const BmSession* s, uint32_t piece);
// Fit Together: poses that seat `moving` onto `target`, best first. Writes up to `cap`; returns
// how many there are.
BMFFI_API size_t bm_inspection_fits(BmInspection* i, uint32_t moving, uint32_t target, BmPieceMove* out, size_t cap);

BMFFI_API BmChange bm_session_seat_pieces(BmSession* s, const BmPieceMove* moves, size_t n, uint64_t generation,
                                          uint64_t version);
// Sets pieces at these world poses as one undo step named "Reset Transform"; refuses a stale revision.
BMFFI_API BmChange bm_session_reset_poses(BmSession* s, const BmPieceMove* moves, size_t n, uint64_t generation,
                                          uint64_t version);

// ---- Submodel focus and extended joint kinematics ----
typedef struct BmJointInfoHandle BmJointInfoHandle;
typedef struct {
  int32_t kind;
  BmVec3 pivot, axis;
  bool can_turn, can_slide, full_turn;
  double min_deg, max_deg;
  double min_slide, max_slide;
} BmJointInfo;

BMFFI_API BmChange bm_session_focus(BmSession* s, const char* const* path, size_t n);
BMFFI_API BmString bm_session_focused(const BmSession* s);
BMFFI_API BmString bm_session_focus_path(const BmSession* s);
BMFFI_API size_t bm_session_use_pieces(const BmSession* s, uint32_t piece, uint32_t* out, size_t cap);
BMFFI_API BmString bm_lanes_submodel_path(const BmLanes* l, size_t i);

BMFFI_API BmJointInfoHandle* bm_inspection_joint_info(BmInspection* i, uint32_t fixed, uint32_t moving, bool collision);
BMFFI_API BmJointInfo bm_joint_info_data(const BmJointInfoHandle* h);
BMFFI_API size_t bm_joint_info_pieces(const BmJointInfoHandle* h, uint32_t* out, size_t cap);
BMFFI_API const char* bm_joint_info_min_blocker(const BmJointInfoHandle* h);
BMFFI_API const char* bm_joint_info_max_blocker(const BmJointInfoHandle* h);
BMFFI_API const char* bm_joint_info_error(const BmJointInfoHandle* h);
BMFFI_API void bm_joint_info_free(BmJointInfoHandle* h);
BMFFI_API BmJointEdit* bm_inspection_change_joint_ex(BmInspection* i, uint32_t fixed, uint32_t moving, double degrees,
                                                     double slide_ldu, BmVec3 axis_override, bool collision);

BMFFI_API BmInventory* bm_inventory_capture(const BmSession* s, int32_t step);
BMFFI_API BmInventoryReport* bm_inventory_prepare(BmInventory* inv, const char* path);
BMFFI_API const char* bm_inventory_report_error(const BmInventoryReport* r);
BMFFI_API size_t bm_inventory_report_pieces(const BmInventoryReport* r);
BMFFI_API size_t bm_inventory_report_spares(const BmInventoryReport* r);
BMFFI_API size_t bm_inventory_report_invalid_rows(const BmInventoryReport* r);
BMFFI_API size_t bm_inventory_report_missing_len(const BmInventoryReport* r);
BMFFI_API const char* bm_inventory_report_missing_at(const BmInventoryReport* r, size_t i);
BMFFI_API void bm_inventory_report_free(BmInventoryReport* r);
BMFFI_API BmChange bm_session_import_inventory(BmSession* s, const BmInventory* inv);
BMFFI_API void bm_inventory_free(BmInventory* inv);

// ---- Submodels, groups, scale and import into ----
typedef struct BmModelImport BmModelImport;

/// `preferred`, else "<preferred> 2", 3, ...: the first name no submodel has.
BMFFI_API BmString bm_session_free_submodel_name(const BmSession* s, const char* preferred);
BMFFI_API BmChange bm_session_new_submodel(BmSession* s, const char* name);
BMFFI_API BmChange bm_session_make_submodel(BmSession* s, const uint32_t* pieces, size_t n, const char* name);
BMFFI_API BmChange bm_session_extract(BmSession* s, uint32_t piece);
BMFFI_API BmChange bm_session_move_to_model(BmSession* s, const uint32_t* pieces, size_t n, const char* submodel);
BMFFI_API BmChange bm_session_rename_submodel(BmSession* s, const char* from, const char* to);
BMFFI_API BmChange bm_session_delete_submodel(BmSession* s, const char* submodel);
BMFFI_API BmChange bm_session_make_unique(BmSession* s, uint32_t piece);
/// Empty `group` removes the mark. Names are joined with '\n'.
BMFFI_API BmChange bm_session_set_group(BmSession* s, const uint32_t* pieces, size_t n, const char* group);
BMFFI_API BmString bm_session_group_names(const BmSession* s);
BMFFI_API BmString bm_session_groups_of(const BmSession* s, const uint32_t* pieces, size_t n);
BMFFI_API void bm_session_select_group(BmSession* s, const char* group);
BMFFI_API BmChange bm_session_scale(BmSession* s, const uint32_t* pieces, size_t n, BmVec3 factor, BmMat3 axes,
                                   BmVec3 pivot, bool continuing);
/// Reads a model file once (safe off the main thread); check `bm_model_import_error`.
BMFFI_API BmModelImport* bm_model_import_read(const char* path);
BMFFI_API const char* bm_model_import_error(const BmModelImport* m);
BMFFI_API BmChange bm_session_import_model(BmSession* s, const BmModelImport* m, const char* into,
                                          uint64_t generation);
BMFFI_API void bm_model_import_free(BmModelImport* m);

#ifdef __cplusplus
}
#endif
