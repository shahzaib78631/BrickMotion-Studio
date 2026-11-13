"""Refresh only the legacy printed element numbers absent from the current set inventory."""
import json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
from booklet_mpd.solver.parts import rebrickable_client
from booklet_mpd.inventory_check import API,to_set_part
out=ROOT/'output/book1-parts';r=json.loads((out/'audit.json').read_text());manual=json.loads((out/'reviewed-identifications.json').read_text())['corrections']
used={manual.get(g['key'],{}).get('element',g['best']['element']) for g in r['groups']}
current=json.loads((ROOT/'.cache/booklet-mpd/rebrickable/21065-1.json').read_text());current_ids={x['element'] for x in current};wanted=sorted(used-current_ids)
p=out/'legacy-catalog-verification.json';records=json.loads(p.read_text()) if p.exists() else {};client=rebrickable_client()
print('Legacy printed elements requiring independent current catalog lookup:',len(wanted),flush=True)
for i,el in enumerate(wanted):
 if el in records:continue
 try:
  row=client._call(f'{API}elements/{el}/');records[el]={'record':{**to_set_part(row),'element':el},'source':f'https://rebrickable.com/api/v3/lego/elements/{el}/','status':'resolved'}
 except Exception as e:records[el]={'status':'lookup-failed','errorType':type(e).__name__}
 p.write_text(json.dumps(records,indent=2));print(i+1,'/',len(wanted),el,records[el]['status'],flush=True);time.sleep(1.1)
