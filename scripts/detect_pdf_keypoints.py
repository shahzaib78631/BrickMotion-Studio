"""Run an experimental detector on every PDF page, retaining original-pixel points."""
from __future__ import annotations
import argparse,hashlib,html,json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2
import numpy as np
import pymupdf
import torch
from brickheadz.keypoint_model import load,predict_image,point_counts


def add_review(report,labels):
    if labels['pdfSHA256']!=report['pdfSHA256'] or labels['dpi']!=report['dpi']:
        raise ValueError('Reviewed labels require the same PDF hash and render DPI')
    totals=[0,0,0];details=[]
    for sample in labels['samples']:
        if not sample.get('reviewed') or not sample['studs_complete']:
            raise ValueError('Subset requires complete reviewed stud labels')
        page=next((p for p in report['pages'] if p['page']==sample['page']),None)
        if page is None:continue
        x0,y0,x1,y1=sample['pageCropPixels']
        points=[[x-x0,y-y0,score] for x,y,score in page['studs'] if x0<=x<x1 and y0<=y<y1]
        tp,fp,fn,_=point_counts(points,sample['studs'])
        totals=[a+b for a,b in zip(totals,[tp,fp,fn])]
        details.append({'id':sample['id'],'tp':tp,'fp':fp,'fn':fn})
    report['reviewedSubset']={'tp':totals[0],'fp':totals[1],'fn':totals[2],
                              'samples':details,'caveat':labels['limitations'],'localizationAccuracyMeasured':False}


def add_steps(report,booklet):
    by_page={s['page']:s['number'] for s in booklet['steps']}
    for page in report['pages']:page['instructionStep']=by_page.get(page['page'])
    report['summary']['instructionPages']=sum(p['instructionStep'] is not None for p in report['pages'])
    report['summary']['instructionPageStudProposals']=sum(p['studCount'] for p in report['pages'] if p['instructionStep'] is not None)


def write_gallery(directory,report):
    cards=[]
    for row in report['pages']:
        label=f"Page {row['page']}"
        if row.get('instructionStep') is not None:label+=f" · Step {row['instructionStep']}"
        label+=f" · {row['studCount']} stud proposals"
        cards.append(f'<a class="page" href="{html.escape(row["overlay"])}"><img loading="lazy" src="{html.escape(row["overlay"])}" alt="{html.escape(label)}"><span>{html.escape(label)}</span></a>')
    summary=report['summary'];review=report.get('reviewedSubset');description=f"Processed {summary['pagesProcessed']} PDF pages. "
    description+='Green crosses are stud proposals. Whole-page counts include callouts, previews and repeated assemblies; they are not inventory counts or an accuracy measurement.'
    review_text=''
    if review:
        review_text=f"<p>Reviewed subset: {review['tp']} correct detections, {review['fp']} extras, {review['fn']} misses. {html.escape(review['caveat'])}</p>"
    style='body{font:16px system-ui;margin:32px;background:#f6f6f4;color:#222}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.page{display:block;background:white;color:inherit;text-decoration:none;padding:8px;border:1px solid #ddd}.page img{width:100%}.page span{display:block;padding:8px}input{padding:10px;margin:16px 0;width:280px}p{max-width:900px;line-height:1.5}[hidden]{display:none!important}'
    script="document.getElementById('filter').oninput=e=>{const q=e.target.value.toLowerCase().trim();document.querySelectorAll('.page').forEach(a=>a.hidden=!!q&&!a.innerText.toLowerCase().includes(q));};"
    (directory/'index.html').write_text(f'<!doctype html><html lang="en"><meta charset="utf-8"><title>PDF stud review</title><style>{style}</style><h1>PDF stud detection review</h1><p>{description}</p>{review_text}<p><a href="report.json">Coordinates, source hashes and model metadata</a></p><label>Filter by page or step <input id="filter" placeholder="e.g. page 124"></label><main>{"".join(cards)}</main><script>{script}</script></html>')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('pdf',type=Path)
    p.add_argument('--checkpoint',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/pilot/best.pt')
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/keypoint-learning/moc-studs')
    p.add_argument('--pages',help='Comma-separated one-based pages; default all pages')
    p.add_argument('--review-labels',type=Path,help='Optional complete reviewed subset, never used for inference')
    p.add_argument('--booklet',type=Path,help='Optional extraction manifest identifying instruction pages')
    p.add_argument('--heads',choices=('studs','both'),default='studs')
    p.add_argument('--dpi',type=int,default=150)
    p.add_argument('--tile-scale',type=float,default=.65)
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    torch.set_num_threads(4);device='mps' if torch.backends.mps.is_available() else 'cpu'
    model,thresholds,metadata=load(args.checkpoint,device)
    doc=pymupdf.open(args.pdf);numbers=[int(v) for v in args.pages.split(',')] if args.pages else list(range(1,len(doc)+1))
    if any(n<1 or n>len(doc) for n in numbers):p.error('page outside PDF')
    report={'pdf':str(args.pdf.resolve()),'pdfSHA256':hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
            'checkpoint':str(args.checkpoint.resolve()),'checkpointSHA256':hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(),
            'modelMetadata':metadata,'dpi':args.dpi,'tileScale':args.tile_scale,'thresholds':thresholds,
            'device':device,'heads':args.heads,'accuracyMeasured':False,
            'caveat':'Unlabelled inference over whole pages, including callouts, previews and repeated assemblies; counts are proposals, not inventory or accuracy.',
            'pages':[]}
    thumbnails=[];started=time.time()
    for n in numbers:
        page=doc[n-1];pix=page.get_pixmap(dpi=args.dpi,colorspace=pymupdf.csRGB,alpha=False)
        rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy()
        detected=predict_image(model,rgb,thresholds,device,tile_scale=args.tile_scale)
        if args.heads=='studs':detected[1]=[]
        row={'page':n,'imageSize':[pix.width,pix.height],'pdfSizePoints':[page.rect.width,page.rect.height],
             'studs':detected[0],'arrow_tips':detected[1],
             'studCount':len(detected[0]),'arrowCount':len(detected[1]),'overlay':f'page-{n:03d}.jpg'}
        report['pages'].append(row)
        overlay=cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR)
        for channel,colour in [(0,(0,180,0)),(1,(180,0,200))]:
            for x,y,score in detected[channel]:
                cv2.drawMarker(overlay,(round(x),round(y)),colour,cv2.MARKER_CROSS,11,2)
        cv2.imwrite(str(args.out/row['overlay']),overlay,[cv2.IMWRITE_JPEG_QUALITY,88])
        thumb=cv2.resize(overlay,(440,round(pix.height*440/pix.width)))
        cv2.putText(thumb,f'p{n}: {len(detected[0])} studs',(8,22),cv2.FONT_HERSHEY_SIMPLEX,.55,(0,0,180),1)
        thumbnails.append(thumb)
        if len(report['pages'])%10==0 or n==numbers[-1]:
            print(json.dumps({'pagesProcessed':len(report['pages']),'total':len(numbers),'seconds':round(time.time()-started,1)}),flush=True)
            (args.out/'report.json').write_text(json.dumps(report,indent=2))
    report['summary']={'pagesProcessed':len(numbers),'pagesWithStudProposals':sum(r['studCount']>0 for r in report['pages']),
                       'studProposals':sum(r['studCount'] for r in report['pages']),'arrowProposals':sum(r['arrowCount'] for r in report['pages']),
                       'seconds':round(time.time()-started,2)}
    if args.review_labels:add_review(report,json.loads(args.review_labels.read_text()))
    if args.booklet:add_steps(report,json.loads(args.booklet.read_text()))
    (args.out/'report.json').write_text(json.dumps(report,indent=2))
    write_gallery(args.out,report)
    # Paginated contact sheets keep all pages inspectable without huge image files.
    for start in range(0,len(thumbnails),24):
        rows=(len(thumbnails[start:start+24])+3)//4;th=thumbnails[0].shape[0]
        sheet=np.full((rows*th,4*440,3),255,np.uint8)
        for i,thumb in enumerate(thumbnails[start:start+24]):sheet[(i//4)*th:(i//4+1)*th,(i%4)*440:(i%4+1)*440]=thumb
        cv2.imwrite(str(args.out/f'contact-{start//24+1:02d}.jpg'),sheet)
    print(json.dumps(report['summary']),flush=True)

if __name__=='__main__':main()
