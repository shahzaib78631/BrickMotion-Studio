from collections import Counter,defaultdict
from pathlib import Path
import zipfile,json,re,sys
FILES=sys.argv[1:]
def get_text(p):
    if p.lower().endswith('.io'):
        with zipfile.ZipFile(p) as f:
            # encryption is standard format from project source, not user password
            z=f.getinfo('model.ldr')
            raw=f.read('model.ldr',pwd=b'soho0909' if z.flag_bits & 1 else None)
            return raw.decode('utf-8-sig',errors='replace'),(z.file_size,z.flag_bits & 1,len(f.infolist()))
    return Path(p).read_text(encoding='utf-8-sig',errors='replace'),None

def report(p):
    text,archive=get_text(p)
    models=defaultdict(list); current='__root__'; root=None
    steps=0; lines=0
    direct=Counter(); numeric_flags=Counter()
    for ln in text.splitlines():
        lines+=1; s=ln.strip();
        if s.upper().startswith('0 FILE '):
            current=s[7:].strip().lower();
            if root is None: root=current
            models[current]
        if s.upper().startswith('0 STEP'): steps+=1
        if s.startswith('1 '):
            t=s.split(maxsplit=14)
            if len(t)>=15:
                name=t[14].lower(); models[current].append(name); direct[name]+=1
            else: numeric_flags['ill_formed']+=1
    if root is None: root='__root__'
    count=0; used=Counter(); missing=Counter(); deepest=0; cycles=0
    def rec(name,depth=0,seen=frozenset()):
        nonlocal count,deepest,cycles
        deepest=max(deepest,depth)
        if name in seen:
            cycles+=1; return
        for ref in models.get(name,[]):
            if ref in models and not ref.endswith(".dat"):
                rec(ref,depth+1,seen|{name})
            else:
                count+=1; used[ref]+=1
                if ' ' in ref: missing[ref]+=1
    rec(root)
    out={'file':Path(p).name,'archive':{'uncompressed_ldr_bytes':archive[0],'encrypted_model':bool(archive[1]),'zip_entries':archive[2]} if archive else None,'source_bytes':len(text.encode('utf-8')),'source_lines':lines,'steps':steps,'submodels':len(models)-1 if '__root__' not in models else len(models)-1,'top_level_refs':len(models[root]),'total_references':sum(map(len,models.values())),'flattened_estimate':count,'unique_library_part_names':len(used),'maximum_submodel_depth':deepest,'cyclic_references':cycles,'most_frequent_parts':used.most_common(5),'nonstandard_piece_refs':missing.most_common(5),'ill_formed_type1_lines':numeric_flags['ill_formed']}
    return out
if not FILES:
    print("usage: python3 tools/perf/model_complexity.py model1.mpd [model2.io ...]", file=sys.stderr)
    raise SystemExit(2)
results=[report(p) for p in FILES]
print(json.dumps(results,indent=2,ensure_ascii=False))
