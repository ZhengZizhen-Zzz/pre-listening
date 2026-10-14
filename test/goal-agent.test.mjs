import test from 'node:test';
import assert from 'node:assert/strict';
import {GoalAgentRuns,validateGoalDecision,validateGoalContext,goalComparison} from '../lib/goal-agent.mjs';
import {callCoachTool} from '../lib/coach-tools.mjs';
import {nextGoalBaseline} from '../public/goal-agent.mjs';
const session={pages:[{number:1,text:'研究背景'},{number:2,text:'研究方法和结论'}],segments:[{id:'s1',page:1,text:'我们关心同学寻找座位的困难，寻找座位确实有困难。'},{id:'s2',page:2,text:'我们计划用访谈了解实际经历，目前还没有开展访谈。'}],events:[{page:1,at:0},{page:2,at:150}],durationSeconds:400,targetSeconds:300,audience:'老师和同学'};
const context={roundId:'round1',audioId:'audio1',complete:true,baseline:null};
const input={command:'保留研究方法和结论',session,context};
const setup=options=>new GoalAgentRuns({config:{},paidTask:fn=>fn(),connect:async()=>({call:async(n,a)=>callCoachTool(n,a),close(){}}),...options});
const wait=async(runs,inputValue=input,owner='alice')=>{const r=runs.create(inputValue,owner);await runs.runs.get(r.id).pending;return runs.get(r.id,owner);};
const decision=(action,message='按这项建议继续练习。',evidence=[])=>({raw:{action,message,evidence}});
const opts=(extra={})=>({session,context,timing:callCoachTool('get_timing_summary',{session}),results:{},...extra});
test('model selects compression, observes validated result then chooses rehearsal',async()=>{
 const observed=[];let count=0;
 const runs=setup({decide:async(p,data)=>{observed.push(data);return decision(count++?'rehearse':'compress');},compress:async()=>({items:[{page:1,action:'合并重复背景'}]}),diagnose:async()=>{throw Error('must not run');}});
 const done=await wait(runs);assert.equal(done.status,'complete');assert.equal(done.results.next.action,'rehearse');assert.ok(observed[1].observations.compress);assert.equal(done.trace.filter(t=>t.kind==='agent').length,2);
});
test('diagnosis containing time plan avoids a second compression call',async()=>{
 let n=0;const runs=setup({decide:async()=>decision(n++?'rehearse':'diagnose'),diagnose:async()=>({issues:[],timePlan:{items:[{page:1}]}}),compress:async()=>{throw Error('duplicate');}});
 const r=await wait(runs);assert.equal(r.status,'complete');assert.ok(r.results.compress);assert.equal(r.trace.filter(t=>t.kind==='model').length,1);
});
test('interrupted recording and missing timing ask for input without model calls',async()=>{
 for(const change of [{context:{...context,complete:false}},{session:{...session,events:[]}}]){
 const runs=setup({decide:()=>{throw Error('must not call');}}),r=await wait(runs,{...input,...change});assert.equal(r.status,'complete');assert.equal(r.results.next.action,'clarify');assert.equal(r.modelCalls,0);
 }});
test('same round edits and resumed audio cannot count as independent rehearsal',()=>{
 for(const c of [{...context,baseline:{...context,session}},{...context,roundId:'round2',baseline:{...context,session}},{...context,audioId:'audio2',baseline:{...context,session}}])assert.equal(goalComparison(c,session).available,false);
});
test('completion requires full recording, actual target and a verbatim quote',()=>{
 const after={...session,durationSeconds:290},c={...context,roundId:'round2',audioId:'audio2',baseline:{...context,session}};
 const valid=opts({session:after,context:c,timing:callCoachTool('get_timing_summary',{session:after})});
 const raw={action:'complete',message:'可以确认',evidence:[{segmentId:'s2',quote:'目前还没有开展访谈'}]};
 assert.equal(validateGoalDecision(raw,valid).action,'confirm');
 for(const v of [opts(),{...valid,context:{...c,complete:false}},{...valid,timing:{...valid.timing,excessSeconds:10}}])assert.throws(()=>validateGoalDecision(raw,v));
 assert.throws(()=>validateGoalDecision({...raw,evidence:[]},valid));
 assert.throws(()=>validateGoalDecision({...raw,evidence:[{segmentId:'s2',quote:'已经访谈了十人'}]},valid));
});
test('unsafe action, arbitrary params, repeated actions and unjustified compression are blocked',()=>{
 for(const raw of [{action:'shell',message:'run'},{action:'diagnose',message:'ok',path:'/tmp/a'}])assert.throws(()=>validateGoalDecision(raw,opts()));
 assert.throws(()=>validateGoalDecision({action:'diagnose',message:'ok'},opts({results:{diagnose:{}}})));
 assert.throws(()=>validateGoalDecision({action:'compress',message:'ok'},opts({timing:{reliable:true,excessSeconds:0}})));
});
test('changed deck rejects baseline; same round preserves original baseline on edits',()=>{
 assert.throws(()=>validateGoalContext({...context,baseline:{...context,session:{...session,pages:[{number:1,text:'different'}]}}},session));
 const previous={...context,session},record={current:previous,baseline:{marker:true}};
 assert.deepEqual(nextGoalBaseline(record,{...previous}),record.baseline);
 assert.deepEqual(nextGoalBaseline(record,{roundId:'round2'}),previous);
});
test('owner isolation and identical requests deduplicate; different rounds do not',async()=>{
 const runs=setup({decide:async()=>decision('rehearse')}),a=await wait(runs);assert.equal(runs.create(input,'alice').id,a.id);
 for(const method of ['get','cancel'])assert.throws(()=>runs[method](a.id,'bob'),{status:404});
 const b=await wait(runs,{...input,context:{...context,roundId:'round2',audioId:'audio2',baseline:{...context,session}}});assert.notEqual(a.id,b.id);
});
test('failed follow-up preserves generated results and retry does not regenerate',async()=>{
 let n=0,calls=0;const runs=setup({decide:async()=>{if(n++===0)return decision('compress');if(n===2)throw Error('network');return decision('rehearse');},compress:async()=>{calls++;return {items:[]};}});
 const r=await wait(runs);assert.equal(r.status,'failed');assert.ok(r.results.compress);
 runs.start(r.id,'alice',{retry:true});await runs.runs.get(r.id).pending;assert.equal(runs.get(r.id,'alice').status,'complete');assert.equal(calls,1);
});
test('cancellation discards late model results',async()=>{
 let release;const runs=setup({decide:()=>new Promise(r=>release=r)}),r=runs.create(input,'alice');
 while(!release)await new Promise(r=>setTimeout(r,1));runs.cancel(r.id,'alice');release(decision('rehearse'));await runs.runs.get(r.id).pending;
 assert.equal(runs.get(r.id,'alice').status,'cancelled');assert.equal(runs.get(r.id,'alice').results.next,undefined);
});
test('model can ask a single clarification instead of generating edits',async()=>{
 const r=await wait(setup({decide:async()=>decision('clarify','研究方法中哪一个步骤必须保留？')}));assert.equal(r.results.next.action,'clarify');assert.equal(r.trace.filter(t=>t.kind==='model').length,0);
});
test('shorter new recording can trigger correction instead of completion',async()=>{
 let n=0;const runs=setup({decide:async()=>decision(n++?'rehearse':'diagnose'),diagnose:async()=>({issues:[]})});
 const r=await wait(runs,{...input,session:{...session,durationSeconds:290},context:{...context,roundId:'round2',audioId:'audio2',baseline:{...context,session}}});
 assert.equal(r.results.comparison.deltaSeconds,-110);assert.equal(r.results.next.action,'rehearse');assert.ok(r.results.diagnose);
});
test('changed audience or unreliable baseline cannot verify the goal',()=>{
 const c={...context,roundId:'round2',audioId:'audio2',baseline:{...context,session}};
 assert.equal(goalComparison(c,{...session,audience:'评审专家'}).available,false);
 assert.equal(goalComparison({...c,baseline:{...c.baseline,session:{...session,events:[]}}},session).available,false);
});
test('compression advice enters existing editable script workflow with real speech evidence',async()=>{
 const {compressionReview}=await import('../lib/goal-agent.mjs');
 const report=compressionReview({items:[{page:1,cutQuote:'寻找座位确实有困难',action:'合并重复背景'}]},session);
 assert.equal(report.source,'goal_plan');assert.equal(report.issues[0].segmentId,'s1');assert.equal(report.issues[0].action,'revise');
 assert.equal(compressionReview({items:[{page:1,cutQuote:'虚构不存在的原话',action:'删掉'}]},session),null);
});
test('time is a maximum: model must not ask user to pad 280 seconds to 300',()=>{
 const after={...session,durationSeconds:280},c={...context,roundId:'round2',audioId:'audio2',baseline:{...context,session}};
 const raw={action:'rehearse',message:'当前280秒，距300秒目标还差一点，适当放慢语速。',evidence:[{segmentId:'s2',quote:'目前还没有开展访谈'}]};
 const r=validateGoalDecision(raw,opts({session:after,context:c,timing:callCoachTool('get_timing_summary',{session:after})}));
 assert.equal(r.action,'confirm');assert.match(r.message,/无需凑满/);
});

test('first complete recording can confirm without inventing a comparison',()=>{
 const current={...session,durationSeconds:280};
 const r=validateGoalDecision({action:'complete',message:'请确认重点',evidence:[{segmentId:'s2',quote:'目前还没有开展访谈'}]},opts({session:current,timing:callCoachTool('get_timing_summary',{session:current})}));
 assert.equal(r.action,'confirm');assert.equal(goalComparison(context,current).available,false);
 assert.throws(()=>validateGoalDecision({action:'complete',message:'完成',evidence:[{segmentId:'s2',quote:'目前还没有开展访谈'}]},opts({session:current,context:{...context,audioId:null},timing:callCoachTool('get_timing_summary',{session:current})})));
});
test('validated compression returns immediately without another planning model call',async()=>{
 let count=0;
 const runs=setup({decide:async()=>{count++;return decision('compress');},compress:async()=>({items:[{page:1,keepQuote:'我们关心同学寻找座位的困难',cutQuote:'寻找座位确实有困难',action:'合并重复背景'}]})});
 const r=await wait(runs);assert.equal(r.status,'complete');assert.equal(count,1);assert.equal(r.results.next.action,'rehearse');
});
test('protected speech is supplied to decisions and tools; rejected suggestions cannot reappear',async()=>{
 let observed,toolInput;
 const protectedSpeech=[{page:1,quote:'寻找座位确实有困难',reason:'老师要求完整保留'}];
 const runs=setup({decide:async(_,input)=>{observed=input;return decision('compress');},compress:async input=>{toolInput=input;return {items:[{page:1,keepQuote:'我们关心同学寻找座位的困难',cutQuote:'寻找座位确实有困难',action:'删掉这句'}]};}});
 const r=await wait(runs,{...input,context:{...context,protectedSpeech}});
 assert.deepEqual(observed.goal.protectedSpeech,protectedSpeech);assert.match(toolInput.coachFocus.command,/老师要求完整保留/);
 assert.equal(r.status,'complete');assert.equal(r.results.next.action,'clarify');assert.equal(r.results.compress.items.length,0);assert.ok(!r.results.editableReview);
});
test('protection changes task identity and cannot reuse rejected run',async()=>{
 const runs=setup({decide:async()=>decision('clarify','请补充取舍')});
 const a=await wait(runs),b=await wait(runs,{...input,context:{...context,protectedSpeech:[{page:1,quote:'寻找座位确实有困难',reason:''}]}});
 assert.notEqual(a.id,b.id);
 assert.throws(()=>validateGoalContext({...context,protectedSpeech:[{page:999,quote:'保留这个部分',reason:''}]},session));
});

test('goal-scoped diagnosis remains actionable when time is already within limit',async()=>{
 const issue={title:'研究计划还没讲清',segmentId:'s2',quote:'目前还没有开展访谈',why:'需讲清下一步安排',suggestion:'保留未开展状态，讲清计划',action:'revise'};
 const runs=setup({decide:async()=>decision('diagnose'),diagnose:async()=>({summary:'需要调整',issues:[issue]})});
 const r=await wait(runs,{...input,session:{...session,durationSeconds:280}});assert.equal(r.status,'complete');assert.equal(r.results.next.action,'rehearse');assert.equal(r.trace.filter(t=>t.kind==='agent').length,1);
});
