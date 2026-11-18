//! Scalar f64 port of shapes.ts / surfaceContact.ts. No geometric simplification.
//! The caller owns linear memory; pointers are non-owning, job-scoped buffers.
use std::mem::MaybeUninit;
#[repr(C)]
struct Shape {
    tris: u32,
    coefficients: u32,
    points: u32,
    sides: u32,
    nodes: u32,
    point_count: u32,
    node_count: u32,
    triangle_count: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Node {
    min: [f64; 3],
    max: [f64; 3],
    left: i32,
    right: i32,
    first: u32,
    count: u32,
}
#[derive(Clone, Copy)]
struct Hit {
    t: f64,
    enters: bool,
    valid: bool,
}
const INF: f64 = f64::INFINITY;
static mut LAST_PROBE: i32 = -1;
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn last_probe() -> i32 {
    unsafe { LAST_PROBE }
}
unsafe fn coefficient(s: &Shape, i: usize, k: usize) -> f64 {
    *((s.coefficients as *const f64).add(i * 10 + k))
}
unsafe fn vertex(s: &Shape, i: usize, k: usize) -> f64 {
    *((s.tris as *const f32).add(i * 9 + k)) as f64
}
unsafe fn node(s: &Shape, i: usize) -> Node {
    *((s.nodes as *const Node).add(i))
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn seg_sq(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab = sub(b, a);
    let ap = sub(p, a);
    let length = dot(ab, ab);
    let t = if length != 0.0 {
        (dot(ap, ab) / length).max(0.0).min(1.0)
    } else {
        0.0
    };
    let d = [ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]];
    dot(d, d)
}
unsafe fn tri_sq(s: &Shape, i: usize, p: [f64; 3]) -> f64 {
    let a = [vertex(s, i, 0), vertex(s, i, 1), vertex(s, i, 2)];
    let b = [vertex(s, i, 3), vertex(s, i, 4), vertex(s, i, 5)];
    let c = [vertex(s, i, 6), vertex(s, i, 7), vertex(s, i, 8)];
    let ab = [
        coefficient(s, i, 0),
        coefficient(s, i, 1),
        coefficient(s, i, 2),
    ];
    let ac = [
        coefficient(s, i, 3),
        coefficient(s, i, 4),
        coefficient(s, i, 5),
    ];
    let n = [
        coefficient(s, i, 6),
        coefficient(s, i, 7),
        coefficient(s, i, 8),
    ];
    let nn = coefficient(s, i, 9);
    if nn < 1e-24 {
        return seg_sq(p, a, b).min(seg_sq(p, b, c)).min(seg_sq(p, c, a));
    }
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return dot(ap, ap);
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return dot(bp, bp);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return seg_sq(p, a, b);
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return dot(cp, cp);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return seg_sq(p, a, c);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return seg_sq(p, b, c);
    }
    let h = dot(ap, n);
    (h * h / nn).max(0.0)
}
fn ray_entry(nd: Node, o: [f64; 3], d: [f64; 3], from: f64, to: f64) -> f64 {
    let mut lo = from.max(0.0);
    let mut hi = to;
    for k in 0..3 {
        if d[k].abs() < 1e-12 {
            if o[k] < nd.min[k] || o[k] > nd.max[k] {
                return INF;
            }
        } else {
            let inv = 1.0 / d[k];
            let a = (nd.min[k] - o[k]) * inv;
            let b = (nd.max[k] - o[k]) * inv;
            lo = lo.max(a.min(b));
            hi = hi.min(a.max(b));
            if lo > hi {
                return INF;
            }
        }
    }
    lo
}
unsafe fn nearest(s: &Shape, o: [f64; 3], d: [f64; 3], from: f64, to: f64) -> Hit {
    // Every pushed slot is written before pop; unused capacity needs no zero-fill.
    let mut stack = [MaybeUninit::<usize>::uninit(); 64];
    stack[0].write(0);
    let mut entries = [MaybeUninit::<f64>::uninit(); 64];
    let mut top = 1;
    entries[0].write(ray_entry(node(s, 0), o, d, from, to));
    let mut best = to;
    let mut found = false;
    let mut enters = false;
    let mut best_leaf = u32::MAX;
    let mut best_tri = 0;
    while top > 0 {
        top -= 1;
        let nd = node(s, stack[top].assume_init());
        let near = entries[top].assume_init();
        if nd.count == 0 || !near.is_finite() || near > best {
            continue;
        }
        if nd.left >= 0 {
            if top + 2 > 64 {
                return Hit {
                    t: 0.0,
                    enters: false,
                    valid: false,
                };
            }
            let l = nd.left as usize;
            let r = nd.right as usize;
            let a = ray_entry(node(s, l), o, d, from, best);
            let b = ray_entry(node(s, r), o, d, from, best);
            let (far, ft, close, ct) = if a < b { (r, b, l, a) } else { (l, a, r, b) };
            if ft.is_finite() {
                stack[top].write(far);
                entries[top].write(ft);
                top += 1
            }
            if ct.is_finite() {
                stack[top].write(close);
                entries[top].write(ct);
                top += 1
            }
            continue;
        }
        for j in nd.first..nd.first + nd.count {
            let i = j as usize;
            let e1 = [
                coefficient(s, i, 0),
                coefficient(s, i, 1),
                coefficient(s, i, 2),
            ];
            let e2 = [
                coefficient(s, i, 3),
                coefficient(s, i, 4),
                coefficient(s, i, 5),
            ];
            let q = [
                d[1] * e2[2] - d[2] * e2[1],
                d[2] * e2[0] - d[0] * e2[2],
                d[0] * e2[1] - d[1] * e2[0],
            ];
            let det = dot(e1, q);
            if det.abs() < 1e-9 {
                continue;
            }
            let inv = 1.0 / det;
            let v = sub(o, [vertex(s, i, 0), vertex(s, i, 1), vertex(s, i, 2)]);
            let u = dot(v, q) * inv;
            if u < 0.0 || u > 1.0 {
                continue;
            }
            let cross = [
                v[1] * e1[2] - v[2] * e1[1],
                v[2] * e1[0] - v[0] * e1[2],
                v[0] * e1[1] - v[1] * e1[0],
            ];
            let w = dot(d, cross) * inv;
            if w < 0.0 || u + w > 1.0 {
                continue;
            }
            let t = dot(e2, cross) * inv;
            if t > from
                && (t < best
                    || t == best
                        && (!found
                            || nd.first < best_leaf
                            || nd.first == best_leaf && j > best_tri))
            {
                best = t;
                found = true;
                best_leaf = nd.first;
                best_tri = j;
                enters = det > 0.0 || *((s.sides as *const u8).add(i)) == 1;
            }
        }
    }
    Hit {
        t: if found { best } else { INF },
        enters,
        valid: true,
    }
}
fn box_distance(p: [f64; 3], n: Node) -> f64 {
    let mut sum = 0.0;
    for k in 0..3 {
        let v = (n.min[k] - p[k]).max(0.0).max(p[k] - n.max[k]);
        sum += v * v
    }
    sum
}
unsafe fn touching(s: &Shape, o: [f64; 3], d: [f64; 3], from: f64, to: f64, tol: f64) -> bool {
    if !from.is_finite() || !to.is_finite() || tol <= 0.0 || to < from {
        return false;
    }
    let speed = dot(d, d);
    if speed <= 1e-24 || node(s, 0).count == 0 {
        return false;
    }
    let tol2 = tol * tol;
    let mut pending = [MaybeUninit::<[f64; 3]>::uninit(); 129];
    pending[0].write([from, to, 0.0]);
    let mut count = 1;
    let mut intervals = 0;
    let mut visits = 0;
    let mut triangles = 0;
    while count > 0 {
        intervals += 1;
        if intervals > 128 {
            return false;
        }
        count -= 1;
        let [lo, hi, depth] = pending[count].assume_init();
        let mid = (lo + hi) / 2.0;
        let point = |t: f64| [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
        let p = point(mid);
        let start = point(lo);
        let end = point(hi);
        // Every pushed slot is written before pop; unused capacity needs no zero-fill.
        let mut stack = [MaybeUninit::<usize>::uninit(); 64];
        stack[0].write(0);
        let mut top = 1;
        let mut certified = false;
        let mut near = false;
        while top > 0 && !certified {
            visits += 1;
            if visits > 8192 {
                return false;
            }
            top -= 1;
            let nd = node(s, stack[top].assume_init());
            if nd.count == 0 || box_distance(p, nd) > tol2 {
                continue;
            }
            if nd.left >= 0 {
                if top + 2 > 64 {
                    return false;
                }
                stack[top].write(nd.left as usize);
                stack[top + 1].write(nd.right as usize);
                top += 2;
                continue;
            }
            for j in nd.first..nd.first + nd.count {
                triangles += 1;
                if triangles > 32768 {
                    return false;
                }
                let i = j as usize;
                let normal = [
                    coefficient(s, i, 6),
                    coefficient(s, i, 7),
                    coefficient(s, i, 8),
                ];
                let n2 = coefficient(s, i, 9);
                let tangent = dot(normal, d);
                if n2 < 1e-24 || tangent * tangent > 1e-4 * n2 * speed {
                    continue;
                }
                if tri_sq(s, i, p) > tol2 {
                    continue;
                }
                near = true;
                if tri_sq(s, i, start) <= tol2 && tri_sq(s, i, end) <= tol2 {
                    certified = true;
                    break;
                }
            }
        }
        if certified {
            continue;
        }
        if !near || depth >= 12.0 || hi - lo < 1e-7 {
            return false;
        }
        if count + 2 > 129 {
            return false;
        }
        pending[count].write([lo, mid, depth + 1.0]);
        pending[count + 1].write([mid, hi, depth + 1.0]);
        count += 2;
    }
    true
}
unsafe fn passes(s: &Shape, o: [f64; 3], d: [f64; 3], from: f64, to: f64, tol: f64) -> bool {
    let mut cursor = from;
    for _ in 0..64 {
        if cursor >= to {
            return false;
        }
        let hit = nearest(s, o, d, cursor, to);
        if !hit.valid {
            return true;
        }
        if !hit.t.is_finite() {
            let ahead = nearest(s, o, d, cursor, INF);
            return !ahead.valid
                || ahead.t.is_finite() && !ahead.enters && !touching(s, o, d, cursor, to, tol);
        }
        if !hit.enters {
            if hit.t - cursor > 0.8 && !touching(s, o, d, cursor, hit.t, tol) {
                return true;
            }
            cursor = hit.t + 1e-4;
            continue;
        }
        let out = nearest(s, o, d, hit.t + 1e-4, to);
        if !out.valid {
            return true;
        }
        let end = if out.t.is_finite() { out.t } else { to };
        if end - hit.t > 0.8 && !touching(s, o, d, hit.t, end, tol) {
            return true;
        }
        if !out.t.is_finite() {
            return false;
        }
        cursor = out.t + 1e-4;
    }
    cursor < to
}
#[no_mangle]
pub unsafe extern "C" fn sweep_hits(
    from_ptr: u32,
    into_ptr: u32,
    args_ptr: u32,
    limit: u32,
    hint: i32,
) -> u32 {
    let from = &*(from_ptr as *const Shape);
    let into = &*(into_ptr as *const Shape);
    let args = std::slice::from_raw_parts(args_ptr as *const f64, 37);
    let m = &args[..16];
    let w = &args[16..32];
    let d = &args[32..35];
    let max_t = args[35];
    let tol = args[36];
    let dl = [
        w[0] * d[0] + w[4] * d[1] + w[8] * d[2],
        w[1] * d[0] + w[5] * d[1] + w[9] * d[2],
        w[2] * d[0] + w[6] * d[1] + w[10] * d[2],
    ];
    // Signal unsupported numeric overflow to the JS adapter, which re-runs
    // the original checker. Never turn invalid coordinates into a clear path.
    if !dl.iter().all(|v| v.is_finite()) {
        return from.point_count + 1;
    }
    let mut hits = 0;
    LAST_PROBE = -1;
    for sample in 0..from.point_count as usize {
        let slot = if hint < 0 {
            sample
        } else if sample == 0 {
            hint as usize
        } else if sample <= hint as usize {
            sample - 1
        } else {
            sample
        };
        let p = std::slice::from_raw_parts((from.points as *const f32).add(slot * 3), 3);
        let o = [
            m[0] * p[0] as f64 + m[4] * p[1] as f64 + m[8] * p[2] as f64 + m[12],
            m[1] * p[0] as f64 + m[5] * p[1] as f64 + m[9] * p[2] as f64 + m[13],
            m[2] * p[0] as f64 + m[6] * p[1] as f64 + m[10] * p[2] as f64 + m[14],
        ];
        if !o.iter().all(|v| v.is_finite()) {
            return from.point_count + 1;
        }
        if !ray_entry(node(into, 0), o, dl, 0.0, max_t).is_finite() {
            continue;
        }
        if passes(
            into,
            o,
            dl,
            if max_t <= 0.3 { 0.0 } else { 0.3 },
            max_t,
            tol,
        ) {
            hits += 1;
            if hits > limit {
                LAST_PROBE = slot as i32;
                return hits;
            }
        }
    }
    hits
}
