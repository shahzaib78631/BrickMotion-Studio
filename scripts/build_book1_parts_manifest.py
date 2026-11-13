"""Build the reviewed book-one manifest and a local step-wise review gallery."""
import argparse, hashlib, json, sys, shutil, zipfile, re
from html import escape
import pymupdf
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
from booklet_mpd.parts_manifest import compile_manifest, parse_pbg


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pbg',type=Path,required=True);args=parser.parse_args()
    out=ROOT/'output/book1-parts';audit=json.loads((out/'audit.json').read_text());review=json.loads((ROOT/'reference/booklets/21065/book1-identifications.json').read_text())
    catalog=json.loads((ROOT/'.cache/booklet-mpd/rebrickable/21065-1.json').read_text())
    manifest=compile_manifest(audit,review,parse_pbg(args.pbg.read_text()),catalog)
    manifest['sources']['suppliedPbg']=str(args.pbg.resolve());manifest['sources']['suppliedPbgSha256']=hashlib.sha256(args.pbg.read_bytes()).hexdigest()
    manifest['sources']['reviewFile']='reference/booklets/21065/book1-identifications.json'
    fresh=json.loads((out/'legacy-catalog-verification.json').read_text());used={p['elementId'] for s in manifest['steps'] for p in s['parts']}
    for el in used.intersection(fresh):
        if fresh[el]['status']!='resolved':raise ValueError(f'Legacy element {el} lookup failed')
        old=next(x['catalog'] for x in audit['inventory'] if x['element']==el);new=fresh[el]['record']
        if (old['part'],old['color'])!=(new['part'],new['color']):raise ValueError(f'Fresh element lookup disagrees for {el}')
    manifest['verification']['legacyElementMappingsRefreshed']=len(used.intersection(fresh))
    for s in manifest['steps']:
        for p in s['parts']:
            candidates=[ROOT/'public/ldraw/parts'/f'{name}.dat' for name in [p['partId'],*p['ldrawAliases']]]
            found=next((p for p in candidates if p.exists()),None)
            if found:
                seen=set()
                while found not in seen:
                    seen.add(found)
                    description=found.read_text(errors='replace').splitlines()[0].removeprefix('0 ').strip()
                    moved=re.match(r'~Moved to ([A-Za-z0-9._-]+)',description)
                    if not moved:break
                    target=found.with_name(moved[1].removesuffix('.dat')+'.dat')
                    if not target.exists():break
                    found=target
                p['description']=description
            elif re.search(r'pr\d+$',p['partId']) and (ROOT/'public/ldraw/parts'/(re.sub(r'pr\d+$','',p['partId'])+'.dat')).exists():
                base=ROOT/'public/ldraw/parts'/(re.sub(r'pr\d+$','',p['partId'])+'.dat')
                name=base.read_text(errors='replace').splitlines()[0].removeprefix('0 ').strip()
                p['description']=f"{name} - printed variant {p['rebrickablePartId']}"
            else:p['description']=f"Part {p['rebrickablePartId']}"
    mesh_path=out/'mesh-audit.json'
    mesh=json.loads(mesh_path.read_text()) if mesh_path.exists() else None
    mesh_by_id={p['partId']:p for p in mesh['parts']} if mesh else {}
    if mesh:manifest['verification']['meshAvailability']=mesh['counts']
    for step in manifest['steps']:
        for part in step['parts']:
            part['mesh']=mesh_by_id.get(part['partId'],{'status':'not-checked'})
    manifest['artifactBase']='/output/book1-parts/'
    manifest['sources']['reviewSha256']=hashlib.sha256((ROOT/'reference/booklets/21065/book1-identifications.json').read_bytes()).hexdigest()
    (out/'boards').mkdir(exist_ok=True)
    doc=pymupdf.open(manifest['sources']['bookletPdf'])
    for step in manifest['steps']:
        step['sourceBoards']=[]
        for i,box in enumerate(step['calloutBoxes']):
            name=f"boards/seq{step['sequence']}-step{step['number']}-p{step['page']}-{i}.png"
            doc[step['page']-1].get_pixmap(matrix=pymupdf.Matrix(2,2),clip=pymupdf.Rect(box),alpha=False).save(out/name)
            step['sourceBoards'].append(name)
    doc.close()
    if args.pbg.resolve() != (out/'inventory-source.pbg').resolve():
        shutil.copyfile(args.pbg,out/'inventory-source.pbg')
    (out/'book1-parts.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
    public=ROOT/'public/_booklet/21065/book1-parts.json'
    public.write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
    # Standard solver input, with the original render aliases retained. The source
    # fingerprint prevents an old reviewed manifest overriding a changed booklet.
    legacy=json.loads((ROOT/'.cache/booklet-mpd/teach/21065/parts-1.json').read_text())
    rows=[]
    for step,old in zip(manifest['steps'],legacy,strict=True):
        parts=[[p['ldrawPartId'],p['colorId']] for p in step['parts'] for _ in range(p['quantity'])]
        rows.append({'number':step['number'],'page':step['page'],'repeat':1,'illustratedRepeat':old.get('repeat',1),
            'substeps':old.get('substeps',0),'parts':parts,'confidence':[1.0]*len(parts),
            'confidenceMeaning':'explicit source-artwork review; not a calibrated probability','unresolved':0,'partsVerified':True,
            'sequence':step['sequence'],'manifestStep':step['key']})
    derived={'format':'reviewed-booklet-parts-v1','set':'21065','book':1,'sourceHash':manifest['sources']['bookletSha256'],
        'manifestSha256':hashlib.sha256((out/'book1-parts.json').read_bytes()).hexdigest(),'steps':rows}
    (ROOT/'.cache/booklet-mpd/teach/21065/audited-parts-1.json').write_text(json.dumps(derived,indent=1))
    write_step_bins(out,manifest)
    write_gallery(out,manifest)
    print(json.dumps(manifest['verification'],indent=2))

def write_step_bins(out, manifest):
    def pbg(caption, parts):
        return '[options]\nkind=basic\ncaption='+caption+'\nsortOn=description\n\n<items>\n'+''.join(f"{p['partId']}.dat:[sourceInv=parts] [color={p['colorId']}] [count={p['quantity']}]\n" for p in parts)
    (out/'book1-parts.pbg').write_text(pbg('21065 Book 1 - all new parts',manifest['totals']))
    folder=out/'ldcad-step-bins';folder.mkdir(exist_ok=True)
    for step in manifest['steps']:
        dest=folder/f"sequence-{step['sequence']}";dest.mkdir(exist_ok=True)
        (dest/f"step-{step['number']:03d}.pbg").write_text(pbg(f"21065 Book 1 Seq {step['sequence']} Step {step['number']} - PDF p{step['page']}",step['parts']))
    notes='21065 Book 1: 447 step bins across three restarted numbering sequences (111, 151, 185 steps).\nQuantities follow the printed main parts boxes; do not multiply again by illustrated subassembly repetitions.\nThe 20 assembly-only steps have empty bins. Total new pieces: 4043; 315 part/colour combinations.\nThe exact decorated LDraw variants 22385pr0149 and 22385pr0166 are identified but their local mesh decorations are unavailable. Their plain base has not been substituted in these bins.\nSee book1-parts.json and the local evidence gallery for source pages, element IDs, aliases and original parts-box images.\n'
    (folder/'README.txt').write_text(notes)
    with zipfile.ZipFile(out/'book1-step-bins.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(folder.rglob('*')):
            if path.is_file():archive.write(path,path.relative_to(folder))


def write_gallery(out, manifest):
    cards=[]
    for step in manifest['steps']:
        rows=[]
        for part in step['parts']:
            e=part['evidence'][0]
            rows.append(f"""<tr><td><img class="thumb" src="{e['calloutImage']}" alt="Booklet part artwork" loading="lazy"></td>
<td><strong>{escape(part['partId'])}</strong><div>{escape(part['description'])}</div><small>Rebrickable {escape(part['rebrickablePartId'])} · LDraw aliases: {escape(', '.join(part['ldrawAliases']))}</small></td>
<td>{escape(part['colorName'])}<small>LDraw {part['colorId']}</small></td><td class="qty">{part['quantity']}</td>
<td><img class="thumb" src="{part['inventoryImage']}" alt="Printed inventory artwork" loading="lazy"><small>Element {part['elementId']}</small></td></tr>""")
        boards=''.join(f'<a href="{img}"><img class="board" src="{img}" alt="Original parts box including printed quantities" loading="lazy"></a>' for img in step['sourceBoards'])
        table='<table><thead><tr><th>Booklet</th><th>Part</th><th>Colour</th><th>Qty</th><th>Printed inventory</th></tr></thead><tbody>'+''.join(rows)+'</tbody></table>' if rows else '<p class="empty">Assembly-only step: no new parts box. This step uses assemblies built earlier.</p>'
        search=' '.join(str(p[k]) for p in step['parts'] for k in ['partId','rebrickablePartId','elementId','description','colorName']).lower()
        cards.append(f"""<article data-sequence="{step['sequence']}" data-step="{step['number']}" data-search="{escape(search,quote=True)}">
<h2>Sequence {step['sequence']} · Step {step['number']} <span>#{step['index']} overall · page {step['page']} · {step['totalPieces']} pieces</span></h2>
<div class="boards">{boards}</div>{table}<a class="pdf" href="/.cache/instructions/21065/pdf/21065-6655036.pdf#page={step['page']}">Open original booklet page {step['page']}</a></article>""")
    v=manifest['verification']
    html="""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>21065 · Book one parts by step</title>
<style>*{box-sizing:border-box}body{margin:0;background:#151a21;color:#e7eef8;font:14px/1.5 system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:30px}h1{font-size:32px;margin:4px 0}p{max-width:1000px;color:#adbbcd}a{color:#8fcaff}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.stat{background:#253246;border:1px solid #3c506c;border-radius:10px;padding:14px 20px;min-width:145px}.stat b{font-size:27px;display:block}.stat span{color:#adbbcd}.toolbar{position:sticky;top:0;background:#1d2632;z-index:2;display:flex;gap:12px;flex-wrap:wrap;align-items:center;padding:14px;border-radius:8px;border:1px solid #3c506c}input,select,button{font:inherit;padding:10px;color:#e7eef8;background:#111923;border:1px solid #52627a;border-radius:5px}input[type=search]{flex:1;min-width:220px}input[type=number]{width:150px}button{cursor:pointer}article{margin:26px 0;background:#1d242e;border:1px solid #3a4656;border-radius:10px;padding:20px;overflow:auto}h2{font-size:21px;margin:0 0 14px}h2 span{font-size:13px;font-weight:400;color:#adbbcd;margin-left:14px}.boards{margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap}.board{max-width:100%;max-height:240px;background:#898f93;border:1px solid #606b78}.thumb{width:94px;height:76px;object-fit:contain;image-rendering:pixelated;background:#898f93;border-radius:4px}table{width:100%;border-collapse:collapse}th{text-align:left;color:#a9bedb;font-size:12px;text-transform:uppercase;letter-spacing:.04em}td,th{padding:12px;border-bottom:1px solid #374252;vertical-align:middle}td:first-child{width:110px}td:last-child{width:150px}small{display:block;font-size:11px;color:#a2b2c7;margin-top:4px}.qty{font-size:25px;font-weight:700}.pdf{display:inline-block;font-size:12px;margin-top:12px}.empty{padding:20px;border:1px dashed #52627a}.sources{border-left:3px solid #78a8d8;padding:8px 16px;margin:24px 0}#shown{color:#adc3df}article[hidden]{display:none}</style></head><body><main>
<h1>Sagrada Família · book one</h1><p>Parts grouped by the booklet's printed steps. Every artwork group was visually reviewed against the printed inventory. Quantities are traced to the original parts boxes shown below.</p>
<div class="stats">"""+''.join(f'<div class="stat"><b>{n:,}</b><span>{label}</span></div>' for n,label in [(v['stepGroups'],'step groups'),(v['bookPieces'],'pieces in parts boxes'),(v['bookPartColorEntries'],'part / colour types'),(v['reviewedArtworkGroups'],'artwork groups reviewed')])+"""</div>
<div class="sources"><p>The step numbers restart three times: 1–111, 1–151, and 1–185. Use the sequence selector to distinguish them. The 20 assembly-only steps are retained with no new parts.</p><p>Counts follow the main parts boxes. The illustrated 2× / 4× subassembly repetitions are already reflected in those boxes and are not multiplied again.</p><p>The two exact printed-part meshes (22385pr0149 and 22385pr0166) are unavailable locally. Their identities and printed artwork are preserved here; no plain-part substitution has been made in this list.</p><p>Your supplied Rebrickable inventory, the live API inventory and the printed set inventory agree on all 514 part/colour entries and 12,060 pieces. All book-one totals fit within those limits. <a href="book1-parts.json">Step-wise JSON</a> · <a href="book1-step-bins.zip">Download 447 LDCad step bins</a> · <a href="book1-parts.pbg">Book-one inventory PBG</a> · <a href="inventory-source.pbg">Source Rebrickable PBG</a></p></div>
<div class="toolbar"><select id="sequence" aria-label="Numbering sequence"><option value="">All sequences</option><option value="1">Sequence 1 · 111 steps</option><option value="2">Sequence 2 · 151 steps</option><option value="3">Sequence 3 · 185 steps</option></select><input id="step" type="number" min="1" placeholder="Printed step" aria-label="Printed step number"><input id="search" type="search" placeholder="Find a part ID, colour, description or element ID" aria-label="Search parts"><button id="reset">Show all</button><span id="shown"></span></div>
<div id="steps">"""+''.join(cards)+"""</div><p id="none" hidden>No matching steps.</p></main>
<script>const sequence=document.getElementById('sequence'),step=document.getElementById('step'),search=document.getElementById('search'),cards=[...document.querySelectorAll('article')];function filter(){let n=0;for(const c of cards){const show=(!sequence.value||c.dataset.sequence===sequence.value)&&(!step.value||Number(c.dataset.step)===Number(step.value))&&(!search.value||c.dataset.search.includes(search.value.trim().toLowerCase()));c.hidden=!show;n+=show}document.getElementById('shown').textContent=n+' of '+cards.length+' steps';document.getElementById('none').hidden=n!==0}for(const input of [sequence,step,search])input.addEventListener('input',filter);document.getElementById('reset').onclick=()=>{sequence.value='';step.value='';search.value='';filter()};filter();window.partsManifestReady=true;</script></body></html>"""
    (out/'index.html').write_text(html)


if __name__=='__main__':main()
