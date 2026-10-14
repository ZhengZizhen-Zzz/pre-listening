import test from 'node:test';
import assert from 'node:assert/strict';
import {contextualAdvice,contextualReport,hasJobContext,timeBudget,validateTimePlan} from '../public/coaching-core.mjs';
import {makeTimePlan} from '../lib/time-coach.mjs';
import {analyze,getConfig} from '../lib/providers.mjs';
import {readableReport} from '../public/report-export.mjs';
const session=()=>({pages:[{number:1,text:''},{number:2,text:''},{number:3,text:''}],segments:[{id:'s1',page:1,text:'这是主要发现。下面再列出所有能力名称。'},{id:'s2',page:2,text:'我的具体贡献是模型检验。接下来又重复前面的过程。'},{id:'s3',page:3,text:'以上是总结。'}],events:[{page:1,at:0},{page:2,at:70},{page:3,at:140}],durationSeconds:160,targetSeconds:120,audience:'老师和同学',takeaways:''});
const plan=()=>({items:[{page:1,keepQuote:'这是主要发现',cutQuote:'下面再列出所有能力名称',action:'保留主要发现，合并能力名称罗列。'},{page:2,keepQuote:'我的具体贡献是模型检验',cutQuote:'接下来又重复前面的过程',action:'保留个人贡献，省去重复过程。'}]});
test('个人经历和能力不自动等于求职，否定求职时也用中性场景',()=>{
 assert.equal(hasJobContext(session()),false);assert.equal(hasJobContext({...session(),audience:'面试官'}),true);assert.equal(hasJobContext({...session(),takeaways:'不是求职汇报'}),false);
 const old={summary:'展示成长',nextStep:'保留与目标岗位最相关的3项能力',issues:[{quote:'原发言里说目标岗位',suggestion:'保留与目标岗位最相关的3项能力'}]};
 const corrected=contextualReport(old,session());assert.match(corrected.nextStep,/听众/);assert.equal(corrected.issues[0].quote,old.issues[0].quote);assert.match(old.nextStep,/岗位/);
 assert.equal(contextualAdvice('目标岗位',{audience:'面试官'}),'目标岗位');
});
test('没有计时或没有超时不臆造压缩目标；实际超时生成总预算',()=>{
 assert.equal(timeBudget({...session(),durationSeconds:null}),null);assert.equal(timeBudget({...session(),durationSeconds:100}),null);assert.equal(timeBudget({...session(),events:[]}),null);assert.equal(timeBudget(session()).excessSeconds,40);
 const result=validateTimePlan(plan(),session());assert.equal(result.items.reduce((n,p)=>n+p.saveSeconds,0),40);assert.equal(result.remainingSeconds,0);assert.ok(result.items.every(p=>p.targetSeconds>0));
});
test('不伪造页码和保留/删减引用，不把压缩目标冒充实际效果',()=>{
 const fake=plan();fake.items[0].cutQuote='根本不存在的发言';assert.throws(()=>validateTimePlan(fake,session()),/原发言/);
 const duplicate=plan();duplicate.items[1]=duplicate.items[0];assert.throws(()=>validateTimePlan(duplicate,session()));
 const short=validateTimePlan({items:[{page:3,keepQuote:'以上是总结',cutQuote:'以上是总结',action:'试着缩短结尾。'}]},session());assert.ok(short.remainingSeconds>0);assert.match(short.note,/不是预计节省/);
});
test('超时计划走单次模型调用，输入保留全场发言和实际用时',async()=>{
 let count=0;const result=await makeTimePlan(session(),{key:'test',provider:'deepseek',model:'fake'},async(url,init)=>{
 count++;const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.equal(input.jobContextExplicit,false);assert.equal(input.actualSpeech.length,3);assert.equal(input.timeBudget.excessSeconds,40);
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(plan())}}]}));
 });assert.equal(count,1);assert.equal(result.items.length,2);
});
test('导出复盘包含压缩动作和试讲目标',()=>{
 const text=readableReport({title:'合成材料',goals:{audience:'同学',targetMinutes:2},pages:session().pages,segments:session().segments,report:{summary:'总结',issues:[],timePlan:validateTimePlan(plan(),session())}});
 assert.match(text,/超时压缩计划/);assert.match(text,/试讲目标/);assert.match(text,/省去重复过程/);
});
test('完整分析在原有请求中生成超时计划，证据复核不丢失计划；计划失败不丢失有用建议',async()=>{
 for (const valid of [true,false]) {
  let calls=0;
  const result=await analyze(session(),getConfig({DEEPSEEK_API_KEY:'test'}),async(url,init)=>{
   calls++;const prompt=JSON.parse(init.body).messages[0].content;
   const raw=prompt.includes('证据复核员')?{decisions:[{index:0,reason:'expression_issue'}]}:{summary:'可以压缩罗列',issues:[{title:'重复罗列',segmentId:'s1',quote:'下面再列出所有能力名称',why:'影响重点',suggestion:'省去重复罗列',action:'revise'}],timePlan:valid?plan():{items:[]}};
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(raw)}}]}));
  });
  assert.equal(calls,2);assert.equal(result.issues.length,1);
  if(valid)assert.equal(result.timePlan.allocatedSeconds,40);else assert.match(result.timePlanError,/引用未核对完整/);
 }
});
test('六条不同问题可保留；建议说法不添数字，超时压缩不能越改越长',async()=>{
 const input={...session(),segments:Array.from({length:6},(_,i)=>({id:`s${i+1}`,page:1,text:`第${i+1}项发言说明。这部分反复强调相同的信息。`}))};
 const issues=input.segments.map((part,i)=>({segmentId:part.id,quote:part.text,title:`重复表达${i+1}`,why:'重点被重复内容分散',suggestion:'合并重复表达',action:'revise',draft:{revisedText:i===1?'参与人数增加到999人。':i===2?part.text.repeat(2):`第${i+1}项发言说明。`,reason:'合并重复表达'}}));
 const result=await analyze(input,getConfig({DEEPSEEK_API_KEY:'test'}),async(url,init)=>{
  const audit=JSON.parse(init.body).messages[0].content.includes('证据复核员');
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(audit?{decisions:issues.map((_,index)=>({index,reason:'expression_issue'}))}:{summary:'重点可以更清楚',issues})}}]}));
 });
 assert.equal(result.issues.length,6);assert.equal(result.pipeline.generated,6);assert.ok(result.issues[0].draft);assert.equal(result.issues[1].draft,undefined);assert.equal(result.issues[2].draft,undefined);
});
