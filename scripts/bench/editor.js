(async()=>{
 const [{viewportApi},{useStudio},{useAppSettings},{readStudioIo},{importLDraw},parts,{FrameGate}]=await Promise.all([
  import('/src/ui/viewportApi.ts'),import('/src/state/store.ts'),import('/src/state/appSettings.ts'),import('/src/io/studioIo.ts'),import('/src/io/ldrawImport.ts'),import('/src/state/partService.ts'),import('/src/render/frameGate.ts')]);
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 useStudio.setState({workspace:'build',mode:'edit',currentStep:null});
 const response=await fetch('/.cache/ao-bench/diner.io');const plan=importLDraw(await readStudioIo(await response.arrayBuffer()),'diner.io');
 parts.registerInlineParts(plan.parts);const ids=new Set();for(const step of [...plan.steps,...Object.values(plan.submodels??{}).flatMap(s=>s.steps)])for(const i of step.pieces)if('part'in i)ids.add(i.part);await parts.ensureParts([...ids]);
 useStudio.getState().setPlan(plan,{resetHistory:true});
 const studio=viewportApi.studio;await sleep(3000);viewportApi.fit();await studio.ready();await sleep(2000);
 let renders=0,submit=0;const original=studio.render;studio.render=(...args)=>{const t=performance.now();renders++;original(...args);submit+=performance.now()-t;};
 const measure=async name=>{renders=0;submit=0;const start=performance.now();await sleep(3000);return{name,ms:performance.now()-start,renders,cpuSubmissionMs:submit};};
 const rows=[];rows.push(await measure('idle'));
 const should=FrameGate.prototype.shouldRender;FrameGate.prototype.shouldRender=()=>true;rows.push(await measure('forced-continuous'));FrameGate.prototype.shouldRender=should;
 const before=renders;viewportApi.controls.target.x+=.1;viewportApi.controls.update();await sleep(50);rows.push({name:'camera-change',rendered:renders>before});
 studio.render=original;Object.assign(__aoBench,{results:rows,meshes:studio.bricks.meshCount(),name:plan.name});return __aoBench;
})()
