// BrickMotion host additions; upstream rendering and shaders are unchanged.
thread_local! {
    static BRICKMOTION_SUBMITTED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static BRICKMOTION_COMPLETED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

// Bound the browser's work queue: recording faster than the GPU renders builds
// latency and memory without producing more visible animation frames.
#[wasm_bindgen(js_name = markSubmitted)]
pub fn brickmotion_mark_submitted() -> Result<(), JsValue> {
    view(|v| {
        let serial = BRICKMOTION_SUBMITTED.with(|n| { let next = n.get() + 1; n.set(next); next });
        v.core.g.queue.on_submitted_work_done(move || {
            BRICKMOTION_COMPLETED.with(|n| n.set(n.get().max(serial)));
        });
        Ok(())
    })
}

#[wasm_bindgen(js_name = frameIdle)]
pub fn brickmotion_frame_idle() -> bool {
    BRICKMOTION_SUBMITTED.with(|submitted| BRICKMOTION_COMPLETED.with(|completed| completed.get() >= submitted.get()))
}

// A view must be dropped before opening another surface on the same canvas.
#[wasm_bindgen(js_name = stopView)]
pub fn brickmotion_stop_view() {
    VIEW.with_borrow_mut(|v| {
        if let Some(view) = v.take() {
            view.core.g.device.destroy();
        }
    });
}

#[wasm_bindgen(js_name = resetEngine)]
pub fn brickmotion_reset_engine() {
    brickmotion_stop_view();
    ENGINE.with_borrow_mut(|e| *e = Engine::default());
}
