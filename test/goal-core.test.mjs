import test from 'node:test';import assert from 'node:assert/strict';
import {goalCandidates,firstGoalConfirmation,goalTiming,sameGoalMaterial} from '../public/goal-core.mjs';
const session={pages:[{number:1,text:'背景'},{number:2,text:'方案'}],segments:[{id:'s1',page:1,text:'我们想了解找座困难，找座困难是研究缘起，大家找座位并不方便。'},{id:'s2',page:2,text:'计划访谈五名同学，目前没有开展。计划访谈后再分析，具体分析在访谈之后进行。'}],events:[{page:1,at:0},{page:2,at:230}],durationSeconds:400,targetSeconds:300};
const report={summary:'',issues:[],timePlan:{items:[{page:1,keepQuote:'我们想了解找座困难',cutQuote:'大家找座位并不方便',action:'合并背景说明'},{page:2,keepQuote:'计划访谈五名同学',cutQuote:'具体分析在访谈之后进行',action:'合并重复的顺序说明'}]}};
test('reuse validated existing advice and prioritize its longer page without mutation',()=>{
 const before=JSON.stringify(report);const c=goalCandidates(report,session);assert.equal(c.length,2);assert.equal(c[0].page,1);assert.equal(JSON.stringify(report),before);
});
test('keep a segment chooses another existing page; all protected leaves no candidate',()=>{
 const keep=[{page:1,quote:'大家找座位并不方便',reason:''}];assert.deepEqual(goalCandidates(report,session,keep).map(c=>c.page),[2]);
 keep.push({page:2,quote:'计划访谈五名同学',reason:''});assert.equal(goalCandidates(report,session,keep).length,0);
});
test('stale or fabricated quotes and already adopted segments are not recycled',()=>{
 assert.equal(goalCandidates({...report,timePlan:{items:[{...report.timePlan.items[0],cutQuote:'不存在的引用'}]}},session).length,0);
 assert.deepEqual(goalCandidates(report,session,[],{s1:{text:'已采用'}}).map(c=>c.page),[2]);
 const r={...report,issues:[{segmentId:'s1',quote:'大家找座位并不方便'}]};assert.deepEqual(goalCandidates(r,session,[],{}, {0:{adoption:'no'}}).map(c=>c.page),[2]);
});
test('first-round confirmation needs complete audio and reliable timing; maximum is inclusive',()=>{
 for(const seconds of [280,300])assert.equal(firstGoalConfirmation({session:{...session,durationSeconds:seconds},complete:true,audioId:'a'}),true);
 for(const change of [{complete:false},{audioId:null},{session:{...session,durationSeconds:301}},{session:{...session,durationSeconds:280,events:[]}}])assert.equal(firstGoalConfirmation({session:{...session,durationSeconds:280},complete:true,audioId:'a',...change}),false);
 assert.equal(goalTiming({...session,segments:[{...session.segments[0],page:0}]}).reliable,false);
});
test('different deck cannot inherit a goal',()=>{assert.equal(sameGoalMaterial(session,{...session,pages:[{number:1,text:'另一份材料'}]}),false);});

test('goal diagnostics can supply a targeted edit, but cannot bypass explicit negative feedback',()=>{
 const issue={title:'背景重复',segmentId:'s1',quote:'大家找座位并不方便',why:'重复',suggestion:'精简',action:'revise'};
 const report={summary:'',issues:[issue],goalScoped:true};
 assert.equal(goalCandidates(report,session).length,1);assert.equal(goalCandidates(report,session,[],{}, {0:{judgment:'incorrect'}}).length,0);
});
