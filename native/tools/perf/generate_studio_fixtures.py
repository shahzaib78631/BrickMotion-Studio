#!/usr/bin/env python3
"""Reproducible tiny Studio .io fixtures; run from the repository root.

The encrypted fixture uses the system 'zip' CLI, solely at fixture-generation time.
The native test suite only reads the checked-in .io bytes and requires no Python.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import zipfile
import subprocess

base = Path(__file__).resolve().parents[2] / 'tests/fixtures/studio'
base.mkdir(exist_ok=True, parents=True)

I = '1 16 0 0 0 1 0 0 0 1 0 0 0 1 '
triangle = '3 16 0 0 0 20 0 0 0 20 0\n'

files = {
    'model.ldr': '''0 FILE main.ldr
0 Embedded Geometry Test
1 16 0 0 0 1 0 0 0 1 0 0 0 1 FANCY.DAT
1 4 50 0 0 1 0 0 0 1 0 0 0 1 OVERRIDE.DAT
0 FILE override.dat
0 MPD geometry wins over embedded geometry
0 BFC CERTIFY CCW
3 16 0 0 0 1 0 0 0 2 0
''',
    'CustomParts/Fancy.dat': '0 FILE Fancy.dat\n0 Fancy custom part\n0 BFC CERTIFY CCW\n'+I+'s/smoke.dat\n'+I+'48/ring.dat\n',
    'CustomParts/s/s/SMOKE.dat': '0 FILE Smoke.dat\n0 BFC CERTIFY CCW\n'+I+'box4.dat\n',
    'CustomParts/p/BOX4.dat': '0 FILE box4.dat\n0 BFC CERTIFY CCW\n'+triangle,
    'CustomParts/p/48/ring.dat': '0 FILE ring.dat\n0 BFC CERTIFY CCW\n3 16 0 0 10 20 0 10 0 20 10\n',
    'CustomParts/override.dat': '0 FILE override.dat\n0 BFC CERTIFY CCW\n'+triangle+triangle,
    'CustomParts/unused.dat': '0 FILE unused.dat\n0 BFC CERTIFY CCW\n'+triangle,
    'ImageResource/thumbnail.png': '\x89PNG (not a real image)',
}

for suffix, compression in [('embedded.io', zipfile.ZIP_DEFLATED),('stored.io', zipfile.ZIP_STORED)]:
    with zipfile.ZipFile(base/suffix, 'w', compression=compression) as z:
        for name, content in files.items():
            z.writestr(name, content.encode('latin-1') if name.endswith('.png') else content)

# Another archive uses the same logical names, but a different primitive. Its geometry
# must remain independent even if both are opened with a shared disk library/PartCache.
variant = dict(files)
variant['CustomParts/p/BOX4.dat'] = '0 FILE box4.dat\n0 BFC CERTIFY CCW\n3 16 0 0 100 20 0 100 0 20 100\n'
with zipfile.ZipFile(base/'isolated.io', 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name, content in variant.items(): z.writestr(name, content)

# The checked-in encrypted archive uses the same traditional PKZIP encryption as Studio.
with TemporaryDirectory() as td:
    root = Path(td)
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_bytes(content.encode('latin-1') if name.endswith('.png') else content.encode())
    (base/'encrypted.io').unlink(missing_ok=True)
    subprocess.run(['zip','-q','-r','-P','soho0909',str(base/'encrypted.io'),*files],cwd=root,check=True)

for suffix, extras in [('duplicate.io', {'CustomParts/FA NCY.dat': '0 nothing'}),
                       ('traversal.io', {'CustomParts/../evil.dat': '0 invalid'})]:
    with zipfile.ZipFile(base/suffix, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items(): z.writestr(name, content)
        for name, content in extras.items():
            # A true same-key collision after case folding.
            if suffix == 'duplicate.io': name = 'customparts/FANCY.DAT'
            z.writestr(name, content)

# Corrupt the CRC of the referenced custom part in the central directory. Inflate must
# not allow geometry into a model when its ZIP checksum does not verify.
p = base/'corrupt.io'
p.write_bytes((base/'embedded.io').read_bytes())
s = bytearray(p.read_bytes())
name = b'CustomParts/Fancy.dat'
start = 0
while True:
    at = s.find(b'PK\x01\x02', start)
    if at < 0: raise RuntimeError('zip fixture missing custom part central directory entry')
    namelen = int.from_bytes(s[at+28:at+30], 'little')
    if s[at+46:at+46+namelen] == name:
        s[at+16] ^= 0x01
        break
    start = at+4
p.write_bytes(s)

# An invalid unused entry is deliberately never decompressed: reachable geometry should
# still import and pass its own CRCs.
p = base/'unreferenced_corrupt.io'
s = bytearray((base/'embedded.io').read_bytes())
name = b'CustomParts/unused.dat'
start = 0
while True:
    at = s.find(b'PK\x01\x02', start)
    if at < 0: raise RuntimeError('zip fixture missing unused custom part')
    namelen = int.from_bytes(s[at+28:at+30], 'little')
    if s[at+46:at+46+namelen] == name:
        s[at+16] ^= 0x01
        break
    start = at+4
p.write_bytes(s)

# A central directory entry announcing a >16 MB part must be rejected before inflate.
p = base/'oversize.io'
s = bytearray((base/'embedded.io').read_bytes())
name = b'CustomParts/Fancy.dat'
start = 0
while True:
    at = s.find(b'PK\x01\x02', start)
    if at < 0: raise RuntimeError('zip fixture missing custom part')
    namelen = int.from_bytes(s[at+28:at+30], 'little')
    if s[at+46:at+46+namelen] == name:
        s[at+24:at+28] = (17 * 1024 * 1024).to_bytes(4, 'little')
        break
    start = at+4
p.write_bytes(s)


# Collision-certification fixtures: a closed 40-LDU cube implemented as an embedded
# subpart. We intentionally make the outer .dat refer to s/cube_skin.dat, because
# success on a top-level part alone does not establish recursive collision geometry.
faces = [
    [(-20,-20,-20),(-20,-20,20),(-20,20,20),(-20,20,-20)], # -X
    [(20,-20,-20),(20,20,-20),(20,20,20),(20,-20,20)],      # +X
    [(-20,-20,-20),(20,-20,-20),(20,-20,20),(-20,-20,20)],  # -Y
    [(-20,20,-20),(-20,20,20),(20,20,20),(20,20,-20)],     # +Y
    [(-20,-20,-20),(-20,20,-20),(20,20,-20),(20,-20,-20)],  # -Z
    [(-20,-20,20),(20,-20,20),(20,20,20),(-20,20,20)],      # +Z
]
cube = '0 BFC CERTIFY CCW\n' + ''.join(
    '4 16 ' + ' '.join(str(v) for point in face for v in point) + '\n'
    for face in faces
)
place = lambda x: f'1 16 {x} 0 0 1 0 0 0 1 0 0 0 1 validation-cube.dat\n'
scene = {
    'CustomParts/validation-cube.dat': '0 Validation cube\n0 BFC CERTIFY CCW\n' + I + 's/cube_skin.dat\n',
    'CustomParts/s/s/cube_skin.dat': '0 Cube skin\n' + cube,
}
for filename, positions, partial in [
    ('collision_clear.io', [0, 120], False),
    ('collision_overlap.io', [0, 30], False),
    ('collision_partial.io', [0, 120], True),
]:
    bundle = dict(scene)
    if partial:
        # A valid, parseable, CRC-correct file can still reference a missing
        # nested primitive. Previously the model's top-level "missing" report
        # stayed empty and the partial collision mesh was silently accepted.
        bundle['CustomParts/s/s/cube_skin.dat'] += I + 'missing-nested-part.dat\n'
    bundle['model.ldr'] = '0 FILE main.ldr\n0 Collision fixture\n' + ''.join(map(place, positions))
    with zipfile.ZipFile(base / filename, 'w') as z:
        for name, content in bundle.items():
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, content)

# A ZIP-complete custom part with malformed LDraw geometry must remain
# observable (and fail strict validation), rather than being silently dropped.
malformed = dict(scene)
malformed['model.ldr'] = '0 FILE main.ldr\n' + place(0)
malformed['CustomParts/s/s/cube_skin.dat'] += '3 16 not-a-number 0 0 1 0 0 0 1 0\n'
with zipfile.ZipFile(base / 'collision_malformed.io', 'w') as z:
    for name, content in malformed.items():
        info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, content)

print('Fixture files:', *[f.name for f in sorted(base.glob('*.io'))])
