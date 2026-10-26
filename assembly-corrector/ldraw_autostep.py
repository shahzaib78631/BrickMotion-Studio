#!/usr/bin/env python3
"""
ldraw_autostep.py - automatic build-step generator for LDraw models (.mpd / .ldr)

Reads a model, works out which parts physically connect (LDCad shadow / snap data, with a geometric
fallback where snap data is missing), and rewrites the file with parts in a logical bottom-up
assembly order separated by "0 STEP" lines.  Part lines are never modified, only re-ordered.

Requires: python 3.8+, numpy.   LDraw + shadow libraries are auto-downloaded (needed files only).
"""
import argparse, heapq, json, os, re, sys, tempfile, urllib.request, urllib.error
from collections import Counter, OrderedDict
import numpy as np
"""(section) LDraw part library + LDCad shadow library access."""

LDRAW_MIRROR = "https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/"
SHADOW_MIRROR = "https://raw.githubusercontent.com/RolandMelkert/LDCadShadowLibrary/master/"

def norm(name):
    return name.strip().lower().replace('\\', '/')


def safe_library_name(name):
    """Reject absolute/traversing paths from untrusted LDraw reference names.

    MPD-local names need not satisfy this rule: they are looked up in ``extra``
    and never used as paths.  External library names must stay below their root.
    """
    n = norm(name)
    return bool(n and not n.startswith('/') and not re.match(r'^[a-z]:', n)
                and all(p not in ('', '.', '..') for p in n.split('/'))
                and not any(ord(c) < 32 for c in n))

class Library:
    def __init__(self, ldraw_dir=None, shadow_dir=None, cache_dir=None, offline=False):
        self.ldraw_dir, self.shadow_dir = ldraw_dir, shadow_dir
        self.cache = cache_dir or os.path.join(os.path.expanduser('~'), '.cache', 'ldraw_autostep')
        self.offline = offline
        self._ld, self._sh = {}, {}
        self._geo = {}
        # Parse each LDraw file once.  Unlike vertices(), bounds() never expands
        # repeated subparts into one potentially enormous vertex array.
        self._geometry_nodes = {}
        self._bounds_cache = OrderedDict()
        self._details_cache = {}
        self.bounds_cache_limit = 4096
        self.geometry_stats = {'parsed_files': 0, 'bounds_evaluations': 0,
                               'bounds_cache_hits': 0, 'bounds_cache_evictions': 0}
        self.extra = {}      # model-local sub-files (name -> text)

    # ---- raw text access -------------------------------------------------
    def _search(self, kind, name):
        n = norm(name)
        if not safe_library_name(n):
            return None
        if kind == 'ld':
            sub = ['parts/', 'parts/s/', 'p/', 'p/48/', 'p/8/']
            if n.startswith('s/'): sub = ['parts/']
            if n.startswith(('48/', '8/')): sub = ['p/']
            roots = [self.ldraw_dir] if self.ldraw_dir else []
            mirror, cache = LDRAW_MIRROR, os.path.join(self.cache, 'ldraw')
        else:
            sub = ['parts/', 'p/']
            roots = [self.shadow_dir] if self.shadow_dir else []
            mirror, cache = SHADOW_MIRROR, os.path.join(self.cache, 'shadow')
        for root in roots + [cache]:
            for d in sub:
                p = os.path.join(root, d, n)
                if os.path.isfile(p):
                    with open(p, encoding='utf-8', errors='replace') as f:
                        return f.read()
        if self.offline: return None
        for d in sub:
            if kind == 'sh' and n.startswith('s/') and d == 'p/': continue
            try:
                data = urllib.request.urlopen(mirror + d + n, timeout=30).read().decode('utf8', 'ignore')
            except (urllib.error.URLError, OSError):
                continue
            p = os.path.join(cache, d, n); os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'w', encoding='utf-8') as f:
                f.write(data)
            return data
        return None

    def ldraw(self, name):
        n = norm(name)
        if n in self.extra: return self.extra[n]
        if n not in self._ld: self._ld[n] = self._search('ld', n)
        return self._ld[n]

    def shadow(self, name):
        n = norm(name)
        if n not in self._sh: self._sh[n] = self._search('sh', n)
        return self._sh[n]

    # ---- geometry --------------------------------------------------------
    def vertices(self, name):
        """Legacy vertex expansion API; the planner uses bounds() instead."""
        n = norm(name)
        if n in self._geo: return self._geo[n]
        self._geo[n] = np.zeros((0, 3))          # recursion guard
        t = self.ldraw(n); out = []
        for l in (t or '').splitlines():
            p = l.split()
            if not p: continue
            if p[0] in ('2', '3', '4', '5'):
                # For type 5, only the two endpoints are actual geometry;
                # the other two vertices control visibility of the edge.
                k = {'2': 6, '3': 9, '4': 12, '5': 6}[p[0]]
                if len(p) >= 2 + k:
                    try:
                        out.append(np.array(list(map(float, p[2:2 + k]))).reshape(-1, 3))
                    except ValueError:
                        pass
            elif p[0] == '1' and len(p) >= 15:
                v = list(map(float, p[2:14])); M = np.array(v[3:]).reshape(3, 3)
                sv = self.vertices(' '.join(p[14:]))
                if len(sv): out.append(sv @ M.T + np.array(v[:3]))
        self._geo[n] = np.vstack(out) if out else np.zeros((0, 3))
        return self._geo[n]

    def _geometry_node(self, name):
        """Cache unexpanded primitive vertices and child transformations."""
        name = norm(name)
        if name in self._geometry_nodes:
            return self._geometry_nodes[name]
        txt = self.ldraw(name)
        if txt is None:
            self._geometry_nodes[name] = None
            return None
        vertices, children, invalid = [], [], []
        for line_no, line in enumerate(txt.splitlines(), 1):
            p = line.split()
            if not p:
                continue
            typ = p[0]
            if typ in ('2', '3', '4', '5'):
                # Type-5 control points are not part of the visible geometry.
                count = {'2': 6, '3': 9, '4': 12, '5': 6}[typ]
                try:
                    if len(p) < 2 + count:
                        raise ValueError('too few coordinates')
                    coords = np.asarray([float(x) for x in p[2:2 + count]], dtype=float)
                    if not np.isfinite(coords).all():
                        raise ValueError('non-finite coordinate')
                    vertices.extend(coords.reshape(-1, 3))
                except ValueError as exc:
                    invalid.append({'line': line_no, 'reason': str(exc)})
            elif typ == '1':
                try:
                    if len(p) < 15:
                        raise ValueError('incomplete reference')
                    vals = np.array([float(x) for x in p[2:14]], dtype=float)
                    if not np.isfinite(vals).all():
                        raise ValueError('non-finite transformation')
                    children.append((norm(' '.join(p[14:])), vals[3:].reshape(3, 3), vals[:3]))
                except ValueError as exc:
                    invalid.append({'line': line_no, 'reason': str(exc)})
        node = {'vertices': np.asarray(vertices, dtype=float).reshape(-1, 3),
                'children': children, 'invalid': invalid}
        self._geometry_nodes[name] = node
        self.geometry_stats['parsed_files'] += 1
        return node

    def _rotated_bounds(self, name, matrix, active):
        """Exact AABB for a part under a linear transform, without vertex expansion.

        Child translations are accumulated separately; reusing the same part at
        different positions with the same orientation hits the same cached bounds.
        """
        name = norm(name)
        if name in active:
            return None  # cyclic subfile; explain_geometry() reports its path
        key = (name, matrix.tobytes())
        if key in self._bounds_cache:
            self.geometry_stats['bounds_cache_hits'] += 1
            self._bounds_cache.move_to_end(key)
            return self._bounds_cache[key]
        node = self._geometry_node(name)
        self.geometry_stats['bounds_evaluations'] += 1
        lo = hi = None
        if node is not None:
            points = node['vertices']
            if len(points):
                transformed = points @ matrix.T
                lo, hi = transformed.min(axis=0), transformed.max(axis=0)
            for child_name, child_matrix, child_offset in node['children']:
                bb = self._rotated_bounds(child_name, matrix @ child_matrix, active + (name,))
                if bb is not None:
                    offset = matrix @ child_offset
                    cmin, cmax = bb[0] + offset, bb[1] + offset
                    lo = cmin if lo is None else np.minimum(lo, cmin)
                    hi = cmax if hi is None else np.maximum(hi, cmax)
        result = (lo, hi) if lo is not None else None
        self._bounds_cache[key] = result
        if len(self._bounds_cache) > self.bounds_cache_limit:
            self._bounds_cache.popitem(last=False)
            self.geometry_stats['bounds_cache_evictions'] += 1
        return result

    def bounds(self, name, matrix=None, offset=None):
        """Return exact transformed min/max of LDraw vertices, or None.

        AABB is still an *approximate solid* for contact/insertion checks, but
        the bounding extrema themselves are exact for the supplied LDraw lines.
        """
        mat = np.eye(3) if matrix is None else np.asarray(matrix, dtype=float)
        bb = self._rotated_bounds(name, mat, ())
        if bb is None:
            return None
        pos = np.zeros(3) if offset is None else np.asarray(offset, dtype=float)
        return bb[0] + pos, bb[1] + pos

    def explain_geometry(self, name):
        """Report missing descendants, malformed lines and cyclic references."""
        name = norm(name)
        if name in self._details_cache:
            return self._details_cache[name]
        issues, seen = [], set()
        def visit(current, path):
            if current in path:
                issues.append({'code': 'geometry_cycle', 'path': list(path) + [current]})
                return
            if current in seen:
                return
            seen.add(current)
            node = self._geometry_node(current)
            if node is None:
                issues.append({'code': 'missing_subpart' if path else 'missing_part',
                               'path': list(path) + [current]})
                return
            for bad in node['invalid']:
                issues.append({'code': 'invalid_geometry_line', 'path': list(path) + [current],
                               'line': bad['line'], 'reason': bad['reason']})
            for child_name, _, _ in node['children']:
                visit(child_name, path + (current,))
        visit(name, ())
        result = {'part': name, 'issues': issues, 'files_visited': len(seen)}
        self._details_cache[name] = result
        return result


"""(section) Extract LDCad snap connectors (SNAP_CYL / CLP / FGR / INCL) with LDCad-style inheritance."""
from dataclasses import dataclass

PROP = re.compile(r'\[(\w+)=([^\]]*)\]')

@dataclass
class Conn:
    kind: str            # CYL / CLP / FGR
    gender: str          # M / F
    pos: np.ndarray      # start of the cylinder
    axis: np.ndarray     # unit vector the sections extend along
    length: float        # total length along axis (from pos)
    radius: float        # first/main section radius
    shape: str           # R round, A axle, S square ...
    slide: bool
    caps: str
    center: bool = False
    rot: bool = False    # turns freely (round pin / bush) -> articulated joint
    def seg(self):
        # LDCad convention (calibrated on studs/anti-studs): sections extend from pos along -axis
        base = self.pos + (self.axis * self.length / 2 if self.center else 0)
        return base, base - self.axis * self.length

def _vec(s, n):
    v = [float(x) for x in s.split()]
    return v if len(v) == n else None

def _mat(s):
    v = _vec(s, 9) if s else None
    return np.array(v).reshape(3, 3) if v else np.eye(3)

def _grid(s):
    """grid=[C] xcnt [C] zcnt xstep zstep -> list of (x,z) offsets, or [(0,0)]."""
    if not s: return [(0.0, 0.0)]
    t = s.split(); k = 0
    try:
        def cnt():
            nonlocal k
            c = False
            if t[k].upper() == 'C': c = True; k += 1
            n = int(float(t[k])); k += 1
            return n, c
        xn, xc = cnt(); zn, zc = cnt()
        rest = [float(x) for x in t[k:]]
        xs, zs = (rest[0], rest[1]) if len(rest) >= 2 else (20.0, 20.0)
    except (ValueError, IndexError):
        return [(0.0, 0.0)]
    xo = (xn - 1) / 2 if xc else 0; zo = (zn - 1) / 2 if zc else 0
    return [((i - xo) * xs, (j - zo) * zs) for i in range(xn) for j in range(zn)]

def _make(kind, props, M=np.eye(3), t=np.zeros(3)):
    """Build connectors from one meta line, already transformed by (M,t)."""
    g = props.get('gender', 'M').upper()[:1]
    pos = np.array(_vec(props.get('pos', '0 0 0'), 3) or [0, 0, 0])
    ori = _mat(props.get('ori'))
    if kind == 'CYL':
        secs = props.get('secs', '').split(); sec = []
        for i in range(0, len(secs) - 2, 3):
            try: sec.append((secs[i], float(secs[i + 1]), float(secs[i + 2])))
            except ValueError: pass
        if not sec: return []
        length = sum(s[2] for s in sec)
        # use the smallest radius of the longest section as the "mating" radius
        ls = max(sec, key=lambda s: s[2]); shape, radius = ls[0], ls[1]
    else:                                 # CLP / FGR
        try: radius = float(props.get('radius', 4)); length = float(props.get('length', 4))
        except ValueError: return []
        shape = 'R'
    center = props.get('center', 'false').lower() == 'true'
    slide = props.get('slide', 'false').lower() == 'true'
    out = []
    ax_local = ori @ np.array([0, 1.0, 0])
    for gx, gz in _grid(props.get('grid')):
        p_local = pos + ori @ np.array([gx, 0, gz])
        ax = M @ ax_local
        sa = np.linalg.norm(ax)
        lat = np.sqrt(abs(np.linalg.norm(M @ (ori @ [1.0, 0, 0])) * np.linalg.norm(M @ (ori @ [0, 0, 1.0]))))
        out.append(Conn(kind, g, M @ p_local + t, ax / sa if sa else ax, length * sa, radius * lat, shape,
                        slide, props.get('caps', 'one').lower(), center,
                        rot=(shape == 'R' and slide)))
    return out


def transform_conn(c, M, t):
    """Apply an affine LDraw placement, including connector length/width scaling."""
    ax = M @ c.axis
    scale_ax = np.linalg.norm(ax)
    if not scale_ax:
        return None
    u1, u2 = _perp(c.axis)
    scale_radial = np.sqrt(abs(np.linalg.norm(M @ u1) * np.linalg.norm(M @ u2)))
    return Conn(c.kind, c.gender, M @ c.pos + t, ax / scale_ax,
                c.length * scale_ax, c.radius * scale_radial,
                c.shape, c.slide, c.caps, c.center, c.rot)

class SnapDB:
    def __init__(self, lib):
        self.lib = lib; self.cache = {}; self.has_shadow = {}

    def of(self, name):
        n = norm(name)
        if n in self.cache: return self.cache[n]
        self.cache[n] = []                       # recursion guard
        res = []
        sh = self.lib.shadow(n)
        if sh:
            self.has_shadow[n] = True
            for l in sh.splitlines():
                p = l.split(None, 3)
                if len(p) >= 3 and p[0] == '0' and p[1].upper() in ('!LDCAD', '!LDCAD_'):  # 0 !LDCAD SNAP_XXX [..]
                    parts = l.split(None, 3)
                    kind = parts[2].upper()
                    props = {k.lower(): v for k, v in PROP.findall(l)}
                    if kind in ('SNAP_CYL', 'SNAP_CLP', 'SNAP_FGR'):
                        res += _make(kind[5:], props)
                    elif kind == 'SNAP_INCL' and 'ref' in props:
                        M = _mat(props.get('ori')) @ np.diag(_vec(props['scale'], 3) or [1, 1, 1]) if 'scale' in props else _mat(props.get('ori'))
                        t = np.array(_vec(props.get('pos', '0 0 0'), 3) or [0, 0, 0])
                        for gx, gz in _grid(props.get('grid')):
                            off = _mat(props.get('ori')) @ np.array([gx, 0, gz])
                            for c in self.of(props['ref']):
                                transformed = transform_conn(c, M, t + off)
                                if transformed is not None:
                                    res.append(transformed)
        txt = self.lib.ldraw(n)
        for src in (txt, sh):
            for l in (src or '').splitlines():
                p = l.split()
                if len(p) >= 15 and p[0] == '1':
                    v = list(map(float, p[2:14])); M = np.array(v[3:]).reshape(3, 3); t = np.array(v[:3])
                    for c in self.of(' '.join(p[14:])):
                        transformed = transform_conn(c, M, t)
                        if transformed is not None:
                            res.append(transformed)
        self.cache[n] = res
        return res

def _unit(v):
    n = np.linalg.norm(v); return v / n if n else v

def _perp(a):
    a = _unit(a); h = np.array([1.0, 0, 0]) if abs(a[0]) < .9 else np.array([0, 1.0, 0])
    u = _unit(np.cross(a, h)); return u, np.cross(a, u)


# =====================================================================
# (section) Model reading
# =====================================================================
def split_models(text):
    # splitlines understands LF, CRLF, CR and mixed-newline input, unlike
    # splitting on one chosen delimiter.  Retain the terminal newline too.
    crlf = text.count('\r\n')
    lf = text.count('\n') - crlf
    cr = text.count('\r') - crlf
    eol = max(((crlf, '\r\n'), (lf, '\n'), (cr, '\r')), key=lambda p: p[0])[1]
    lines = text.splitlines()
    if text.endswith(('\n', '\r')):
        lines.append('')
    if not lines:
        lines = ['']
    models, cur = [], None
    for line_no, l in enumerate(lines, 1):
        if l.upper().startswith('0 FILE '):
            cur = {'name': l[7:].strip(), 'lines': [], 'start_line': line_no}; models.append(cur)
        if cur is None:
            cur = {'name': 'main', 'lines': [], 'start_line': line_no}; models.append(cur)
        cur['lines'].append(l)
    return eol, models


def read_units(model, local_names, lib, db, use_shadow=True, load_geometry=True):
    """Split a model into header lines, build units and trailer lines."""
    hdr, us, pending = [], [], []
    ls = model['lines']; k = 0; dropped = 0
    while k < len(ls):
        l = ls[k]; p = l.split()
        if re.match(r'^\s*0\s+(?:STEP|ROTSTEP)\b', l, re.I):
            dropped += 1
        elif p and p[0] == '1' and len(p) >= 15:
            name = ' '.join(p[14:])
            try:
                v = np.asarray([float(value) for value in p[2:14]], dtype=float)
                if not np.isfinite(v).all():
                    raise ValueError('non-finite position or orientation')
            except ValueError as exc:
                raise ValueError('%s (source line %d): invalid transform for %s: %s' % (
                    model['name'], model.get('start_line', 1) + k, name, exc)) from exc
            M = np.array(v[3:]).reshape(3, 3); t = np.array(v[:3])
            bounds = lib.bounds(name, M, t) if load_geometry else None
            bb = bounds if bounds is not None else (t - 1, t + 1)
            u = {'lines': pending + [l], 'kind': 'ref' if norm(name) in local_names else 'part',
                 'order': len(us), 'source_line': model.get('start_line', 1) + k,
                 'part': name, 'color': p[1], 'bb': bb, 'M': M, 't': t}
            details = lib.explain_geometry(name) if load_geometry and u['kind'] == 'part' else {'issues': []}
            u['geometry_issues'] = details['issues']
            u['missing_geometry'] = load_geometry and u['kind'] == 'part' and (
                bounds is None or bool(details['issues']))
            # A local-space bounding volume supplies an optional narrow-phase
            # rejection test for rotated parts whose world AABBs intersect.
            u['local_bb'] = (lib.bounds(name) if load_geometry and bounds is not None and
                             not details['issues'] else None)
            u['wconns'] = world_conns(db, name, M, t) if (load_geometry and use_shadow and u['kind'] == 'part') else []
            u['shadow_file_present'] = bool(db.has_shadow.get(norm(name), False)) if use_shadow else False
            pending = []; us.append(u)
        elif l.startswith('0 SYNTH BEGIN'):
            blk = [l]; k += 1
            while k < len(ls) and not ls[k].startswith('0 SYNTH END'):
                blk.append(ls[k]); k += 1
            if k < len(ls): blk.append(ls[k])
            pts = []
            for x in blk:
                q = x.split()
                if q and q[0] == '1' and len(q) >= 15:
                    vv = list(map(float, q[2:14])); Mx = np.array(vv[3:]).reshape(3, 3)
                    bbx = lib.bounds(' '.join(q[14:]), Mx, np.array(vv[:3])) if load_geometry else None
                    if bbx is not None: pts.extend(bbx)
            if pts:
                a = np.asarray(pts); bb = (a.min(0), a.max(0))
            else:
                bb = (np.zeros(3), np.zeros(3))
            us.append({'lines': pending + blk, 'kind': 'synth', 'order': len(us),
                       'source_line': model.get('start_line', 1) + k + 1 - len(blk),
                       'part': 'SYNTH', 'color': '7',
                       'bb': bb, 'M': np.eye(3), 't': np.zeros(3), 'wconns': []})
            pending = []
        elif not us:
            hdr.append(l)
        else:
            # Keep model-local comments and meta commands with the following
            # placement, rather than moving them to the end of the file. This
            # is essential for BFC INVERTNEXT, MLCad and similar directives.
            pending.append(l)
        k += 1
    return hdr, us, pending, dropped


def world_conns(db, name, M, t):
    out = []
    for c in db.of(name):
        transformed = transform_conn(c, M, t)
        if transformed is not None:
            out.append(transformed)
    return out


# =====================================================================
# (section) Connection analysis
# =====================================================================
TOL = 0.6


def spatial_pairs(a_min, a_max, b_min, b_max, padding=0.0, axes=(0, 1, 2)):
    """Yield potentially overlapping boxes from two sets using sweep-and-prune.

    No all-pairs tensor is built. The sweep axis is selected for greatest
    normalized spatial spread (rather than always assuming the X axis).
    Boxes are expanded by ``padding`` in the intersection test; exact tests
    are performed by the caller on only these candidate pairs.
    """
    if not len(a_min) or not len(b_min):
        return
    dimensions = np.asarray(axes, dtype=int)
    centers = np.concatenate(((a_min + a_max) / 2, (b_min + b_max) / 2))
    sizes = np.concatenate((a_max - a_min, b_max - b_min))
    spread = np.ptp(centers[:, dimensions], axis=0)
    typical = np.median(np.maximum(sizes[:, dimensions], 1.0), axis=0)
    axis = int(dimensions[int(np.argmax(spread / typical))])
    aa = np.argsort(a_min[:, axis], kind='stable')
    bb = np.argsort(b_min[:, axis], kind='stable')
    active, expiry, next_b = set(), [], 0
    for i in aa:
        # Newly considered A boxes need not have monotonically increasing
        # max bounds. Retain the start-bound check below for correctness.
        while next_b < len(bb) and b_min[bb[next_b], axis] <= a_max[i, axis] + padding:
            j = int(bb[next_b]); next_b += 1
            active.add(j)
            heapq.heappush(expiry, (b_max[j, axis], j))
        while expiry and expiry[0][0] < a_min[i, axis] - padding:
            active.discard(heapq.heappop(expiry)[1])
        if not active:
            continue
        inds = np.fromiter(active, dtype=int)
        keep = np.all((b_min[inds] <= a_max[i] + padding) &
                      (b_max[inds] >= a_min[i] - padding), axis=1)
        for j in inds[keep]:
            yield int(i), int(j)


class Analysis:
    """Pairwise relations between units: attachment (snap or contact), rigidity, insertion axes, support."""
    def __init__(self, units, use_shadow=True, contact_mode='obb'):
        self.u = units; n = self.n = len(units)
        if contact_mode not in ('aabb', 'obb'):
            raise ValueError('contact_mode must be aabb or obb')
        self.contact_mode = contact_mode
        self.mn = np.array([u['bb'][0] for u in units]); self.mx = np.array([u['bb'][1] for u in units])
        self.obb_rejections = 0
        self.obb = []
        for u in units:
            local = u.get('local_bb')
            if local is None:
                self.obb.append(None); continue
            matrix, pos = u['M'], u['t']
            center = pos + matrix @ ((local[0] + local[1]) / 2)
            half = matrix @ np.diag((local[1] - local[0]) / 2)
            # For axis-permuted / axis-aligned LDraw placements world AABBs
            # already test the bounding parallelepiped exactly.
            rotated = bool(np.any((np.abs(matrix) > 1e-8).sum(axis=1) > 1))
            self.obb.append((center, half, rotated))
        # Sparse candidate generation avoids the former N x N x 3 overlap
        # tensor. Dense boolean relations are retained for planner compatibility.
        self.contact = np.zeros((n, n), dtype=bool)
        self.rest = np.zeros((n, n), dtype=bool)  # rest[upper, lower]
        self.contact_pairs = []
        self.bbox_candidate_pairs = 0
        for i, j in spatial_pairs(self.mn, self.mx, self.mn, self.mx,
                                  padding=TOL, axes=(0, 2)):
            if i >= j:
                continue
            ov = self.overlap(i, j)
            self.bbox_candidate_pairs += 1
            if ov.min() >= -TOL and (ov > 0.5).sum() >= 2:
                if contact_mode == 'obb' and not self._obb_possible(i, j):
                    self.obb_rejections += 1
                else:
                    self.contact[i, j] = self.contact[j, i] = True
                    self.contact_pairs.append((i, j))
            if ov[0] > 0.5 and ov[2] > 0.5:
                dij = self.mx[i, 1] - self.mn[j, 1]
                dji = self.mx[j, 1] - self.mn[i, 1]
                self.rest[i, j] = -TOL <= dij <= 4.5
                self.rest[j, i] = -TOL <= dji <= 4.5
        self.attach = np.zeros((n, n), bool); self.rigid = np.zeros((n, n), bool)
        self.axes = {}                       # (i,j) -> list of unit vectors (motion axes)
        self.edge_evidence = {}              # (i,j), i<j -> why this attachment exists
        self.snap_pairs = 0; self.fallback_pairs = 0
        self.snap_possible_pairs = 0; self.snap_candidate_pairs = 0
        nM = np.array([sum(c.gender == 'M' for c in u['wconns']) for u in units])
        nF = np.array([sum(c.gender == 'F' for c in u['wconns']) for u in units])
        self.poor = (nM + nF == 0) | ((nM > 0) & (nF == 0))
        if use_shadow: self._snap_match()
        # geometric fallback: contact involving a part with missing/partial snap data
        for i, j in self.contact_pairs:
            if (self.poor[i] or self.poor[j]) and not self.attach[i, j]:
                self._fallback(i, j, 'contact')
        if not use_shadow:
            for i, j in self.contact_pairs:
                if not self.attach[i, j]:
                    self._fallback(i, j, 'contact')
        # Bridge disconnected attachment components with the minimum number
        # of contact links, using union-find rather than N repeated flood-fills.
        parent = list(range(n))
        def root(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]; x = parent[x]
            return x
        for i, j in zip(*np.nonzero(np.triu(self.attach, 1))):
            parent[root(i)] = root(j)
        for i, j in self.contact_pairs:
            if root(i) != root(j):
                self._fallback(i, j, 'component_bridge')
                parent[root(i)] = root(j)

    def _obb_possible(self, i, j):
        """Conservative separating-axis test for two transformed local boxes.

        A rejection is reliable, an overlap only a *possible* contact. Handles
        rotation, reflection and general affine parallelepipeds (including shear).
        Missing geometry disables rejection rather than inventing a solid.
        """
        a, b = self.obb[i], self.obb[j]
        if a is None or b is None or not (a[2] or b[2]):
            return True
        ca, ea, _ = a; cb, eb, _ = b
        axes = []
        for edges in (ea, eb):
            axes.extend((np.cross(edges[:, 1], edges[:, 2]),
                         np.cross(edges[:, 2], edges[:, 0]),
                         np.cross(edges[:, 0], edges[:, 1])))
        axes.extend(np.cross(ea[:, k], eb[:, l]) for k in range(3) for l in range(3))
        displacement = cb - ca
        for axis in axes:
            length = np.linalg.norm(axis)
            if length < 1e-10:
                continue
            axis = axis / length
            distance = abs(displacement @ axis)
            extent = np.abs(ea.T @ axis).sum() + np.abs(eb.T @ axis).sum()
            if distance > extent + TOL:
                return False
        return True

    def overlap(self, i, j):
        return np.minimum(self.mx[i], self.mx[j]) - np.maximum(self.mn[i], self.mn[j])

    def _fallback(self, i, j, source):
        ax = np.zeros(3); ax[int(np.argmin(np.abs(self.overlap(i, j))))] = 1
        self._link(i, j, [ax], rigid=True, source=source)
        self.fallback_pairs += 1

    def _link(self, i, j, axes, rigid, source='snap', matches=1):
        self.attach[i, j] = self.attach[j, i] = True
        if rigid: self.rigid[i, j] = self.rigid[j, i] = True
        self.axes.setdefault((i, j), []).extend(axes); self.axes.setdefault((j, i), []).extend(axes)
        key = (min(i, j), max(i, j))
        self.edge_evidence[key] = {'source': source, 'rigid': bool(rigid),
                                   'connector_matches': matches if source == 'snap' else 0}

    def _snap_match(self):
        P, A, E1, E2, R, G, U, S, SL, L = ([] for _ in range(10))
        for i, u in enumerate(self.u):
            for c in u['wconns']:
                a, b = c.seg(); P.append(c.pos); A.append(c.axis); E1.append(a); E2.append(b); R.append(c.radius)
                G.append(0 if c.gender == 'M' else 1); U.append(i); S.append(c.shape); SL.append(c.slide); L.append(c.length)
        if not P: return
        P, A, E1, E2, R, G, U, L = map(np.array, (P, A, E1, E2, R, G, U, L)); S = np.array(S); SL = np.array(SL)
        Mi = np.nonzero(G == 0)[0]; Fi = np.nonzero(G == 1)[0]
        if not len(Mi) or not len(Fi): return
        self.snap_possible_pairs = int(len(Mi) * len(Fi))
        mins, maxs = np.minimum(E1, E2), np.maximum(E1, E2)
        found = {}
        # A lateral distance <=1 means mating connector *segments* must have
        # overlapping AABBs with a 1-unit allowance. Unlike the former all-M
        # versus all-F matrix this skips connectors on distant model sections.
        for ai, bi in spatial_pairs(mins[Mi], maxs[Mi], mins[Fi], maxs[Fi], padding=1.05):
            m, f = int(Mi[ai]), int(Fi[bi])
            self.snap_candidate_pairs += 1
            if U[m] == U[f] or abs(A[m] @ A[f]) <= 0.98:
                continue
            if not R[m] <= R[f] + 0.5 or not R[f] - R[m] <= 1.3:
                continue
            ax = A[m]
            dv = P[f] - P[m]
            if np.linalg.norm(dv - (dv @ ax) * ax) > 1.0:
                continue
            tm = sorted((E1[m] @ ax, E2[m] @ ax)); tf = sorted((E1[f] @ ax, E2[f] @ ax))
            ovl = min(tm[1], tf[1]) - max(tm[0], tf[0])
            if ovl < 0.5 * min(L[m], L[f]) - 0.25 or ovl <= 0.5:
                continue
            rot = (S[m] == 'A' and S[f] == 'R') or (S[m] == 'R' and (SL[m] or SL[f]))
            i, j = int(U[m]), int(U[f])
            rec = found.setdefault((min(i, j), max(i, j)), [0, 0, []])
            rec[0] += 1; rec[1] += (0 if rot else 1); rec[2].append(ax)
        for (i, j), (cnt, rig, axs) in found.items():
            self._link(i, j, axs, rigid=rig > 0, source='snap', matches=cnt)
            self.snap_pairs += 1

    # ---- insertion feasibility ------------------------------------------------
    def _candidate_axes(self, i, neighbours):
        cands = []
        for j in neighbours:
            for a in self.axes.get((i, j), []):
                for sgn in (1, -1):
                    d = sgn * a
                    if not any(np.allclose(d, x, atol=0.05) for x in cands): cands.append(d)
        return cands

    def _insertion_check(self, i, placed, details=False):
        pl = np.nonzero(placed)[0]
        nb = [j for j in pl if self.attach[i, j]]
        if not nb:
            return None, []
        cands = self._candidate_axes(i, nb)
        lo = self.mn[i] + 1.0; hi = self.mx[i] - 1.0
        QL = self.mn[pl] + 1.0; QH = self.mx[pl] - 1.0
        # boxes that already interpenetrate the final pose are bounding-box artefacts (real solids can't overlap)
        inter = np.all((QL < hi) & (QH > lo), axis=1)
        attempts = []
        first_clear = None
        for d in cands:
            mated = np.array([any(abs(np.dot(a, d)) > 0.98 for a in self.axes.get((i, j), [])) if self.attach[i, j] else False for j in pl])
            near, far = lo - 5.0 * d, lo - 4000.0 * d
            nh, fh = hi - 5.0 * d, hi - 4000.0 * d
            slo = np.minimum(near, far); shi = np.maximum(nh, fh)
            hit = np.all((QL < shi) & (QH > slo), axis=1) & ~mated & ~inter
            if details:
                ids = pl[hit]
                attempts.append({'axis': [round(float(x), 4) for x in d],
                                 'clear': not bool(len(ids)),
                                 'blocker_count': int(len(ids)),
                                 'blocked_by': [int(j) for j in ids[:12]]})
            if not hit.any() and first_clear is None:
                first_clear = d
                if not details:
                    return d, []
        return first_clear, attempts

    def insertion(self, i, placed):
        """Find a collision-free insertion direction using conservative AABBs."""
        return self._insertion_check(i, placed)[0]

    def insertion_diagnostics(self, i, placed):
        """As insertion(), but explains tested directions and observed blockers."""
        direction, attempts = self._insertion_check(i, placed, details=True)
        return {'clear': direction is not None, 'attempts': attempts,
                'chosen_axis': ([round(float(x), 4) for x in direction]
                                if direction is not None else None)}

    def block_table(self):
        """For each unit i: list of (motion axis, bool[n] of units that would obstruct sliding i in along it)."""
        n = self.n; table = []
        skip = np.array([u['kind'] == 'synth' for u in self.u])
        for i in range(n):
            cands = self._candidate_axes(i, np.nonzero(self.attach[i])[0])
            lo = self.mn[i] + 1.0; hi = self.mx[i] - 1.0
            QL = self.mn + 1.0; QH = self.mx - 1.0
            inter = np.all((QL < hi) & (QH > lo), axis=1)
            entry = []
            for d in cands:
                mated = np.zeros(n, bool)
                for j in np.nonzero(self.attach[i])[0]:
                    if any(abs(np.dot(a, d)) > 0.98 for a in self.axes.get((i, int(j)), [])): mated[j] = True
                slo = np.minimum(lo - 5.0 * d, lo - 4000.0 * d); shi = np.maximum(hi - 5.0 * d, hi - 4000.0 * d)
                hit = np.all((QL < shi) & (QH > slo), axis=1) & ~mated & ~inter & ~skip
                hit[i] = False
                entry.append((d, hit))
            table.append(entry)
        return table

    def components(self, rigid_only=True):
        """Connected components over rigid attachments (articulated joints do not join)."""
        parent = list(range(self.n))
        def f(x):
            while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
            return x
        M = self.rigid if rigid_only else self.attach
        for i, j in zip(*np.nonzero(np.triu(M, 1))): parent[f(i)] = f(j)
        comp = {}
        for i in range(self.n): comp.setdefault(f(i), []).append(i)
        return list(comp.values())


# =====================================================================
# (section) Build-order planner
# =====================================================================
def plan_steps(units, an, max_step=8, foundation=0, notes=None, reasons=None):
    n = len(units); notes = notes if notes is not None else []
    reasons = reasons if reasons is not None else {}
    ymax = an.mx[:, 1]; ymin = an.mn[:, 1]
    ctr = (an.mn + an.mx) / 2; fold = ctr.copy(); fold[:, 0] = np.abs(fold[:, 0])
    synth = [i for i, u in enumerate(units) if u['kind'] == 'synth']
    parts = [i for i in range(n) if units[i]['kind'] != 'synth']
    if not parts: return [synth] if synth else []
    foundation = foundation if foundation in parts else parts[0]
    yf = ymax[foundation]
    placed = np.zeros(n, bool); remaining = set(parts)
    def sig(i): return (units[i]['part'], units[i]['color'])
    def group(i):
        if abs(ymax[i] - yf) <= 4.01: return 0
        return 1 if ymax[i] > yf else 2
    def under(i): return ymin[i] >= yf - 4.5 and ymax[i] > yf + 4
    def eligible(i): return bool((an.attach[i] & placed).any())
    def twin_of(i, cur):
        return any(sig(i) == sig(j) and abs(ctr[i, 0] + ctr[j, 0]) < 2 and abs(ctr[i, 0]) > 2 and
                   np.allclose(ctr[i, [1, 2]], ctr[j, [1, 2]], atol=2) for j in cur)
    def bonded(i, cur):
        # coincident centres + touching (e.g. wheel rim and tyre) belong in the same step
        return any(an.attach[i, j] and np.linalg.norm(ctr[i] - ctr[j]) < 2.0 for j in cur)
    def blocked(i):
        for L in np.nonzero(an.rest[i])[0]:
            if placed[L] or units[L]['kind'] == 'synth': continue
            if not under(L) and eligible(L): return True
        if under(i):
            for U in np.nonzero(an.rest[:, i])[0]:
                if placed[U] or units[U]['kind'] == 'synth': continue
                if eligible(U) and ymax[U] <= ymax[i]: return True
        return False
    def ok_insert(i):
        return an.insertion(i, placed) is not None
    table = an.block_table()
    blocks_by = {}                                    # X -> [(Y, axis index)] that X obstructs
    for y, entry in enumerate(table):
        for k, (d, hit) in enumerate(entry):
            for x in np.nonzero(hit)[0]: blocks_by.setdefault(int(x), []).append((y, k))
    bcnt = [[0] * len(e) for e in table]
    nearest_placed = np.full(n, np.inf)
    def mark(x, reason='connected'):
        placed[x] = True
        # Incremental nearest-neighbour distances avoid the former repeated
        # O(remaining * placed) Python loops for disconnected assemblies.
        np.minimum(nearest_placed, np.linalg.norm(fold - fold[x], axis=1),
                   out=nearest_placed)
        reasons[x] = reason
        for y, k in blocks_by.get(x, []): bcnt[y][k] += 1
    def harms(x):
        # would placing x permanently seal every insertion route of some still-unplaced part?
        for y in {y for y, _ in blocks_by.get(x, [])}:
            if placed[y] or y == x or not table[y]: continue
            if not any(c == 0 for c in bcnt[y]): continue
            if not any(c == 0 and not table[y][k][1][x] for k, c in enumerate(bcnt[y])): return True
        return False
    def key(i, last):
        g = group(i); sub = ymax[i] if g == 1 else (-ymax[i] if g == 2 else 0)
        return (g, round(sub, 1), round(np.linalg.norm(fold[i] - last) / 40), units[i]['order'])
    def companions(cur, seed):
        g = group(seed)
        while len(cur) < max_step + 1:
            cands = []
            for i in remaining:
                if i in cur: continue
                bd = bonded(i, cur)
                tw = twin_of(i, cur) or bd
                if not (eligible(i) or bd or (tw and bool((an.contact[i] & placed).any()))): continue
                if group(i) != g: continue
                if abs(ymax[i] - ymax[seed]) > (2.0 if g != 1 else 16.0): continue
                if blocked(i) and not tw: continue
                if eligible(i) and not tw and not ok_insert(i): continue
                if not tw and harms(i): continue
                dist = min(np.linalg.norm(fold[i] - fold[j]) for j in cur)
                if dist > 110 and not tw: continue
                same = any(sig(i) == sig(j) for j in cur)
                cands.append((0 if tw else 1, 0 if same else 1, dist, units[i]['order'], i, tw))
            if not cands: break
            cands.sort(); c = cands[0]
            if len(cur) >= max_step and not c[5]: break
            chosen = c[4]
            explanation = ('bonded_companion' if bonded(chosen, cur) else
                           'mirror_companion' if twin_of(chosen, cur) else
                           'connected_companion')
            cur.append(chosen); mark(chosen, explanation); remaining.discard(chosen)
        return cur
    steps = []
    mark(foundation, 'foundation'); remaining.discard(foundation)
    steps.append(companions([foundation], foundation))
    while remaining:
        last = np.mean([fold[i] for i in steps[-1]], 0)
        elig = [i for i in remaining if eligible(i)]
        ready = [i for i in elig if not blocked(i) and ok_insert(i)]
        mode = 'connected_insertion_verified'
        if not ready:
            ready = [i for i in elig if not blocked(i)]
            mode = 'insertion_unverified'
            if ready: notes.append('no collision-free insertion axis found for: ' + ', '.join(
                '%s (line %d)' % (units[i]['part'], units[i].get('source_line', units[i]['order'] + 1)) for i in ready[:3]))
        if not ready:
            ready = elig
            mode = 'support_order_unverified'
        if not ready:
            far = min(remaining, key=lambda i: nearest_placed[i])
            notes.append('unconnected part placed by proximity: %s (line %d)' % (
                units[far]['part'], units[far].get('source_line', units[far]['order'] + 1)))
            ready = [far]
            mode = 'unconnected_proximity_fallback'
        ordered = sorted(ready, key=lambda i: key(i, last))
        seed = next((i for i in ordered[:12] if not harms(i)), ordered[0])
        mark(seed, mode); remaining.discard(seed)
        steps.append(companions([seed], seed))
    # merge tiny steps into neighbours of the same layer band
    def band(st): return np.mean([ymax[i] for i in st])
    def can_merge(a, b):
        # Only a mirror/bonded companion may exceed the requested step size.
        # A synthesized hose must always remain in its own final step.
        if any(units[i]['kind'] == 'synth' for i in a + b):
            return False
        size = len(a) + len(b)
        return size <= max_step or (size == max_step + 1 and any(
            twin_of(i, a) or bonded(i, a) for i in b))
    changed = True
    while changed:
        changed = False
        for k in range(1, len(steps)):
            B, A = steps[k], steps[k - 1]
            if len(B) <= 2 and can_merge(A, B) and abs(band(A) - band(B)) <= 20:
                steps[k - 1] = A + B; del steps[k]; changed = True; break
        if changed: continue
        for k in range(1, len(steps) - 1):
            A, B = steps[k], steps[k + 1]
            if len(A) <= 2 and can_merge(A, B) and abs(band(A) - band(B)) <= 20:
                steps[k + 1] = A + B; del steps[k]; changed = True; break
    changed = True
    while changed:
        changed = False
        for k in range(len(steps)):
            if len(steps[k]) != 1: continue
            for nb in (k - 1, k + 1):
                if 0 <= nb < len(steps) and can_merge(steps[min(nb, k)], steps[max(nb, k)]) and abs(band(steps[nb]) - band(steps[k])) <= 48:
                    if nb == k - 1 and k == 0: continue
                    steps[nb] = steps[nb] + steps[k] if nb < k else steps[k] + steps[nb]
                    del steps[k]; changed = True; break
            if changed: break
    if synth: steps.append(synth)
    return steps


def verify(units, an, steps):
    """Independent checks. Returns (floating, placed_before_support)."""
    stepof = {i: k for k, s in enumerate(steps) for i in s}
    yf = an.mx[steps[0][0], 1]; ymin, ymax = an.mn[:, 1], an.mx[:, 1]
    first = steps[0][0]; floating, unsup = [], []
    for k, s in enumerate(steps):
        for i in s:
            if units[i]['kind'] == 'synth' or i == first: continue
            if not any((an.attach[i, j] or an.contact[i, j]) and stepof[j] <= k for j in range(an.n) if j != i): floating.append(i)
            for L in np.nonzero(an.rest[i])[0]:
                under = ymin[L] >= yf - 4.5 and ymax[L] > yf + 4
                if not under and units[L]['kind'] != 'synth' and stepof[L] > k: unsup.append((i, L))
    return floating, unsup


def repair(units, an, steps):
    for _ in range(10):
        f, u = verify(units, an, steps)
        if not u: break
        stepof = {i: k for k, s in enumerate(steps) for i in s}
        for i, L in u:
            k = stepof[i]
            if stepof[L] <= k: continue
            if any(an.attach[L, j] and stepof[j] <= k for j in range(an.n) if j != L):
                steps[stepof[L]].remove(L); steps[k].append(L); stepof[L] = k
        steps = [s for s in steps if s]
    return steps


# =====================================================================
# (section) Model processing, sub-assemblies, output
# =====================================================================
def make_sub_unit(members, units, name):
    mn = np.min([units[i]['bb'][0] for i in members], 0); mx = np.max([units[i]['bb'][1] for i in members], 0)
    return {'lines': ['1 16 0 0 0 1 0 0 0 1 0 0 0 1 ' + name], 'kind': 'sub', 'order': min(units[i]['order'] for i in members),
            'part': name, 'color': '16', 'bb': (mn, mx), 'M': np.eye(3), 't': np.zeros(3),
            'wconns': [c for i in members for c in units[i]['wconns']], 'members': [units[i] for i in members]}


def emit_steps(units, steps):
    out = []
    mx = np.array([u['bb'][1] for u in units])
    for s in steps:
        for i in sorted(s, key=lambda i: (i != steps[0][0] if s is steps[0] else False, -round(mx[i, 1]), units[i]['order'])):
            out += units[i]['lines']
        out.append('0 STEP')
    return out


def explain_plan(units, an, steps, reasons, floating, unsupported):
    """Produce an inspectable provenance trail for parts, links and steps.

    IDs are zero-based reference-unit indexes. Steps are one-based. Insertion
    paths are conservative bounding-box checks, not a proof of buildability.
    """
    stepof = {i: k + 1 for k, step in enumerate(steps) for i in step}
    geo = []
    for i, u in enumerate(units):
        mn, mx = u['bb']
        geo.append({'id': i, 'part': u['part'], 'kind': u['kind'],
                    'source_line': u.get('source_line'), 'original_index': u['order'],
                    'step': stepof.get(i), 'color': u['color'],
                    'bounds': {'min': [round(float(x), 3) for x in mn],
                               'max': [round(float(x), 3) for x in mx]},
                    'geometry_status': ('unavailable_or_partial' if u.get('missing_geometry') else
                                        'submodel_not_verified' if u['kind'] == 'ref' else 'resolved'),
                    'geometry_issues': u.get('geometry_issues', []),
                    'connector_count': len(u['wconns']),
                    'shadow_file_present': bool(u.get('shadow_file_present', False))})
    links = []
    for (i, j), evidence in sorted(an.edge_evidence.items()):
        links.append({'a': i, 'b': j, 'source': evidence['source'],
                      'rigid': evidence['rigid'],
                      'connector_matches': evidence['connector_matches'],
                      'aabb_overlap': [round(float(x), 3) for x in an.overlap(i, j)],
                      'confidence': 'higher' if evidence['source'] == 'snap' else 'low_aabb_heuristic'})
    placed = np.zeros(an.n, dtype=bool)
    step_details = []
    for k, step in enumerate(steps, 1):
        items = []
        # Match the emitted within-step order, while keeping step indices intact.
        order = sorted(step, key=lambda i: (
            i != steps[0][0] if k == 1 else False,
            -round(float(an.mx[i, 1])), units[i]['order']))
        for i in order:
            neighbors = [int(j) for j in np.nonzero(an.attach[i] & placed)[0]]
            same_step = [int(j) for j in step if j != i and an.attach[i, j]]
            supports = [int(j) for j in np.nonzero(an.rest[i] & placed)[0]]
            path = (an.insertion_diagnostics(i, placed) if neighbors else
                    {'clear': None, 'chosen_axis': None, 'attempts': []})
            items.append({'id': i, 'part': units[i]['part'],
                          'selection_reason': reasons.get(i, 'synthesized_hose' if units[i]['kind'] == 'synth' else 'planned'),
                          'connected_to_earlier': neighbors,
                          'connected_in_same_step': same_step,
                          'resting_on_earlier': supports,
                          'insertion': path})
            placed[i] = True
        step_details.append({'step': k, 'unit_ids': [int(i) for i in step], 'placements': items})
    issues = []
    for i, u in enumerate(units):
        for problem in u.get('geometry_issues', []):
            issues.append({'severity': 'error', 'code': problem['code'], 'unit': i,
                           'step': stepof.get(i), 'detail': problem,
                           'action': 'Supply or repair the named LDraw part / subpart file.'})
        if u.get('missing_geometry') and not u.get('geometry_issues'):
            issues.append({'severity': 'error', 'code': 'empty_geometry', 'unit': i,
                           'step': stepof.get(i),
                           'action': 'Inspect the part file and its nested references.'})
    for i in floating:
        issues.append({'severity': 'error', 'code': 'floating', 'unit': int(i),
                       'step': stepof.get(i),
                       'action': 'Check connectors, position and the chosen foundation.'})
    for i, j in unsupported:
        issues.append({'severity': 'error', 'code': 'placed_before_support',
                       'unit': int(i), 'support_unit': int(j), 'step': stepof.get(i),
                       'action': 'Review assembly order or geometry bounds.'})
    for i, why in sorted(reasons.items()):
        if why in ('insertion_unverified', 'support_order_unverified', 'unconnected_proximity_fallback'):
            issues.append({'severity': 'warning', 'code': why, 'unit': i, 'step': stepof.get(i),
                           'action': 'Review insertion attempts and connection provenance.'})
    return {'parts': geo, 'connections': links, 'steps_detail': step_details, 'issues': issues}


def explain_reference_assembly(units):
    """Describe a top-level assembly without loading referenced geometry."""
    parts, steps = [], []
    for i, u in enumerate(units):
        parts.append({'id': i, 'part': u['part'], 'kind': 'ref',
                      'source_line': u.get('source_line'), 'original_index': u['order'],
                      'step': i + 1, 'color': u['color'],
                      'bounds': None, 'geometry_status': 'submodel_not_verified',
                      'geometry_issues': [], 'connector_count': 0,
                      'shadow_file_present': False})
        steps.append({'step': i + 1, 'unit_ids': [i], 'placements': [
            {'id': i, 'part': u['part'], 'selection_reason': 'submodel_reference',
             'connected_to_earlier': [], 'connected_in_same_step': [],
             'resting_on_earlier': [],
             'insertion': {'clear': None, 'attempts': [], 'chosen_axis': None}}]})
    return {'parts': parts, 'connections': [], 'steps_detail': steps, 'issues': []}


def dot_graph(reports):
    """Render Graphviz DOT with snap/fallback provenance and step assignments."""
    lines = ['graph ldraw_autostep {',
             '  graph [fontname="Arial", overlap=false, splines=true];',
             '  node [shape=box, style=rounded, fontname="Arial", fontsize=10];']
    for index, res in enumerate(reports):
        if 'parts' not in res:
            continue
        lines.append('  subgraph cluster_%d {' % index)
        lines.append('    label=%s;' % json.dumps(res['name']))
        for p in res['parts']:
            node = 'm%d_p%d' % (index, p['id'])
            label = '#%d %s\\nstep %s' % (p['id'], p['part'], p['step'])
            color = '#c63737' if p['geometry_status'] == 'unavailable_or_partial' else '#506274'
            lines.append('    %s [label=%s, color=%s];' % (
                node, json.dumps(label), json.dumps(color)))
        for e in res['connections']:
            source = e['source']
            style = 'solid' if source == 'snap' else 'dashed' if source == 'component_bridge' else 'dotted'
            color = '#1676a5' if source == 'snap' else '#c58529'
            lines.append('    m%d_p%d -- m%d_p%d [label=%s, style=%s, color=%s];' % (
                index, e['a'], index, e['b'], json.dumps(source), style, json.dumps(color)))
        lines.append('  }')
    lines.append('}')
    return '\n'.join(lines) + '\n'


def process_model(model, local_names, lib, db, opt, log):
    # LDraw type 2-5 lines are free-standing geometry, not parts that can be
    # reordered independently.  Keep these subfiles byte-for-byte intact.
    if any(l.split() and l.split()[0] in ('2', '3', '4', '5') for l in model['lines']):
        return [], list(model['lines']), [], {
            'name': model['name'], 'units': 0, 'steps': 0, 'notes': [], 'dropped': 0,
            'skipped': 'contains free-standing LDraw geometry (types 2-5)'
        }, []

    refs = [norm(' '.join(p[14:])) for l in model['lines']
            for p in [l.split()] if p and p[0] == '1' and len(p) >= 15]
    assembly_only = bool(refs) and all(n in local_names for n in refs)
    # Top-level assemblies of submodels require no geometry or shadow lookups.
    geo_before = lib.geometry_stats.copy()
    hdr, us, tr, dropped = read_units(model, local_names, lib, db, opt.shadow,
                                      load_geometry=not assembly_only)
    missing = sorted({u['part'] for u in us if u.get('missing_geometry')})
    res = {'name': model['name'], 'units': len(us), 'steps': 0,
           'notes': [], 'dropped': dropped, 'missing_geometry': len(missing)}
    res['geometry_stats'] = {k: lib.geometry_stats[k] - geo_before[k] for k in geo_before}
    if missing:
        res['notes'].append('missing part geometry for %d unique part(s): %s%s' % (
            len(missing), ', '.join(missing[:5]), ', ...' if len(missing) > 5 else ''))
    if not us or all(u['kind'] == 'ref' for u in us):          # assembly-of-submodels: one step per reference
        out = list(hdr)
        for u in us: out += u['lines'] + ['0 STEP']
        res['steps'] = len(us)
        if opt.explain or opt.report_dot:
            res.update(explain_reference_assembly(us))
        return hdr, out[len(hdr):], tr, res, []
    an = Analysis(us, opt.shadow, opt.contact_mode)
    sub_models = []
    if opt.subassemblies:
        comps = an.components(); first = next(i for i, u in enumerate(us) if u['kind'] != 'synth')
        base = os.path.splitext(model['name'])[0].replace(' ', '_')
        used_names = set(local_names)
        chosen = [c for c in comps if first not in c and opt.sub_min <= len(c) <= opt.sub_max
                  and all(us[i]['kind'] == 'part' for i in c) and an.attach[np.ix_(c, [j for j in range(an.n) if j not in c])].any()]
        if chosen:
            merged, drop = list(us), set()
            suffix = 1
            for c in chosen:
                name = '%s_sub%d.ldr' % (base, suffix)
                while norm(name) in used_names:
                    suffix += 1
                    name = '%s_sub%d.ldr' % (base, suffix)
                used_names.add(norm(name))
                suffix += 1
                members = [us[i] for i in sorted(c, key=lambda i: us[i]['order'])]
                msub = Analysis(members, opt.shadow, opt.contact_mode)
                deg = msub.attach.sum(1); fnd = int(np.argmax(deg))
                notes = []
                st = repair(members, msub, plan_steps(members, msub, opt.max_step, fnd, notes))
                sub_models.append({'name': name, 'hdr': ['0 FILE ' + name, '0 Name: ' + name],
                                   'body': emit_steps(members, st), 'steps': len(st), 'parts': len(members)})
                merged.append(make_sub_unit(c, us, name)); drop |= set(c)
            us = [u for i, u in enumerate(merged) if i not in drop]
            # Retain original order positions. Reindexing after dropping a
            # group used to move its replacement into the wrong position.
            us.sort(key=lambda u: u['order']); an = Analysis(us, opt.shadow, opt.contact_mode)
            log('  %d sub-assemblies extracted' % len(chosen))
    notes = res['notes']; reasons = {}
    steps = repair(us, an, plan_steps(us, an, opt.max_step, 0, notes, reasons=reasons))
    fl, un = verify(us, an, steps)
    res.update(steps=len(steps), floating=len(fl), unsupported=len(un), snap_links=an.snap_pairs,
               fallback_links=an.fallback_pairs, sub=[(m['name'], m['parts'], m['steps']) for m in sub_models])
    res['analysis_stats'] = {
        'aabb_possible_pairs': an.n * (an.n - 1) // 2,
        'aabb_candidate_pairs': an.bbox_candidate_pairs,
        'aabb_contact_pairs': len(an.contact_pairs),
        'contact_mode': an.contact_mode,
        'obb_rejected_false_contacts': an.obb_rejections,
        'snap_possible_connector_pairs': an.snap_possible_pairs,
        'snap_candidate_connector_pairs': an.snap_candidate_pairs,
        'snap_links': an.snap_pairs,
        'heuristic_links': an.fallback_pairs,
        'caveat': 'Contact and insertion use bounding-box approximations, not a solid collision solver.'}
    if opt.explain or opt.report_dot:
        res.update(explain_plan(us, an, steps, reasons, fl, un))
    return hdr, emit_steps(us, steps), tr, res, sub_models


def atomic_write(path, contents):
    """Avoid clobbering an input/output file if writing is interrupted."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix='.ldraw_autostep_', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', errors='surrogateescape', newline='') as f:
            f.write(contents)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def run(opt, log=print):
    with open(opt.input, encoding='utf-8', errors='surrogateescape', newline='') as f:
        text = f.read()
    eol, models = split_models(text)
    requested = {norm(n) for n in opt.only} if opt.only else None
    if requested:
        present = {norm(m['name']) for m in models}
        absent = requested - present
        if absent:
            raise ValueError('unknown submodel name(s) in --only: ' + ', '.join(sorted(absent)))
    lib = Library(opt.ldraw, opt.shadow_dir, opt.cache, opt.offline)
    local = {norm(m['name']) for m in models}
    for m in models: lib.extra[norm(m['name'])] = '\n'.join(m['lines'])
    db = SnapDB(lib)
    out, reports = [], []
    for m in models:
        if requested and norm(m['name']) not in requested:
            out += m['lines']
            continue
        log('planning %s ...' % m['name'])
        hdr, body, tr, res, subs = process_model(m, local, lib, db, opt, log)
        out += hdr + body + tr
        for s in subs: out += s['hdr'] + s['body'] + ['0 ']
        reports.append(res)
    atomic_write(opt.output, eol.join(out))
    if opt.report_dot:
        atomic_write(opt.report_dot, dot_graph(reports))
    if not opt.explain:
        for res in reports:
            for key in ('parts', 'connections', 'steps_detail', 'issues'):
                res.pop(key, None)
    return reports


def main(argv=None):
    ap = argparse.ArgumentParser(description='Add logical build steps to an LDraw .mpd/.ldr using LDraw geometry '
                                             'and LDCad shadow (snap) data.')
    ap.add_argument('input'); ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--ldraw', help='local LDraw library dir (contains parts/ and p/); default: auto-download needed files')
    ap.add_argument('--shadow-dir', dest='shadow_dir', help='local LDCadShadowLibrary checkout; default: auto-download')
    ap.add_argument('--cache', help='download cache dir'); ap.add_argument('--offline', action='store_true')
    ap.add_argument('--max-step', type=int, default=8, help='target max parts per step (mirror pairs may add one)')
    ap.add_argument('--no-shadow', dest='shadow', action='store_false',
                    help='ignore snap data; use geometric contact fallback only')
    ap.add_argument('--contact-mode', choices=('aabb', 'obb'), default='obb',
                    help='fallback contact test (default: rotated-box rejection; aabb for legacy behavior)')
    ap.add_argument('--subassemblies', action='store_true',
                    help='extract rigid groups joined to the rest only by rotating joints (wheel+axle units...) into sub-models')
    ap.add_argument('--sub-min', type=int, default=3); ap.add_argument('--sub-max', type=int, default=40)
    ap.add_argument('--only', nargs='+', help='only plan these submodel names'); ap.add_argument('-q', '--quiet', action='store_true')
    ap.add_argument('--report-json', metavar='PATH', help='write per-model planning diagnostics to JSON')
    ap.add_argument('--explain', action='store_true',
                    help='include per-part geometry, link evidence, insertion routes and issue IDs in --report-json')
    ap.add_argument('--report-dot', metavar='PATH',
                    help='write Graphviz DOT connection graph (snap/contact/bridge edges)')
    ap.add_argument('--strict', action='store_true',
                    help='exit nonzero if missing geometry, floating units or unsupported placements are reported')
    opt = ap.parse_args(argv)
    if opt.max_step < 1:
        ap.error('--max-step must be at least 1')
    if opt.sub_min < 1 or opt.sub_max < opt.sub_min:
        ap.error('--sub-min must be at least 1 and --sub-max must be >= --sub-min')
    if opt.explain and not opt.report_json:
        ap.error('--explain requires --report-json PATH')
    output_files = [opt.input, opt.output] + [x for x in (opt.report_json, opt.report_dot) if x]
    if len({os.path.abspath(x) for x in output_files}) != len(output_files):
        ap.error('input, output, --report-json and --report-dot must use distinct file paths')
    log = (lambda *a: None) if opt.quiet else print
    try:
        reps = run(opt, log)
    except (OSError, ValueError) as exc:
        ap.exit(2, 'error: %s\n' % exc)
    if opt.report_json:
        try:
            atomic_write(opt.report_json, json.dumps(reps, indent=2, ensure_ascii=False) + '\n')
        except OSError as exc:
            ap.exit(2, 'error writing JSON report: %s\n' % exc)
    for r in reps:
        log('%-24s units=%-4d steps=%-3d' % (r['name'], r['units'], r['steps']) +
            ('  snap-links=%d fallback-links=%d floating=%d placed-before-support=%d' % (
                r['snap_links'], r['fallback_links'], r['floating'], r['unsupported']) if 'floating' in r else ''))
        if r.get('skipped'): log('    skipped: ' + r['skipped'])
        if r.get('missing_geometry'): log('    missing-geometry=%d' % r['missing_geometry'])
        if 'analysis_stats' in r:
            st = r['analysis_stats']
            log('    spatial candidates: AABB=%d/%d, snap=%d/%d; OBB rejects=%d' % (
                st['aabb_candidate_pairs'], st['aabb_possible_pairs'],
                st['snap_candidate_connector_pairs'], st['snap_possible_connector_pairs'],
                st['obb_rejected_false_contacts']))
        for s in r.get('sub', []): log('    sub-assembly %s: %d parts, %d steps' % s)
        unique_notes = list(dict.fromkeys(r['notes']))
        for nline in unique_notes[:8]: log('    note: ' + nline)
        if len(unique_notes) > 8:
            log('    ... %d more notes (use --report-json and --explain for individual units)' % (
                len(unique_notes) - 8))
        if opt.explain and r.get('issues'):
            issue_counts = Counter(x['code'] for x in r['issues'])
            log('    issues: ' + ', '.join('%s=%d' % item for item in issue_counts.most_common()))
            for issue in r['issues'][:8]:
                unit = issue.get('unit')
                part = r['parts'][unit] if unit is not None else None
                where = (' (source line %d, %s)' % (part['source_line'], part['part'])
                         if part is not None and part['source_line'] is not None else '')
                log('      [%s] %s%s' % (issue['severity'], issue['code'], where))
            if len(r['issues']) > 8:
                log('      ... %d additional issue records in JSON' % (len(r['issues']) - 8))
        if r['dropped']: log('    (removed %d existing STEP/ROTSTEP lines)' % r['dropped'])
    failed = [r['name'] for r in reps if any(r.get(k, 0) for k in (
        'missing_geometry', 'floating', 'unsupported'))]
    if opt.strict and failed:
        print('strict mode: planning diagnostics for: ' + ', '.join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
