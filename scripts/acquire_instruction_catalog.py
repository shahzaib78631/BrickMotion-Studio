"""Acquire distinct-set booklets from official LEGO instruction download pages.

HTML is cached; PDF links are read from those pages, never guessed by PDF ID.
One PDF per set, hashes recorded, with size/page limits and bounded concurrency.
"""
from __future__ import annotations
from pathlib import Path
import argparse,concurrent.futures,hashlib,json,re,time,urllib.request,html
ROOT=Path(__file__).resolve().parents[1]
GROUPS={
 'Creator':[31058,31088]+list(range(31100,31180)),
 'Technic':[42093,42095]+list(range(42100,42190)),
 'City':list(range(60300,60390)),
 'Friends':[41439,41440,41441,41442,41443,41444,41445,41446]+list(range(41670,41750)),
 'BrickHeadz':[40271,40272,40273,40274,40348,40349,40350,40351,40352,40353,40354,40367,40377,40378,40379,40380,40381,40383,40384,40385,40386,40387,40412,40416,40417,40420,40421,40422,40425,40442,40443,40454,40456,40457,40458,40460,40461,40462,40463,40465,40466,40476,40477,40479,40480,40481,40482,40483]}
EXCLUDE={31124,42117,60312,42606,40495,40859,41600,76345}


def fetch(url,limit):
    request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(request,timeout=40) as response:
        if int(response.headers.get('Content-Length',0))>limit:raise ValueError('oversize response')
        data=response.read(limit+1)
    if len(data)>limit:raise ValueError('oversize response')
    return data


def acquire(item,root,max_mb,max_pages):
    import pymupdf
    theme,number=item;directory=root/'pdf';directory.mkdir(parents=True,exist_ok=True);html_dir=root/'pages';html_dir.mkdir(exist_ok=True)
    page_url=f'https://www.lego.com/en-us/service/building-instructions/{number}';cached=html_dir/f'{number}.html'
    try:
        if not cached.exists():cached.write_bytes(fetch(page_url,5_000_000))
        text=cached.read_text(errors='replace')
        urls=list(dict.fromkeys(re.findall(r'https://www\.lego\.com/cdn/product-assets/product\.bi\.core\.pdf/\d+\.pdf',text)))
        if not urls:raise ValueError('no official PDF link')
        url=urls[0];identifier=url.rsplit('/',1)[-1][:-4];path=directory/f'{number}-{identifier}.pdf'
        if not path.exists():
            data=fetch(url,max_mb*1024*1024)
            if not data.startswith(b'%PDF'):raise ValueError('not PDF')
            temporary=path.with_suffix('.partial');temporary.write_bytes(data);temporary.replace(path)
        with pymupdf.open(path) as doc:
            pages=len(doc)
            if not 8<=pages<=max_pages:raise ValueError(f'page count {pages} outside range')
            text0=doc[0].get_text()
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        return {'set':str(number),'booklet':identifier,'theme':theme,'sourcePage':page_url,'sourceURL':url,
                'path':str(path.relative_to(ROOT)),'sha256':digest,'pages':pages,'bytes':path.stat().st_size,
                'coverMentionsSet':str(number) in text0,'annotationStatus':'pending'}
    except Exception as error:return {'set':str(number),'theme':theme,'error':str(error)}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/arrow-catalog-100')
    p.add_argument('--target',type=int,default=120);p.add_argument('--workers',type=int,default=5);p.add_argument('--max-mb',type=int,default=40);p.add_argument('--max-pages',type=int,default=180)
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True);manifest=args.out/'catalog.json'
    old=json.loads(manifest.read_text()) if manifest.exists() else {'booklets':[],'errors':[]}
    rows=old['booklets'];errors=old['errors'];known={r['set'] for r in rows};seen={r['sha256'] for r in rows};started=time.time()
    # Round-robin themes keeps the catalog from being dominated by the first range.
    queues={g:[v for v in values if v not in EXCLUDE and str(v) not in known] for g,values in GROUPS.items()}
    items=[]
    while any(queues.values()):
        for group,queue in queues.items():
            if queue:items.append((group,queue.pop(0)))
    def persist():manifest.write_text(json.dumps({'version':1,'policy':'One official PDF per distinct set, exact PDF hashes deduplicated. Whole-set split assigned before annotation/training.','booklets':rows,'errors':errors},indent=2))
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        cursor=0
        while len(rows)<args.target and cursor<len(items):
            batch=items[cursor:cursor+args.workers];cursor+=len(batch)
            for r in pool.map(lambda item:acquire(item,args.out,args.max_mb,args.max_pages),batch):
                if 'error' in r:errors.append(r);continue
                if r['sha256'] in seen:errors.append({'set':r['set'],'error':'duplicate PDF hash'});continue
                index=len(rows);r['split']='test' if index%10==9 else ('validation' if index%10==8 else 'train')
                rows.append(r);seen.add(r['sha256']);known.add(r['set'])
                print(json.dumps({'downloaded':len(rows),'set':r['set'],'booklet':r['booklet'],'theme':r['theme'],'pages':r['pages'],'seconds':round(time.time()-started)}),flush=True)
            persist()
    print(json.dumps({'catalog':str(manifest),'distinctSets':len(rows),'distinctPDFs':len(seen),'errors':len(errors)}),flush=True)
    if len(rows)<args.target:raise SystemExit('Catalog target not reached; manifest retained')

if __name__=='__main__':main()
