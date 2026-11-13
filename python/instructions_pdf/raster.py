"""Raster instruction-page adapter. No document text is executed as instructions.

Tesseract reads isolated labels, never the model drawing. All boxes remain in PDF
points; uncertain OCR is retained as a diagnostic rather than silently repaired.
"""
from __future__ import annotations

import csv
import io
import os
import re
import shutil
import subprocess
import tempfile

import numpy as np
import pymupdf


def components(mask):
    """Four-connected components as (x0,y0,x1,y1,area), using horizontal runs."""
    rows = []
    runs = []
    parent = []
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for y, row in enumerate(mask):
        edges = np.diff(np.r_[False, row, False].astype(np.int8))
        current = []
        prev = rows[-1] if rows else []
        j = 0
        for x0, x1 in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
            i = len(runs)
            runs.append((int(x0), y, int(x1)))
            parent.append(i)
            while j < len(prev) and runs[prev[j]][2] <= x0:
                j += 1
            k = j
            while k < len(prev) and runs[prev[k]][0] < x1:
                parent[root(prev[k])] = root(i)
                k += 1
            current.append(i)
        rows.append(current)
    boxes = {}
    for i, (x0, y, x1) in enumerate(runs):
        r = root(i)
        b = boxes.setdefault(r, [x0, y, x1, y + 1, 0])
        b[0] = min(b[0], x0); b[2] = max(b[2], x1); b[3] = y + 1; b[4] += x1 - x0
    return list(boxes.values())


def ocr(page, box, *, digits=False, quantities=False, psm=None):
    if not shutil.which('tesseract'):
        raise RuntimeError('Raster PDF requires Tesseract OCR. Install tesseract or provide a text-layer PDF.')
    with tempfile.TemporaryDirectory() as temp:
        path = os.path.realpath(os.path.join(temp, 'label.png'))
        page.get_pixmap(dpi=216, clip=pymupdf.Rect(box) & page.rect).save(path)
        args = ['tesseract', path, 'stdout', '--psm', str(psm) if psm else ('7' if digits else ('6' if quantities else '11'))]
        if digits:
            args += ['-c', 'tessedit_char_whitelist=0123456789']
        if quantities:
            args += ['-c', 'tessedit_char_whitelist=0123456789xX']
        result = subprocess.run(args + ['tsv'], capture_output=True, text=True, timeout=30)
        if result.returncode or 'Error during processing' in result.stderr:
            raise RuntimeError(f'Tesseract could not read page {page.number + 1}: {result.stderr[-500:]}')
    words = []
    for row in csv.DictReader(io.StringIO(result.stdout), delimiter='\t'):
        if row['level'] != '5' or not row.get('text', '').strip():
            continue
        x, y, w, h = [int(row[k]) / 3 for k in ('left', 'top', 'width', 'height')]
        words.append({'text': row['text'].strip(), 'confidence': float(row['conf']),
                      'bbox': (box[0]+x, box[1]+y, box[0]+x+w, box[1]+y+h)})
    return words


def raster_step(page, out_dir, *, number_hint=None):
    """One top-labelled Studio-style step per page; returns step and diagnostics.

    Unsupported / unrecognised pages are recorded by the caller, including cover
    and completion illustrations. The full page is kept for placement context.
    """
    from .extract import _clip, CROP_DPI, PICTURE_DPI
    pix = page.get_pixmap(dpi=72, alpha=False, colorspace=pymupdf.csRGB)
    rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).astype(np.int16)
    # Pale blue is a panel background, unlike saturated cover backgrounds.
    blue = ((rgb[:,:,2]-rgb[:,:,0] > 12) & (rgb[:,:,1]-rgb[:,:,0] > 5)
            & (rgb[:,:,0] > 150) & (rgb[:,:,2] > 210))
    panels = [b[:4] for b in components(blue) if b[4] > 250 and b[2]-b[0] > 20
              and b[3]-b[1] > 20 and b[1] < page.rect.height * .3]
    panels.sort(key=lambda b:(b[1],b[0]))
    # Label is immediately left of the first parts panel. This excludes part art
    # which is routinely misread as digits by full-page OCR.
    panel = panels[0] if panels else [page.rect.width*.21, page.rect.height*.08, 0, 0]
    label_box = (max(0, page.rect.width*.025), max(0, panel[1]-5), panel[0]-2,
                 min(page.rect.height, panel[1]+65))
    margin = rgb[:max(1, int(page.rect.height*.05)), :max(1,int(page.rect.width*.25))]
    if not panels and (margin > 240).all(axis=2).mean() < .95:
        return None, []
    words = ocr(page, label_box, digits=True)
    numbers = [w for w in words if re.fullmatch(r'\d{1,4}',w['text'])]
    if not numbers:
        words = ocr(page, label_box, digits=True, psm=13)
        numbers = [w for w in words if re.fullmatch(r'\d{1,4}',w['text'])]
    if not numbers and number_hint is not None:
        numbers = [{'text':str(number_hint),'confidence':0,'bbox':label_box}]
    if not numbers:
        return None, ([{'page':page.number+1,'code':'unreadable-step','message':'Parts panel found but step label could not be read.'}] if panels else [])
    label = max(numbers, key=lambda w:w['bbox'][3]-w['bbox'][1])
    number = int(label['text'])
    diagnostics = []
    if label['confidence'] < 80:
        diagnostics.append({'page':page.number+1,'code':'uncertain-step','message':f'Low confidence step label {number} ({label["confidence"]:.1f}).'})
    prefix = f'crops/p{page.number+1}_s{number}'
    picture = prefix+'_page.png'
    _clip(page, page.rect, PICTURE_DPI, os.path.join(out_dir,picture))
    callouts = []
    for box in panels:
        words = ocr(page, (box[0]+2, max(box[1]+2,box[3]-32),box[2]-2,box[3]-2), quantities=True)
        counts = [w for w in words if re.fullmatch(r'\d+\s*[xX×]',w['text'])]
        counts.sort(key=lambda w:(round(w['bbox'][1]/12),w['bbox'][0]))
        if not counts:
            diagnostics.append({'page':page.number+1,'code':'unreadable-count','message':'Parts panel has no readable quantities; panel retained for review.'})
            crop=prefix+f'_c{len(callouts)}.png'
            _clip(page,box,CROP_DPI,os.path.join(out_dir,crop))
            callouts.append({'crop':crop,'count':1,'countFound':False,'box':box})
            continue
        # Partition panel into rows and columns around quantity labels. Never
        # include the quantity glyph itself in the part matching thumbnail.
        for w in counts:
            same_row = [c for c in counts if abs(c['bbox'][1]-w['bbox'][1]) < 12]
            row_above = [c['bbox'][3] for c in counts if c['bbox'][1] < w['bbox'][1]-12]
            cx=(w['bbox'][0]+w['bbox'][2])/2
            left=[c for c in same_row if c['bbox'][0]<w['bbox'][0]]
            right=[c for c in same_row if c['bbox'][0]>w['bbox'][0]]
            x0=w['bbox'][0]-3 if left else box[0]+2
            x1=min(c['bbox'][0] for c in right)-3 if right else box[2]-2
            crop_box=(x0,max(row_above,default=box[1]+2),x1,w['bbox'][1]-1)
            if crop_box[3]<=crop_box[1]:
                diagnostics.append({'page':page.number+1,'code':'invalid-part-crop','message':'Quantity label has no part image above it.'})
                continue
            crop=prefix+f'_c{len(callouts)}.png'
            _clip(page,crop_box,CROP_DPI,os.path.join(out_dir,crop))
            callouts.append({'crop':crop,'count':int(re.match(r'\d+',w['text'])[0]),
                             'countFound':w['confidence']>=70,'box':list(crop_box)})
    return {'page':page.number+1,'number':number,'picture':picture,'callout':callouts,
            'substeps':[], 'source':'raster-ocr'}, diagnostics


def recover_raster_sequence(doc, steps, raster_pages, unparsed_pages, diagnostics, out_dir):
    """Retain obscured steps between two agreeing runs, explicitly as inferred.

    Only adjacent observations establish an anchor; a singleton OCR hallucination
    cannot rename a run. This is provisional evidence and always blocks strict use.
    """
    by_page = {s['page']:s for s in steps if s.get('source') == 'raster-ocr'}
    anchors = {}
    for p, s in by_page.items():
        for other in (p-1,p+1):
            if other in by_page and by_page[other]['number']-s['number'] == other-p:
                anchors[p] = s['number']-p
    ordered = sorted(anchors)
    for page in raster_pages:
        if page in anchors:
            continue
        before = [p for p in ordered if p < page]
        after = [p for p in ordered if p > page]
        if not before or not after or anchors[before[-1]] != anchors[after[0]]:
            continue
        expected = page+anchors[before[-1]]
        old = by_page.get(page)
        if old and old['number'] == expected:
            continue
        if old:
            old['observedNumber'] = old['number']
            old['number'] = expected
        else:
            old, issues = raster_step(doc[page-1],out_dir,number_hint=expected)
            diagnostics.extend(issues)
            if old is None:
                continue
            old['observedNumber'] = old['number'] if old['number'] != expected else None
            old['number'] = expected
            steps.append(old)
            if page in unparsed_pages:
                unparsed_pages.remove(page)
        old['numberSource'] = 'sequence-inferred'
        diagnostics.append({'page':page,'code':'inferred-step','message':f'Step {expected} inferred between agreeing neighbouring sequences; printed label {old.get("observedNumber")} requires visual review.'})
    steps.sort(key=lambda s:(s['page'],s['number']))
