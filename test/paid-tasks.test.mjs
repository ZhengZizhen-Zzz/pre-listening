import test from 'node:test';import assert from 'node:assert/strict';import {PaidTasks} from '../lib/paid-tasks.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('后台准备不阻塞主动操作；额度写入串行且最多一个前台和一个后台',async()=>{
 const admitted=[],writes=deferred(),background=deferred(),foreground=deferred();let writing=false;
 const gate=new PaidTasks(async owner=>{assert.equal(writing,false);writing=true;if(owner==='bg')await writes.promise;admitted.push(owner);writing=false;});
 const bg=gate.run(()=>background.promise,'bg',{background:true});const fg=gate.run(()=>foreground.promise,'fg');
 await assert.rejects(()=>gate.run(async()=>{},'another'),e=>e.status===409);
 await assert.rejects(()=>gate.run(async()=>{},'another-bg',{background:true}),e=>e.status===409);
 writes.resolve();await new Promise(r=>setImmediate(r));assert.deepEqual(admitted,['bg','fg']);foreground.resolve('fg');assert.equal(await fg,'fg');assert.equal(gate.background,true);background.resolve('bg');assert.equal(await bg,'bg');
});
test('额度不足不调用模型，失败不会卡住后续任务或绕过额度',async()=>{
 let admitted=0,models=0;const gate=new PaidTasks(async()=>{if(admitted>=1)throw Object.assign(new Error('额度不足'),{status:429});admitted++;});
 await gate.run(async()=>{models++;},'one',{background:true});await assert.rejects(()=>gate.run(async()=>{models++;},'two'),e=>e.status===429);assert.equal(models,1);assert.equal(gate.foreground,false);
});

test('语音提交与后台提问共享额度队列；提交完成后释放前台且重复释放无副作用',async()=>{
 const admissions=[];let releaseBackground;
 const gate=new PaidTasks(async owner=>{admissions.push(owner);});
 const background=gate.run(()=>new Promise(r=>releaseBackground=r),'questions',{background:true});
 const release=await gate.acquire('speech');
 assert.deepEqual(admissions,['questions','speech']);
 await assert.rejects(gate.acquire('another-speech'),{status:409});
 release();
 const next=await gate.acquire('next-speech');release();
 await assert.rejects(gate.acquire('must-still-wait'),{status:409});
 next();releaseBackground();await background;
 await gate.run(async()=>{},'after');
});

test('三位朋友可同时调用，重复点击不计费，释放只影响自己的任务',async()=>{
 let writing=false;const charged=[];
 const gate=new PaidTasks(async owner=>{assert.equal(writing,false);writing=true;await new Promise(r=>setImmediate(r));charged.push(owner);writing=false;},{maxForeground:3});
 const [a,b,c]=await Promise.all(['a','b','c'].map(owner=>gate.acquire(owner)));
 assert.deepEqual(charged,['a','b','c']);await assert.rejects(gate.acquire('a'),{status:409});await assert.rejects(gate.acquire('d'),{status:409});assert.equal(charged.length,3);
 b();const d=await gate.acquire('d');b();await assert.rejects(gate.acquire('e'),{status:409});a();c();d();assert.equal(gate.foreground,false);
});

test('某位朋友额度不足，不释放其他人的调用，不阻塞后续排队的额度写入',async()=>{
 const gate=new PaidTasks(async owner=>{if(owner==='full')throw Object.assign(new Error('额度不足'),{status:429});},{maxForeground:3});
 const a=await gate.acquire('a');await assert.rejects(gate.acquire('full'),{status:429});const b=await gate.acquire('b'),c=await gate.acquire('c');await assert.rejects(gate.acquire('a'),{status:409});a();b();c();assert.equal(gate.foreground,false);
});
