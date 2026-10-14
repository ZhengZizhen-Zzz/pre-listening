import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MaterialImports} from '../lib/material-imports.mjs';
import {importPresentation,describeMaterialError,importError} from '../public/material-import.mjs';
import {MAX_DECK_BYTES,validateMaterialPages,validateMaterialSize} from '../public/material-limits.mjs';

const bytes=Buffer.from([0x50,0x4b,3,4,1,2,3,4,5,6,7,8]);
async function fixture(t,options={}){
 const directory=await mkdtemp(path.join(tmpdir(),'rehearsal-material-test-'));
 const jobs=new MaterialImports({directory,chunkBytes:8,convert:async(_file,_format,out)=>writeFile(out,'%PDF-fixture'),...options});await jobs.init();
 t.after(async()=>{jobs.close();while(jobs.running)await new Promise(r=>setTimeout(r,2));await jobs.journal;await rm(directory,{recursive:true,force:true});});return jobs;
}
async function upload(jobs,owner='a',requestId=randomUUID()){
 const job=await jobs.create(owner,{size:bytes.length,format:'pptx',requestId});
 await jobs.put(job.id,owner,0,bytes.subarray(0,8));await jobs.put(job.id,owner,1,bytes.subarray(8));return job;
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function done(jobs,id,owner='a'){for(let i=0;i<300;i++){const job=jobs.get(id,owner);if(['complete','failed'].includes(job.state))return job;await new Promise(r=>setTimeout(r,2));}throw new Error('test conversion did not finish');}

test('60 pages and 500 MB share exact inclusive boundaries',()=>{
 assert.doesNotThrow(()=>validateMaterialPages(60));assert.throws(()=>validateMaterialPages(61),/60/);
 assert.doesNotThrow(()=>validateMaterialSize(500*1024**2));assert.equal(MAX_DECK_BYTES,500*1024**2);assert.throws(()=>validateMaterialSize(MAX_DECK_BYTES+1),e=>e.status===413);
});
test('chunk retries preserve bytes, duplicate creation is safe, owners cannot read each other',async t=>{
 const jobs=await fixture(t),requestId=randomUUID();const job=await jobs.create('a',{size:bytes.length,format:'pptx',requestId});
 assert.equal((await jobs.create('a',{size:bytes.length,format:'pptx',requestId})).id,job.id);
 assert.throws(()=>jobs.get(job.id,'b'),e=>e.status===410);assert.throws(()=>jobs.preview('../file','a'),e=>e.status===410);
 await jobs.put(job.id,'a',0,bytes.subarray(0,8));await jobs.put(job.id,'a',0,bytes.subarray(0,8));assert.equal(jobs.get(job.id,'a').received,8);
 await assert.rejects(jobs.put(job.id,'a',0,Buffer.alloc(8)),e=>e.status===409);
 await assert.rejects(jobs.finish(job.id,'a'),e=>e.status===409);
 await jobs.put(job.id,'a',1,bytes.subarray(8));assert.deepEqual(await readFile(jobs.lookup(job.id,'a').input),bytes);
 await jobs.finish(job.id,'a');assert.equal((await done(jobs,job.id)).state,'complete');
 const preview=jobs.preview(job.id,'a');assert.equal((await readFile(preview.file)).toString(),'%PDF-fixture');
 await jobs.cancel(job.id,'a');await assert.rejects(access(preview.file));assert.throws(()=>jobs.get(job.id,'a'),e=>e.status===410);
});
test('simultaneous users queue instead of receiving a conversion-busy rejection; finish is idempotent',async t=>{
 let release;const hold=new Promise(resolve=>release=resolve);let calls=0,active=0,peak=0;
 const jobs=await fixture(t,{convert:async(_f,_e,out)=>{calls++;active++;peak=Math.max(peak,active);if(calls===1)await hold;await writeFile(out,'%PDF-queued');active--;}});
 const a=await upload(jobs,'a'),b=await upload(jobs,'b');await jobs.finish(a.id,'a');await turn();await jobs.finish(b.id,'b');
 assert.equal(jobs.get(b.id,'b').state,'queued');assert.equal(jobs.get(b.id,'b').position,1);await jobs.finish(b.id,'b');release();
 assert.equal((await done(jobs,a.id,'a')).state,'complete');assert.equal((await done(jobs,b.id,'b')).state,'complete');assert.equal(peak,1);assert.equal(calls,2);
});
test('out-of-order chunks are written at fixed offsets; gaps and conflicting retries cannot finish',async t=>{
 const jobs=await fixture(t);const job=await jobs.create('a',{size:bytes.length,format:'pptx',requestId:randomUUID()});
 await jobs.put(job.id,'a',1,bytes.subarray(8));
 await jobs.put(job.id,'a',1,bytes.subarray(8));assert.equal(jobs.get(job.id,'a').received,4);
 await assert.rejects(jobs.finish(job.id,'a'),e=>e.status===409);
 await assert.rejects(jobs.put(job.id,'a',1,Buffer.alloc(4)),e=>e.status===409);
 await jobs.put(job.id,'a',0,bytes.subarray(0,8));assert.deepEqual(await readFile(jobs.lookup(job.id,'a').input),bytes);
 await jobs.finish(job.id,'a');assert.equal((await done(jobs,job.id)).state,'complete');
});
test('diagnostics separate upload, queue and conversion time without exposing document contents',async t=>{
 let clock=0,release,entered;const hold=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const jobs=await fixture(t,{now:()=>clock,convert:async(_f,_e,out)=>{entered();await hold;clock=80;await writeFile(out,'%PDF-timed');}});
 const job=await upload(jobs);clock=20;
 // Simulate another converter occupying the queue.
 jobs.running=true;await jobs.finish(job.id,'a');clock=50;jobs.running=false;void jobs.drain();await started;release();
 assert.equal((await done(jobs,job.id)).state,'complete');
 const event=JSON.parse(await readFile(path.join(jobs.directory,'diagnostics.json'),'utf8')).at(-1);
 assert.equal(event.elapsedMs,80);assert.equal(event.uploadMs,20);assert.equal(event.queueMs,30);assert.equal(event.conversionMs,30);
 await jobs.record({uploadMs:-1,queueMs:Infinity,conversionMs:'private.pptx'});
 const invalid=JSON.parse(await readFile(path.join(jobs.directory,'diagnostics.json'),'utf8')).at(-1);
 for(const key of ['uploadMs','queueMs','conversionMs'])assert.equal(invalid[key],undefined);
});
test('broken input and conversion errors keep actionable diagnostics without names or document contents',async t=>{
 const jobs=await fixture(t,{convert:async()=>{throw Object.assign(new Error('转换超过 5 分钟'),{status:422,code:'conversion_timeout'});}});
 const bad=await jobs.create('a',{size:8,format:'pptx',requestId:randomUUID()});await jobs.put(bad.id,'a',0,Buffer.from('notazip!'));assert.equal((await jobs.finish(bad.id,'a')).code,'invalid_format');
 const valid=await upload(jobs);await jobs.finish(valid.id,'a');assert.equal((await done(jobs,valid.id)).code,'conversion_timeout');
 await jobs.record({stage:'preview',code:'pdf_invalid',format:'pdf',size:20,filename:'private.pptx',text:'secret'});
 await jobs.journal;const journal=await readFile(path.join(jobs.directory,'diagnostics.json'),'utf8');assert.match(journal,/conversion_timeout/);assert.doesNotMatch(journal,/private|secret/);
});
test('abandoned uploads expire and restarted services remove only temporary imports',async t=>{
 let time=0;const jobs=await fixture(t,{now:()=>time,ttl:100});const job=await upload(jobs);time=101;await jobs.sweep();assert.throws(()=>jobs.get(job.id,'a'),e=>e.status===410);
 const later=await upload(jobs);await jobs.record({code:'expired'});const journal=await readFile(path.join(jobs.directory,'diagnostics.json'),'utf8');jobs.close();
 const restarted=new MaterialImports({directory:jobs.directory});await restarted.init();t.after(()=>restarted.close());assert.throws(()=>restarted.get(later.id,'a'),e=>e.status===410);assert.equal(await readFile(path.join(jobs.directory,'diagnostics.json'),'utf8'),journal);
});
test('page rendering diagnostics retain recovery reference and safe categories only',async t=>{
 const jobs=await fixture(t);
 const result=await jobs.record({stage:'render',code:'render_memory',format:'pptx',page:3,pageCount:13,reason:'canvas_allocation',renderer:'legacy-5.6.205',filename:'private.pptx',message:'secret text',stack:'secret stack'});
 const [item]=JSON.parse(await readFile(path.join(jobs.directory,'diagnostics.json'),'utf8'));
 assert.equal(result.reference,item.id.slice(0,8));assert.equal(item.stage,'render');assert.equal(item.code,'render_memory');assert.equal(item.page,3);assert.equal(item.pageCount,13);assert.equal(item.reason,'canvas_allocation');assert.equal(item.renderer,'legacy-5.6.205');assert.doesNotMatch(JSON.stringify(item),/private|secret/);
 await jobs.record({stage:'render',page:61,pageCount:-1,reason:'secret text',renderer:'secret version'});
 const invalid=JSON.parse(await readFile(path.join(jobs.directory,'diagnostics.json'),'utf8')).at(-1);
 for(const field of ['page','pageCount','reason','renderer'])assert.equal(invalid[field],undefined);
});
test('per-user and disk reservations reject excess work before accepting bytes',async t=>{
 const jobs=await fixture(t,{maxJobs:3});await jobs.create('a',{size:8,format:'pptx',requestId:randomUUID()});await jobs.create('a',{size:8,format:'pptx',requestId:randomUUID()});
 await assert.rejects(jobs.create('a',{size:8,format:'pptx',requestId:randomUUID()}),e=>e.status===429);
 await jobs.create('b',{size:8,format:'pptx',requestId:randomUUID()});await assert.rejects(jobs.create('c',{size:8,format:'pptx',requestId:randomUUID()}),e=>e.status===429);
});
test('browser transport retries the same chunk and polls until ready, then removes temporary files',async()=>{
 const file=new Blob([bytes]),calls=[],messages=[];let chunkFailed=false,polls=0;
 const pdf=new Blob(['%PDF-result']);
 const result=await importPresentation(file,'pptx',{token:'test',message:m=>messages.push(m),sleep:async()=>{},request:async(url,options)=>{
  calls.push({url,...options});
  if(url==='/api/materials/imports')return {id:'job',received:0,chunkBytes:8};
  if(url.endsWith('/chunks/0')&&!chunkFailed){chunkFailed=true;throw Object.assign(new Error('network'),{status:0});}
  if(url.includes('/chunks/'))return {};
  if(url.endsWith('/complete'))return {id:'job',state:'queued',position:1};
  if(url.endsWith('/preview'))return pdf;
  if(options.method==='DELETE')return {};
  return {id:'job',state:++polls===1?'converting':'complete'};
 }});
 assert.equal(await result.text(),'%PDF-result');assert.equal(calls.filter(c=>c.url.endsWith('/chunks/0')).length,2);assert.equal(calls.at(-1).method,'DELETE');assert.ok(messages.some(m=>m.includes('排队')));assert.ok(messages.some(m=>m.includes('生成')));
});
test('long conversion polling shows elapsed wait time and distinguishes conversion from upload',async()=>{
 const messages=[];let clock=0,polls=0;
 await importPresentation(new Blob([bytes]),'pptx',{token:'test',message:m=>messages.push(m),now:()=>clock,sleep:async ms=>{clock+=ms;},request:async(url,options)=>{
  if(url==='/api/materials/imports')return {id:'job',chunkBytes:16};
  if(url.includes('/chunks/'))return {};
  if(url.endsWith('/complete'))return {id:'job',state:'queued',position:1};
  if(url.endsWith('/preview'))return new Blob(['%PDF-result']);
  if(options.method==='DELETE')return {};
  return {id:'job',state:++polls<3?'converting':'complete'};
 }});
 assert.ok(messages.some(m=>m.includes('正在排队 · 前方 1 份')));
 assert.ok(messages.some(m=>m.includes('正在转换并生成页面预览 · 已等待 1 秒')));
});
test('nonretryable files fail with their cause, preview errors distinguish passwords and browsers',async()=>{
 let creates=0;
 await assert.rejects(importPresentation(new Blob(['bad']),'pptx',{sleep:async()=>{},request:async()=>{creates++;throw importError(413);}}),e=>e.status===413);assert.equal(creates,1);
 assert.equal(describeMaterialError({name:'PasswordException'}).code,'pdf_password');assert.equal(describeMaterialError({name:'InvalidPDFException'}).code,'pdf_invalid');assert.equal(describeMaterialError({message:'Promise.withResolvers is not a function'}).code,'browser_unsupported');
 assert.match(importError(524).message,/连接不上/);assert.doesNotMatch(importError(524).message,/转换失败/);
});
test('transport overlaps two chunks, waits for both and preserves monotonic progress on retries',async()=>{
 let active=0,peak=0,failed=false;const seen=[],messages=[];
 await importPresentation(new Blob([bytes,bytes]),'pptx',{message:m=>messages.push(m),sleep:async()=>{},request:async(url,options)=>{
   if(url==='/api/materials/imports')return {id:'job',chunkBytes:8};
   if(url.includes('/chunks/')){
     active++;peak=Math.max(peak,active);const index=Number(url.split('/').at(-1));
     options.progress?.({loaded:8});await new Promise(r=>setTimeout(r,index===0?15:2));active--;
     if(index===0&&!failed){failed=true;throw Object.assign(new Error('retry'),{status:0});}
     seen.push(index);return {};
   }
   if(url.endsWith('/complete')){assert.equal(active,0);assert.deepEqual([...seen].sort(),[0,1,2]);return {id:'job',state:'complete'};}
   if(url.endsWith('/preview'))return new Blob(['%PDF-ok']);return {};
 }});
 assert.equal(peak,2);
 const percentages=messages.filter(m=>m.includes('%')).map(m=>Number(m.match(/(\d+)%/)[1]));
 assert.deepEqual(percentages,[...percentages].sort((a,b)=>a-b));
});
test('transport failure drains in-flight chunks before deleting; no conversion starts on partial upload',async()=>{
 let release,active=false;const held=new Promise(r=>release=r),calls=[];
 await assert.rejects(importPresentation(new Blob([bytes,bytes]),'pptx',{request:async(url,options)=>{
   calls.push(url);
   if(url==='/api/materials/imports')return {id:'job',chunkBytes:8};
   if(url.endsWith('/chunks/0')){await new Promise(r=>setImmediate(r));release();throw importError(413);}
   if(url.endsWith('/chunks/1')){active=true;await held;await new Promise(r=>setImmediate(r));active=false;return {};}
   if(options.method==='DELETE'){assert.equal(active,false);return {};}
   throw new Error('unexpected request');
 }}),e=>e.status===413);
 assert.ok(!calls.some(url=>url.endsWith('/complete')||url.endsWith('/chunks/2')));
});

test('cancelled upload drains requests and removes its job without conversion or retry',async()=>{
 const controller=new AbortController(),calls=[];
 await assert.rejects(importPresentation(new Blob([bytes]),'pptx',{
  signal:controller.signal,sleep:async()=>{},request:async(url,options)=>{
   calls.push([url,options.method]);
   if(url==='/api/materials/imports')return {id:'cancel-test',chunkBytes:8};
   if(url.includes('/chunks/')){controller.abort();throw controller.signal.reason;}
   if(options.method==='DELETE')return {};
   throw Error('Unexpected request');
  }
 }),{name:'AbortError'});
 assert.equal(calls.filter(([url])=>url.includes('/chunks/')).length,1);
 assert.equal(calls.some(([url])=>url.endsWith('/complete')),false);
 assert.deepEqual(calls.at(-1),['/api/materials/imports/cancel-test','DELETE']);
});

test('cancelled conversion poll stops before the next request and cleans up',async()=>{
 const controller=new AbortController(),calls=[];
 await assert.rejects(importPresentation(new Blob([bytes]),'pptx',{
  signal:controller.signal,sleep:async()=>controller.abort(),request:async(url,options)=>{
   calls.push([url,options.method]);
   if(url==='/api/materials/imports')return {id:'poll-test',chunkBytes:8};
   if(url.endsWith('/complete'))return {id:'poll-test',state:'converting'};
   return {};
  }
 }),{name:'AbortError'});
 assert.equal(calls.some(([,method])=>method===undefined),false);
 assert.deepEqual(calls.at(-1),['/api/materials/imports/poll-test','DELETE']);
});

test('upload-ready callback permits next transfer before conversion completes; completed preview does not wait for cleanup',async()=>{
 const steps=[];let cleaned=false,finishCleanup;
 const cleanup=new Promise(r=>finishCleanup=r);
 const result=await importPresentation(new Blob([bytes]),'pptx',{
  fast:true,onUploaded:()=>steps.push('uploaded'),sleep:async ms=>steps.push(ms),request:async(url,options)=>{
   if(url==='/api/materials/imports')return {id:'fast-test',chunkBytes:8};
   if(url.includes('/chunks/'))return {};
   if(url.endsWith('/complete'))return {id:'fast-test',state:'converting'};
   if(options.method==='DELETE'){await cleanup;cleaned=true;return {};}
   if(url.endsWith('/preview'))return new Blob(['%PDF-test']);
   steps.push('poll');return {id:'fast-test',state:'complete'};
  }
 });
 assert.deepEqual(steps,['uploaded',350,'poll']);assert.equal(await result.text(),'%PDF-test');
 assert.equal(cleaned,false);finishCleanup();await turn();assert.equal(cleaned,true);
});


test('inline upload retries return the same conversion and reject changed bytes after completion',async t=>{
 let conversions=0;const jobs=await fixture(t,{convert:async(_f,_e,out)=>{conversions++;await writeFile(out,'%PDF-inline');}});
 const options={format:'pptx',requestId:randomUUID()};
 const first=await jobs.receive('a',options,bytes);await jobs.wait(first.id,'a');
 const retry=await jobs.receive('a',options,bytes);assert.equal(retry.id,first.id);assert.equal(conversions,1);
 await assert.rejects(jobs.receive('a',options,Buffer.concat([bytes.subarray(0,8),Buffer.alloc(4)])),e=>e.status===409);
 await assert.rejects(jobs.wait(first.id,'b'),e=>e.status===410);
});
test('bounded preview wait releases listeners on completion, timeout, cancellation and disconnect',async t=>{
 let release;const hold=new Promise(r=>release=r);
 const jobs=await fixture(t,{convert:async(_f,_e,out)=>{await hold;await writeFile(out,'%PDF-wait');}});
 const job=await jobs.receive('a',{format:'pptx',requestId:randomUUID()},bytes);
 const timed=await jobs.wait(job.id,'a',{waitMs:2});assert.ok(['queued','converting'].includes(timed.state));assert.equal(jobs.lookup(job.id,'a').listeners.size,0);
 const controller=new AbortController();const disconnected=jobs.wait(job.id,'a',{signal:controller.signal});controller.abort();await assert.rejects(disconnected,{name:'AbortError'});assert.equal(jobs.lookup(job.id,'a').listeners.size,0);
 const ready=jobs.wait(job.id,'a');release();assert.equal((await ready).state,'complete');assert.equal(jobs.lookup(job.id,'a').listeners.size,0);
 const another=await upload(jobs,'b');const waiting=assert.rejects(jobs.wait(another.id,'b'),e=>e.status===410);await jobs.cancel(another.id,'b');await waiting;
});
test('inline transport displays returned PDF without extra create, poll or download requests',async()=>{
 const calls=[];let uploaded=0;
 const preview=new Blob(['%PDF-fast']);
 const result=await importPresentation(new Blob([bytes]),'pptx',{inline:true,onUploaded:()=>uploaded++,request:async(url,options)=>{
  calls.push([url,options.method]);
  if(options.method==='DELETE')return {};
  assert.equal(url,'/api/materials/imports/inline');assert.equal(options.headers['X-Deck-Format'],'pptx');options.onUploaded();
  return {id:'fast',state:'complete',preview};
 }});
 assert.equal(result,preview);assert.equal(uploaded,1);assert.deepEqual(calls,[['/api/materials/imports/inline','POST'],['/api/materials/imports/fast','DELETE']]);
});
test('slow inline conversion resumes by job ID; a retry uses the same upload request ID',async()=>{
 const calls=[];let attempt=0;
 const result=await importPresentation(new Blob([bytes]),'pptx',{inline:true,sleep:async()=>{},request:async(url,options)=>{
  calls.push([url,options.headers?.['X-Upload-Request-Id']]);
  if(url.endsWith('/inline')){if(attempt++===0)throw Object.assign(new Error('proxy timeout'),{status:504});return {id:'slow',state:'converting'};}
  if(url.endsWith('/ready'))return {id:'slow',state:'complete',preview:new Blob(['%PDF-slow'])};
  if(options.method==='DELETE')return {};
  throw Error('Unexpected round trip');
 }});
 assert.equal(await result.text(),'%PDF-slow');assert.equal(calls[0][1],calls[1][1]);assert.equal(calls.filter(([u])=>u.endsWith('/ready')).length,1);
});
test('inline cancellation before receiving a job ID removes only this owner request',async t=>{
 const jobs=await fixture(t),requestId=randomUUID();const job=await jobs.create('a',{size:bytes.length,format:'pptx',requestId});
 await jobs.cancelRequest(requestId,'b');assert.ok(jobs.get(job.id,'a'));
 await jobs.cancelRequest(requestId,'a');assert.throws(()=>jobs.get(job.id,'a'),e=>e.status===410);
 const controller=new AbortController(),calls=[];
 await assert.rejects(importPresentation(new Blob([bytes]),'pptx',{inline:true,requestId,signal:controller.signal,request:async(url,options)=>{
  calls.push(url);if(options.method==='DELETE')return {};
  controller.abort();throw controller.signal.reason;
 }}),{name:'AbortError'});
 assert.equal(calls.at(-1),'/api/materials/imports/requests/'+requestId);
});


test('larger chunks reduce large-upload requests while existing clients retain their chunk size',async t=>{
 const jobs=await fixture(t);const options={size:bytes.length,format:'pptx',requestId:randomUUID(),chunkBytes:12};
 const job=await jobs.create('a',options);assert.equal(job.chunkBytes,12);
 await jobs.put(job.id,'a',0,bytes);await jobs.finish(job.id,'a');assert.equal((await jobs.wait(job.id,'a')).state,'complete');
 const old=await jobs.create('b',{size:bytes.length,format:'pptx',requestId:randomUUID()});assert.equal(old.chunkBytes,8);
 await assert.rejects(jobs.create('a',{...options,chunkBytes:8}),{status:409});
 await assert.rejects(jobs.create('c',{...options,requestId:randomUUID(),chunkBytes:8*1024**2}),{status:400});
});
test('large-file browser path negotiates 4 MB chunks and receives preview with a bounded wait',async()=>{
 const file=new Blob([new Uint8Array(9*1024**2)]),parts=[];let requested;
 const result=await importPresentation(file,'pptx',{inline:true,request:async(url,options)=>{
  if(url==='/api/materials/imports'){requested=JSON.parse(options.body);return {id:'large',chunkBytes:requested.chunkBytes};}
  if(options.method==='PUT'){parts.push(options.body.size);return {};}
  if(url.endsWith('/complete'))return {id:'large',state:'converting'};
  if(url.endsWith('/ready'))return {id:'large',state:'complete',preview:new Blob(['%PDF-large'])};
  if(options.method==='DELETE')return {};
  throw Error('Unexpected route '+url);
 }});
 assert.equal(requested.chunkBytes,4*1024**2);assert.deepEqual(parts,[4*1024**2,4*1024**2,1024**2]);assert.equal(await result.text(),'%PDF-large');
});
test('legacy notes are read before cleanup and a missing sidecar never discards the preview',async()=>{
 const calls=[],preview=new Blob(['pdf']);let notes;
 const result=await importPresentation(new Blob(['ppt']),'ppt',{inline:true,onNotes:n=>notes=n,request:async(url,o)=>{
  calls.push([url,o.method]);
  if(url.endsWith('/inline'))return {id:'legacy',state:'complete',preview};
  if(url.endsWith('/notes'))return {notes:[{page:1,text:'原备注'}],status:'complete'};
  return {ok:true};
 }});
 assert.equal(result,preview);assert.equal(notes.notes[0].text,'原备注');assert.deepEqual(calls.map(c=>c[0]),['/api/materials/imports/inline','/api/materials/imports/legacy/notes','/api/materials/imports/legacy']);
});
test('notes endpoint uses the same owner isolation as preview and cleans up together',async t=>{
 const jobs=await fixture(t);const job=await upload(jobs);await jobs.finish(job.id,'a');await done(jobs,job.id);
 await assert.rejects(jobs.notes(job.id,'b'),e=>e.status===410);
 const internal=jobs.lookup(job.id,'a');internal.format='ppt';
 assert.equal((await jobs.notes(job.id,'a')).status,'unavailable');
 await writeFile(internal.output+'.notes.json',JSON.stringify({notes:[{page:1,text:'保留备注'}],status:'complete'}));
 assert.equal((await jobs.notes(job.id,'a')).notes[0].text,'保留备注');
 await jobs.cancel(job.id,'a');await assert.rejects(access(internal.output+'.notes.json'));
});
