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

#ifdef __cplusplus
}
#endif
