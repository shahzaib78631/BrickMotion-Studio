"""Independently check every delivered quantity against its actual PDF text span."""
import json,re,sys
from pathlib import Path
import pymupdf
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
from instructions_pdf.extract import _spans,COUNT,MAIN,NUM
m=json.loads((ROOT/'output/book1-parts/book1-parts.json').read_text());doc=pymupdf.open(m['sources']['bookletPdf']);spans={};seen=set();max_alignment=0
for step in m['steps']:
    page=step['page'];text=spans.setdefault(page,_spans(doc[page-1]))
    assert any(s['text']==str(step['number']) and MAIN[0]<=s['size']<=MAIN[1] for s in text),(step['key'],'printed step absent')
    for part in step['parts']:
        for e in part['evidence']:
            label=min(text,key=lambda s:sum(abs(a-b) for a,b in zip(s['bbox'],e['countBox'])))
            assert max(abs(a-b) for a,b in zip(label['bbox'],e['countBox']))<.01
            assert label['text']==str(e['quantity'])+'x',(step['key'],part['partId'],label['text'],e['quantity'])
            key=(page,*e['countBox']);assert key not in seen;seen.add(key)
            max_alignment=max(max_alignment,abs(e['countBox'][0]-e['partBox'][0]))
assert len(seen)==1277
assert max_alignment<=3
print(f'PASS: all {len(seen)} delivered quantities exactly match unique printed PDF labels; max label/artwork left-alignment error {max_alignment:.3f} pt.')
