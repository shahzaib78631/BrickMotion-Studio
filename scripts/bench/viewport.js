(async()=>{
 const {studio,measure,pose}=aoBench;const r=studio.renderer;let rows=[];
 r.info.autoReset=false;
 for(const config of [{name:'solid'},{name:'solid-static-shadow',freeze:true},{name:'solid-no-ao',ao:false},{name:'solid-no-shadows',shadow:false},{name:'wire',wire:true}]){
  studio.setRenderOptions({wireframe:!!config.wire,ao:config.ao!==false,edges:false});
  r.shadowMap.enabled=config.shadow!==false;r.shadowMap.autoUpdate=!config.freeze;r.shadowMap.needsUpdate=true;
  let info;const timing=await measure(i=>{r.info.reset();pose(.65+i*.01);},12);info={...r.info.render};rows.push({...config,...timing,info});
 }
 r.info.autoReset=true;return rows;
})()
