(()=>{
 const studio=aoBench.studio,r=studio.renderer,gl=r.getContext();studio.setRenderOptions({edges:false,linearColors:true,ao:false});studio.render();studio.render();r.info.autoReset=false;
 const capture=()=>{r.info.reset();studio.render();const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return {calls:r.info.render.calls,pixels};};
 const resting=capture();studio.bricks.root.position.x+=1;const moved=capture();const cached=capture();
 studio.bricks.poseVersion++;const forced=capture();
 let maxError=0,differences=0;for(let i=0;i<cached.pixels.length;i++){const d=Math.abs(cached.pixels[i]-forced.pixels[i]);maxError=Math.max(maxError,d);if(d)differences++;}
 const result={restingCalls:resting.calls,movedCalls:moved.calls,cachedCalls:cached.calls,forcedCalls:forced.calls,maxError,differences,meshes:studio.bricks.meshCount()};
 if(moved.calls<=cached.calls||forced.calls<=cached.calls||maxError>0)throw Error(JSON.stringify(result));return result;
})()
