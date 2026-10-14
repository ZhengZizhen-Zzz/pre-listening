import test from 'node:test';
import assert from 'node:assert/strict';
import {callCoachTool} from '../lib/coach-tools.mjs';
import {connectCoachTools} from '../lib/coach-mcp-client.mjs';
import {validateCoachPlan,validateCoachRequest} from '../lib/coach-router.mjs';
import {CoachRuns,MAX_COACH_MODEL_CALLS} from '../lib/coach-runs.mjs';

const session={pages:[{number:1,text:'研究目的：了解同学使用自习座位的体验。'},{number:2,text:'研究方法：计划访谈，尚未执行。'}],segments:[{id:'s1',page:1,text:'我想了解同学使用自习座位时遇到了什么问题。'},{id:'s2',page:2,text:'我计划用访谈了解具体经历，目前还没有进行访谈。'}],events:[{page:1,at:0},{page:2,at:100},{page:1,at:350}],durationSeconds:400,targetSeconds:300,audience:'老师和同学'};
const ready=(actions=['timing'],extra={})=>({status:'ready',confidence:.96,actions,pages:[],targetSeconds:300,questionCount:3,...extra});
const request={command:'看看每页用了多久',session};
const setup=(extra={})=>new CoachRuns({config:{},paidTask:fn=>fn(),router:async()=>validateCoachPlan(ready(),session),investigate:async({session})=>({version:'test',rounds:0,stopReason:'sufficient_evidence',checkedPages:[],observations:[],timing:callCoachTool('get_timing_summary',{session})}),...extra});
async function prepare(runs,input=request,owner='alice'){const r=runs.create(input,owner);await runs.runs.get(r.id).pending;return runs.get(r.id,owner);}
async function execute(runs,id,owner='alice'){runs.start(id,owner);await runs.runs.get(id).pending;return runs.get(id,owner);}
test('MCP 工具按回翻累计真实用时，保持总时长',()=>{
  const r=callCoachTool('get_timing_summary',{session});assert.equal(r.reliable,true);assert.deepEqual(r.pages,[{page:1,seconds:150},{page:2,seconds:250}]);assert.equal(r.excessSeconds,100);
});
test('缺少翻页、手工讲稿或未分配页码不伪造逐页时长',()=>{
  for(const change of [{events:[]},{durationSeconds:null},{segments:[{id:'s1',page:0,pageStatus:'unassigned',text:'还没有确定所在页码的实际发言。'}]}]){
    const r=callCoachTool('get_timing_summary',{session:{...session,...change}});assert.equal(r.reliable,false);assert.deepEqual(r.pages,[]);
  }
});
test('MCP 上下文只返回选中页、严格区分发言和材料',()=>{
  const r=callCoachTool('get_page_context',{session,pages:[2]});assert.equal(r.pages.length,1);assert.equal(r.pages[0].number,2);assert.equal(r.speech[0].id,'s2');
  assert.throws(()=>callCoachTool('get_page_context',{session,pages:[3]}));assert.throws(()=>callCoachTool('shell',{session}));assert.throws(()=>callCoachTool('get_timing_summary',{session,path:'/etc/passwd'}));
});
test('真实 MCP stdio 握手、工具发现、调用与错误传播',async()=>{
  const client=await connectCoachTools();try{
    assert.deepEqual(client.tools.map(t=>t.name),['get_page_context','get_timing_summary']);
    assert.equal((await client.call('get_timing_summary',{session})).pages[1].seconds,250);
    await assert.rejects(()=>client.call('get_page_context',{session,pages:[99]}),/页码/);
  }finally{client.close();}
});
test('低置信度、越界页码、题数和目标时长必须先澄清',()=>{
  for(const raw of [ready(undefined,{confidence:.4}),ready(undefined,{pages:[3]}),ready(undefined,{questionCount:20}),ready(undefined,{targetSeconds:20})])assert.equal(validateCoachPlan(raw,session).status,'clarify');
  assert.throws(()=>validateCoachPlan(ready(['delete_files']),session));assert.throws(()=>validateCoachRequest({...request,command:' '}));
});
test('模型不能把未知页或没有发言的页面送去评价',()=>{
  assert.equal(validateCoachPlan(ready(['diagnose'],{pages:[2]}),{...session,segments:[session.segments[0]]}).status,'clarify');
});
test('同一身份重复提交去重，不同身份不能获取、执行或取消任务',async()=>{
  let routed=0;const runs=setup({router:async()=>{routed++;return validateCoachPlan(ready(),session);}});
  const a=await prepare(runs);assert.equal(runs.create(request,'alice').id,a.id);assert.equal(routed,1);
  for(const action of ['get','start','cancel'])assert.throws(()=>runs[action](a.id,'bob'),{status:404});
  assert.notEqual(runs.create(request,'bob').id,a.id);
});
test('确认前没有工具执行，确认后走真实 MCP，重复开始不重做',async()=>{
  let connected=0;const runs=setup({connect:async()=>{connected++;return connectCoachTools();}});
  const r=await prepare(runs);assert.equal(connected,0);const done=await execute(runs,r.id);assert.equal(done.status,'complete');assert.equal(connected,1);assert.equal(done.results.timing.durationSeconds,400);
  runs.start(r.id,'alice');assert.equal(connected,1);assert.equal(done.trace.some(t=>t.kind==='mcp'&&t.tool==='get_timing_summary'&&t.status==='complete'),true);
});
test('缺少计时的压缩任务停止在补充信息，其他提问仍可执行',async()=>{
  let compression=0;const runs=setup({router:async()=>validateCoachPlan(ready(['compress','questions']),session),compress:async()=>{compression++;},questions:async()=>({questions:[]})});
  const r=await prepare(runs,{...request,session:{...session,events:[]}});const done=await execute(runs,r.id);
  assert.equal(compression,0);assert.equal(done.results.compress.status,'needs_input');assert.ok(done.results.questions);assert.equal(done.status,'complete');
});
test('中间步骤失败保留前步结果，重试只执行未完成动作',async()=>{
  let diagnostic=0,questionCalls=0;const runs=setup({router:async()=>validateCoachPlan(ready(['diagnose','questions']),session),diagnose:async()=>{diagnostic++;return {issues:[]};},questions:async()=>{questionCalls++;if(questionCalls===1)throw new Error('network');return {questions:[]};}});
  const r=await prepare(runs);assert.equal((await execute(runs,r.id)).status,'partial');
  runs.start(r.id,'alice',{retry:true});await runs.runs.get(r.id).pending;
  assert.equal(runs.get(r.id,'alice').status,'complete');assert.equal(diagnostic,1);assert.equal(questionCalls,2);
});
test('低置信度计划不能绕过确认直接启动',async()=>{
  const runs=setup({router:async()=>({status:'clarify',message:'想练什么？'})});const r=await prepare(runs);assert.throws(()=>runs.start(r.id,'alice'),/目标确认/);
});
test('模型请求次数有硬上限，未知工具不能执行',async()=>{
  const runs=setup({fetcher:async()=>({ok:true})});const r=await prepare(runs),internal=runs.runs.get(r.id),fetcher=runs.modelFetch(internal);
  for(let n=0;n<MAX_COACH_MODEL_CALLS;n++)await fetcher('https://example.test');await assert.rejects(()=>fetcher('https://example.test'),/上限/);
});
test('取消中的任务不被晚到结果覆盖成成功',async()=>{
  let resolve;const runs=setup({router:()=>new Promise(r=>{resolve=r;})});const r=runs.create(request,'alice');runs.cancel(r.id,'alice');resolve(validateCoachPlan(ready(),session));await runs.runs.get(r.id).pending;assert.equal(runs.get(r.id,'alice').status,'cancelled');
});

 test('首个生成步骤失败时继续执行独立任务，重试只补失败项',async()=>{
  let compressCalls=0,diagnoseCalls=0;
  const runs=setup({router:async()=>validateCoachPlan(ready(['compress','diagnose']),session),compress:async()=>{compressCalls++;if(compressCalls===1)throw new Error('bad quote');return {items:[]};},diagnose:async()=>{diagnoseCalls++;return {issues:[]};}});
  const r=await prepare(runs),done=await execute(runs,r.id);assert.equal(done.status,'partial');assert.ok(done.results.diagnose);assert.ok(done.failures.compress);
  runs.start(r.id,'alice',{retry:true});await runs.runs.get(r.id).pending;
  assert.equal(runs.get(r.id,'alice').status,'complete');assert.equal(diagnoseCalls,1);assert.equal(compressCalls,2);assert.deepEqual(runs.get(r.id,'alice').failures,{});
 });

test('教练的模型调用启用 JSON 输出模式并继续做应用层校验',async()=>{
 const {callTextModel}=await import('../lib/providers.mjs');let body;
 const r=await callTextModel('输出JSON',{}, {provider:'deepseek',key:'fake',model:'test',jsonMode:true},async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{\"ok\":true}'},finish_reason:'stop'}]}));});
 assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(r.raw.ok,true);
});
