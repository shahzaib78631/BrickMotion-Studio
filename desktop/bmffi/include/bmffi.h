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
/// UI thread: takes the document `loaded` opened (on a worker) into `into`.
BMFFI_API void bm_session_adopt(BmSession* into, const BmSession* loaded);
BMFFI_API BmString bm_session_title(const BmSession* s);
BMFFI_API size_t bm_session_piece_count(const BmSession* s);
BMFFI_API uint64_t bm_session_generation(const BmSession* s);
BMFFI_API void bm_session_select(BmSession* s, const uint32_t* pieces, size_t n, BmSelectMode mode);
/// Returns the total; writes min(total, cap) pieces into `out`.
BMFFI_API size_t bm_session_selection(const BmSession* s, uint32_t* out, size_t cap);

/// NULL when this Mac has no Metal device.
BMFFI_API BmViewport* bm_viewport_new(BmSession* s);
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

#ifdef __cplusplus
}
#endif
