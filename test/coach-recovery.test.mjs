import test from 'node:test';
import assert from 'node:assert/strict';
import {CoachRuns} from '../lib/coach-runs.mjs';
import {callCoachTool} from '../lib/coach-tools.mjs';
import {automaticCoach} from '../public/automatic-coach.mjs';

const session={pages:[{number:1,text:'研究计划'}],segments:[{id:'s1',page:1,text:'我计划通过访谈了解同学的使用体验，目前还没有开展访谈。'}],events:[{page:1,at:0}],durationSeconds:400,targetSeconds:300,audience:'老师和同学'};
const request={command:'检查表达并给出问题',session};
const plan={status:'ready',actions:['diagnose','questions'],pages:[],targetSeconds:300,questionCount:3,focus:''};
const setup=(options={})=>new CoachRuns({config:{},paidTask:fn=>fn(),connect:async()=>({call:async(name,args)=>callCoachTool(name,args),close(){}}),router:async()=>plan,investigate:async()=>({version:'test',rounds:0,checkedPages:[1],stopReason:'sufficient_evidence',observations:[],timing:callCoachTool('get_timing_summary',{session})}),diagnose:async()=>({summary:'完成',issues:[]}),questions:async()=>({questions:[]}),...options});
const settle=async(runs,r)=>{await runs.runs.get(r.id).pending;return runs.get(r.id,'alice');};

test('引用未通过校验的诊断可主动重试，不把旧结果永久当成成功',async()=>{
 let calls=0;const runs=setup({diagnose:async()=>({issues:[],evidenceRejected:++calls===1?1:0})});
 let r=await settle(runs,runs.createAutomatic({kind:'diagnose',session},'alice'));
 assert.equal(r.status,'partial');assert.equal(r.results.diagnose.evidenceRejected,1);
 r=await settle(runs,runs.start(r.id,'alice',{retry:true}));
 assert.equal(calls,2);assert.equal(r.status,'complete');assert.equal(r.results.diagnose.evidenceRejected,0);assert.deepEqual(r.failures,{});
});

test('浏览器仅在用户再次提交时重试被隐藏的引用，不重复提交付费创建',async()=>{
 const calls=[];const report=await automaticCoach('diagnose',session,{api:async path=>{calls.push(path);return calls.length===1?{id:'r',status:'partial',retries:0,results:{diagnose:{issues:[],evidenceRejected:1}}}:{id:'r',status:'complete',results:{diagnose:{issues:[],evidenceRejected:0}}};}});
 assert.deepEqual(calls,['/api/coach/automatic','/api/coach/r/retry']);assert.equal(report.evidenceRejected,0);
});

test('连续失败后重新安排同一目标只补失败项，双击仍去重',async()=>{
 let diagnoses=0,questions=0,routed=0,checks=0;
 const runs=setup({router:async()=>{routed++;return plan;},investigate:async()=>{checks++;return{version:'test',rounds:0,checkedPages:[1],observations:[],timing:callCoachTool('get_timing_summary',{session})};},diagnose:async()=>{diagnoses++;return{issues:[]};},questions:async()=>{if(++questions<3)throw new Error('temporary outage');return{questions:[]};}});
 let r=await settle(runs,runs.create(request,'alice'));r=await settle(runs,runs.start(r.id,'alice'));r=await settle(runs,runs.start(r.id,'alice',{retry:true}));
 assert.equal(r.status,'partial');assert.equal(r.retries,1);
 const next=runs.create(request,'alice');assert.notEqual(next.id,r.id);assert.equal(next.status,'ready');assert.ok(next.results.diagnose);
 assert.equal(runs.create(request,'alice').id,next.id);
 const done=await settle(runs,runs.start(next.id,'alice'));assert.equal(done.status,'complete');assert.equal(routed,1);assert.equal(checks,1);assert.equal(diagnoses,1);assert.equal(questions,3);
 assert.equal(runs.get(r.id,'alice').status,'partial');assert.throws(()=>runs.get(next.id,'bob'),{status:404});
});

test('自动任务重试耗尽后用户可直接再次发起，无需改原话绕过缓存',async()=>{
 let calls=0;const runs=setup({diagnose:async()=>{if(++calls<3)throw new Error('temporary');return{issues:[]};}});
 let r=await settle(runs,runs.createAutomatic({kind:'diagnose',session},'alice'));r=await settle(runs,runs.start(r.id,'alice',{retry:true}));
 const next=runs.createAutomatic({kind:'diagnose',session},'alice');assert.notEqual(next.id,r.id);assert.equal(runs.createAutomatic({kind:'diagnose',session},'alice').id,next.id);
 assert.equal((await settle(runs,next)).status,'complete');assert.equal(calls,3);
});

test('已有任务执行时，不能启动另一待确认任务或消耗它的重试次数',async()=>{
 let resolve;const pending=new Promise(r=>{resolve=r;});const runs=setup({diagnose:()=>pending});
 const waiting=await settle(runs,runs.create(request,'alice'));
 const failed=await settle(runs,runs.create({...request,command:'其他目标'},'alice'));
 const internal=runs.runs.get(failed.id);internal.status='failed';internal.message='原失败原因';
 const current=runs.createAutomatic({kind:'diagnose',session},'alice');
 try{
  assert.throws(()=>runs.start(waiting.id,'alice'),{status:409});assert.equal(runs.get(waiting.id,'alice').status,'ready');
  assert.throws(()=>runs.start(failed.id,'alice',{retry:true}),{status:409});assert.equal(internal.retries,0);assert.equal(internal.message,'原失败原因');
 }finally{resolve({issues:[]});await settle(runs,current);}
});

test('多次失败后可回收已用完重试的暂存，不被旧失败任务堵住',async()=>{
 const runs=setup({diagnose:async()=>{throw new Error('temporary');}});
 for(let n=0;n<10;n++){
  const r=await settle(runs,runs.createAutomatic({kind:'diagnose',session:{...session,audience:'听众'+n}},'alice'));
  await settle(runs,runs.start(r.id,'alice',{retry:true}));
 }
 assert.equal(runs.runs.size,8);
});
