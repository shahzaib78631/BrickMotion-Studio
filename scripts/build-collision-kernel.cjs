#!/usr/bin/env node
// Prerequisite: rustup target add wasm32-unknown-unknown
const {spawnSync}=require('node:child_process');
const {readFileSync,writeFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const source='src/anim/kernel/collision.rs',binary='src/anim/kernel/collision.wasm';
const flags=['--target','wasm32-unknown-unknown','--crate-type','cdylib','--edition','2021','-O','-C','panic=abort','-C','link-arg=--initial-memory=2097152','-C','link-arg=--max-memory=268435456','-C','link-arg=--export=__heap_base','-C','strip=symbols'];
const result=spawnSync('rustc',[...flags,source,'-o',binary],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync('src/anim/kernel/manifest.json',JSON.stringify({abi:1,sourceSha256:hash(source),binarySha256:hash(binary),compiler:spawnSync('rustc',['--version'],{encoding:'utf8'}).stdout.trim(),flags},null,2)+'\n');
