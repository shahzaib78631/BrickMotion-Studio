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

#ifdef __cplusplus
}
#endif
