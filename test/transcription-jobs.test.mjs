import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptionJobs, transcriptionKey } from '../lib/transcription-jobs.mjs';
const bytes = Buffer.from('synthetic-audio');
const config = { asrModel: 'fun-asr', asrKey: 'secret-not-in-journal' };
const result = { status:'complete', segments:[{text:'测试',start:0,end:2,source:'asr'}] };
async function setup(t, extra={}) {
  const dir = await mkdtemp(join(tmpdir(),'rehearsal-jobs-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls={start:0,poll:0,remove:0,before:0,after:0};
  const options={file:join(dir,'jobs.json'),config,
    start:async(_b,_m,_c,before)=>{await before();calls.start++;return 'provider-1';},
    poll:async()=>{calls.poll++;return result;},
    createVocabulary:async()=> 'owned-vocab',removeVocabulary:async()=>{calls.remove++;return true;},
    beforeSubmit:async()=>{calls.before++;},afterSubmit:()=>{calls.after++;},...extra};
  const jobs=new TranscriptionJobs(options); await jobs.init();
  return {jobs,options,calls};
}
test('相同音频、术语的并发提交只调用一次服务，词序不影响复用',async t=>{
  const {jobs,calls,options}=await setup(t);
  const [a,b]=await Promise.all([jobs.submit(bytes,'audio/webm',['术语','姓名']),jobs.submit(bytes,'audio/webm',['姓名','术语'])]);
  assert.equal(a.id,b.id);assert.equal(calls.start,1);assert.equal(calls.before,1);assert.equal(calls.after,1);assert.equal(b.cacheHit,true);
  const journal=await readFile(options.file,'utf8');assert.ok(!journal.includes(config.asrKey));assert.ok(!journal.includes('synthetic-audio'));
});
test('服务重启恢复原任务，结果落盘后再次重启仍复用，不重新提交',async t=>{
  const {jobs,calls,options}=await setup(t);const submitted=await jobs.submit(bytes,'audio/webm',[]);
  const restarted=new TranscriptionJobs(options);await restarted.init();assert.deepEqual([...restarted.protectedVocabularyIds()],['owned-vocab']);
  const complete=await restarted.get(submitted.id);assert.deepEqual(complete.segments,result.segments);assert.equal(calls.remove,1);
  const again=new TranscriptionJobs(options);await again.init();const cached=await again.submit(bytes,'audio/webm',[]);
  assert.equal(cached.id,submitted.id);assert.equal(cached.status,'complete');assert.equal(calls.start,1);assert.equal(calls.poll,1);
});
test('轮询网络失败不清除任务，不重复提交，并发轮询共享一次请求',async t=>{
  let attempts=0;const {jobs,calls}=await setup(t,{poll:async()=>{attempts++;if(attempts===1)throw new Error('offline');return result;}});
  const {id}=await jobs.submit(bytes,'audio/webm',[]);await assert.rejects(jobs.get(id),/offline/);
  const reused=await jobs.submit(bytes,'audio/webm',[]);assert.equal(reused.status,'pending');
  await Promise.all([jobs.get(id),jobs.get(id)]);assert.equal(attempts,2);assert.equal(calls.start,1);
});
test('付费提交响应丢失被标为未确认；普通点击不重提，明确重试才创建新任务',async t=>{
  let starts=0;const {jobs}=await setup(t,{start:async(_b,_m,_c,before)=>{await before();starts++;throw new Error('lost response');}});
  const uncertain=await jobs.submit(bytes,'audio/webm',[]);assert.equal(uncertain.status,'uncertain');
  assert.equal((await jobs.submit(bytes,'audio/webm',[])).id,uncertain.id);assert.equal(starts,1);
  const retried=await jobs.submit(bytes,'audio/webm',[],{retryId:uncertain.id});assert.notEqual(retried.id,uncertain.id);assert.equal(starts,2);
  await assert.rejects(jobs.submit(bytes,'audio/webm',['变更'],{retryId:retried.id}),/变化/);
});
test('明确拒绝与上传前失败可以重试，清理自身热词表',async t=>{
  const {jobs,calls}=await setup(t,{start:async(_b,_m,_c,before)=>{await before();throw Object.assign(new Error('no permission'),{providerRejected:true,status:403});}});
  const failed=await jobs.submit(bytes,'audio/webm',[]);assert.equal(failed.status,'failed');assert.equal(calls.remove,1);
});
test('崩溃发生在提交标记前后时，恢复分别为失败和未确认',async t=>{
  const {options}=await setup(t);
  await writeFile(options.file,JSON.stringify({version:1,jobs:[false,true].map((started,i)=>({id:`j${i}`,key:`k${i}`,created:1,status:'submitting',providerSubmissionStarted:started}))}));
  const store=new TranscriptionJobs(options);await store.init();assert.equal((await store.get('j0')).status,'failed');assert.equal((await store.get('j1')).status,'uncertain');
});
test('提交意图写入失败时，不调用付费服务',async t=>{
  const {jobs,calls}=await setup(t);jobs.save=async()=>{throw new Error('disk full');};
  await assert.rejects(jobs.submit(bytes,'audio/webm',[]),/disk full/);assert.equal(calls.start,0);assert.equal(calls.after,1);
});
test('服务商接收后保存失败：同进程继续取结果保留原任务，不重交',async t=>{
  const {jobs,calls}=await setup(t);const save=jobs.save.bind(jobs);let writes=0;
  jobs.save=async()=>{if(++writes===4)throw new Error('disk full');return save();};
  let jobId;try{await jobs.submit(bytes,'audio/webm',[]);}catch(e){jobId=e.jobId;assert.ok(jobId);}
  assert.equal((await jobs.get(jobId)).status,'complete');assert.equal(calls.start,1);
});
test('结果保存失败后，再次获取补写结果，重启不丢失',async t=>{
  const {jobs,options,calls}=await setup(t);const {id}=await jobs.submit(bytes,'audio/webm',[]);const save=jobs.save.bind(jobs);let fail=true;
  jobs.save=async()=>{if(fail){fail=false;throw new Error('disk full');}return save();};
  await assert.rejects(jobs.get(id),/disk full/);assert.equal((await jobs.get(id)).status,'complete');
  const reboot=new TranscriptionJobs(options);await reboot.init();assert.equal((await reboot.get(id)).status,'complete');assert.equal(calls.poll,1);
});
test('损坏任务文件拒绝继续，不默默重建并产生重复费用',async t=>{
  const {options}=await setup(t);await writeFile(options.file,'not json');await assert.rejects(new TranscriptionJobs(options).init(),/停止提交/);
});
test('不同模型、音频、术语区分指纹',()=>{
  const key=transcriptionKey(bytes,'audio/webm',['词'],'a');
  assert.notEqual(key,transcriptionKey(bytes,'audio/webm',['词'],'b'));
  assert.notEqual(key,transcriptionKey(Buffer.from('other'),'audio/webm',['词'],'a'));
  assert.notEqual(key,transcriptionKey(bytes,'audio/webm',['另词'],'a'));
});
test('任务终止失败落盘，普通点击只返回失败而不会重新计费',async t=>{
  const {jobs,calls}=await setup(t,{poll:async()=>{throw Object.assign(new Error('audio invalid'),{terminal:true});}});
  const {id}=await jobs.submit(bytes,'audio/webm',[]);assert.equal((await jobs.get(id)).status,'failed');assert.equal((await jobs.submit(bytes,'audio/webm',[])).id,id);assert.equal(calls.start,1);
});
test('外部试用者的任务、缓存和明确重试互相隔离，重启仍保持归属',async t=>{
  const {jobs,calls,options}=await setup(t);
  const a=await jobs.submit(bytes,'audio/webm',[],{owner:'alice'});
  await assert.rejects(jobs.get(a.id,'bob'),{status:404});assert.equal(calls.poll,0);
  await assert.rejects(jobs.submit(bytes,'audio/webm',[],{owner:'bob',retryId:a.id}),{status:409});
  const b=await jobs.submit(bytes,'audio/webm',[],{owner:'bob'});assert.notEqual(a.id,b.id);assert.equal(calls.start,2);
  assert.equal((await jobs.submit(bytes,'audio/webm',[],{owner:'alice'})).id,a.id);assert.equal(calls.start,2);
  const reboot=new TranscriptionJobs(options);await reboot.init();
  await assert.rejects(reboot.get(a.id,'bob'),{status:404});await assert.rejects(reboot.get(a.id),{status:404});
  assert.equal((await reboot.get(a.id,'alice')).status,'complete');
});

test('提交锁出错发生在识别之前：明确标记未提交，修复后同一录音可正常重试',async t=>{
 let broken=true;const {jobs,calls}=await setup(t,{beforeSubmit:async()=>{if(broken)throw new ReferenceError('missing submission lock');}});
 await assert.rejects(jobs.submit(bytes,'audio/webm',[]),e=>e.submissionStarted===false&&e.code==='asr_admission_failed');
 assert.equal(calls.start,0);assert.equal(jobs.jobs.size,0);
 broken=false;const result=await jobs.submit(bytes,'audio/webm',[]);assert.equal(result.status,'pending');assert.equal(calls.start,1);
});

test('两位朋友并发转写，各自完成只释放自己的名额，失败也释放',async t=>{
 const releases=[],pending=[];
 const {jobs}=await setup(t,{beforeSubmit:async owner=>()=>releases.push(owner),start:async(_b,_m,_c,before)=>{await before();return new Promise((resolve,reject)=>pending.push({resolve,reject}));}});
 const a=jobs.submit(bytes,'audio/webm',[],{owner:'alice'}),b=jobs.submit(bytes,'audio/webm',[],{owner:'bob'});
 for(let i=0;i<100&&pending.length<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(pending.length,2);
 pending[1].resolve('provider-b');await b;assert.deepEqual(releases,['bob']);
 pending[0].reject(Object.assign(new Error('provider rejected'),{providerRejected:true,status:400}));await a;assert.deepEqual(releases,['bob','alice']);
});
