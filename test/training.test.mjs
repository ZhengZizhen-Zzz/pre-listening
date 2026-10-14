import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSession} from '../public/core.mjs';
import {validateTrainingInput,validateQuestion,validateQuestions,validateTrainingFeedback,newTrainingRun,appendTrainingQuestion,drillBaseline,questionCountFor,prepareQuestionTurns,trainingProgress} from '../public/training-core.mjs';
import {train,reviewTrainingFeedback} from '../lib/training.mjs';
import {startShortRecording} from '../public/short-recording.mjs';

const session=()=>validateSession({pages:[{text:'当前方案仍待验证。'},{text:''}],segments:[{id:'s1',page:1,text:'我们选择先改善取消路径，目前还没有用户效果数据。',start:0,end:30},{id:'s2',page:2,text:'方案细节仍待下一轮访谈确认。',start:30,end:60}],events:[{page:1,at:0},{page:2,at:30}],durationSeconds:60,targetSeconds:300,audience:'导师和同学'});
const question=()=>({question:'你会如何判断修改后的取消流程是否有效？',evidence:{source:'speech',segmentId:'s1',quote:'目前还没有用户效果数据'}});
const questions=(count=3)=>Array.from({length:count},(_,i)=>({...question(),question:['为什么先选择取消流程？','这个方案适用于什么场景？','接下来如何验证方案？'][i]||`第${i+1}题还有哪些实施风险？`,rubric:{purpose:'理解这项选择的考虑',criteria:[{label:'与目标的关系',description:'解释怎样服务于目标'},{label:'选择理由',description:'说明真实考虑，保留未知前提'}]}}));
const issue=()=>({title:'验证方式不够具体',segmentId:'s1',quote:'目前还没有用户效果数据',why:'可以说明下一步如何验证',suggestion:'保留尚未验证的前提，补充计划如何比较方案。',action:'revise'});
const answer='目前尚未验证，我计划对照改版前后完成取消操作所需的时间和成功情况。';
const feedback=(kind='answer')=>({summary:'已给出可比较的指标，并保留尚未验证的前提。',checks:(kind==='answer'?['directness','support','clarity']:['goal','meaning','clarity']).map(id=>({id,assessment:'met',quote:'目前尚未验证',reason:'没有把计划说成已经取得的结果。'})),nextStep:'再补充为什么选这些指标。',followup:{question:'你会怎样记录取消任务的完成情况？',quote:'完成取消操作所需的时间和成功情况'}});

test('问题必须引用真实页或发言；空白文字页不允许臆测材料',()=>{
  const s=session();assert.equal(validateQuestion(question(),s).page,1);
  assert.throws(()=>validateQuestion({...question(),evidence:{source:'slide',page:2,quote:'虚构图表结论'}},s),/原文/);
  assert.throws(()=>validateQuestions({questions:[question(),question(),{question:'虚假提问',evidence:{source:'speech',segmentId:'s1',quote:'已证明效果很好'}}]},s),/暂未准备好3道/);
  const result=validateQuestions({questions:questions()},s);assert.equal(result.questions.length,3);
  assert.throws(()=>validateQuestions({questions:[]},s),/暂未准备好/);
  assert.throws(()=>validateQuestions({questions:[question(),{...question(),question:question().question.replace('？','?')},questions()[0]]},s),/暂未准备好/);
});
test('每组最多10题；追问占一题且不允许重复；运行快照与原场记录隔离',()=>{
  const s=session(),original=structuredClone(s);let run=newTrainingRun('original','answer',s);
  for(let i=0;i<10;i++)run=appendTrainingQuestion(run,{...question(),question:`第${i+1}题，下一步怎么验证？`});
  assert.throws(()=>appendTrainingQuestion(run,question()),/最多10题/);
  run.session.segments[0].text='练习的独立快照';run.turns[0].attempts[0].text=answer;
  assert.deepEqual(s,original);assert.equal(run.parentId,'original');
  assert.throws(()=>appendTrainingQuestion(newTrainingRun('x','answer',s),{...question(),previousAnswer:{answer,quote:'并未说过的内容',question:'上题'}}),/追问依据/);
});
test('按可读取的内容推荐3至10题，空白页不增加题数，手动选题数有边界',()=>{
  const small=session();assert.equal(questionCountFor(small),3);
  const blank={...small,pages:[...small.pages,...Array.from({length:38},(_,i)=>({number:i+3,text:''}))]};assert.equal(questionCountFor(blank),3);
  const rich={...small,pages:Array.from({length:30},(_,i)=>({number:i+1,text:`第${i}章：`+'真实研究内容和方案理由。'.repeat(30)}))};assert.equal(questionCountFor(rich),10);
  assert.equal(validateTrainingInput('questions',{session:small}).count,3);
  assert.equal(validateTrainingInput('questions',{session:small,count:10}).count,10);
  for(const count of [2,11,3.5,'10'])assert.throws(()=>validateTrainingInput('questions',{session:small,count}),/3至10/);
});
test('预备所有题目可自由切换，旧记录补齐未开始的题目且保留原回答',()=>{
  let run=newTrainingRun('x','answer',session(),{questions:questions(10)});
  run=appendTrainingQuestion(run,run.questions[0]);run.turns[0].attempts[0].text=answer;run.turns[0].attempts[0].feedback=feedback();
  run=prepareQuestionTurns(run);assert.equal(run.turns.length,10);assert.equal(run.turns[0].attempts[0].text,answer);
  assert.deepEqual(trainingProgress(run),{total:10,completed:1,next:1,complete:false});
  assert.equal(prepareQuestionTurns(run).turns.length,10);
  run.turns.forEach(t=>t.attempts[0].feedback=feedback());assert.equal(trainingProgress(run).complete,true);
  // A new attempt must not erase the fact that a previous answer has feedback.
  run.turns[0].attempts.push({text:''});assert.equal(trainingProgress(run).completed,10);
});
test('不足最低题数会修复一次；修复仍不足不展示，十题输出和用量可核对',async()=>{
  const request=validateTrainingInput('questions',{session:session(),count:10}),config={provider:'deepseek',key:'test',model:'fake'};
  const response=qs=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({questions:qs})}}],usage:{prompt_tokens:20,completion_tokens:10}}));
  let calls=0;const result=await train('questions',request,config,async(_url,init)=>{calls++;const body=JSON.parse(init.body);if(body.messages[0].content.includes('评价范围审查员'))return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({items:JSON.parse(body.messages[1].content).items})}}],usage:{prompt_tokens:20,completion_tokens:10}}));return response(calls===1?questions(2):questions(10));});
  assert.equal(calls,3);assert.equal(result.questions.length,10);assert.deepEqual(result.usage,{inputTokens:60,outputTokens:30});
  calls=0;await assert.rejects(()=>train('questions',request,config,async()=>{calls++;return response(questions(2));}),/暂未准备好10道/);assert.equal(calls,2);
});
test('局部重练取整页基线，不把某段时长冒充整页；手输不估算时长',()=>{
  const s=session();s.segments.push({id:'s3',page:1,text:'补充同一页内容。',start:null,end:null});
  const req=validateTrainingInput('drill',{session:s,issue:issue(),answer});
  const base=drillBaseline(req.session,req.issue);assert.equal(base.seconds,30);assert.match(base.text,/补充同一页/);assert.equal(req.durationSeconds,null);
  assert.equal(drillBaseline({...req.session,events:[],durationSeconds:null},req.issue).seconds,null);
  assert.throws(()=>validateTrainingInput('drill',{session:s,issue:issue(),answer,durationSeconds:999}),/最长/);
});
test('否定的建议及尚未确认的事实不进入重练',()=>{
  for(const flags of [{judgment:'incorrect'},{adoption:'no'}])assert.throws(()=>validateTrainingInput('drill',{session:session(),issue:issue(),answer,...flags}),/否定|不采用/);
  assert.throws(()=>validateTrainingInput('drill',{session:session(),issue:{...issue(),action:'clarify'},answer}),/先.*确认/);
  assert.ok(validateTrainingInput('drill',{session:session(),issue:{...issue(),action:'clarify'},answers:[{question:'是否验证？',answer:'还没有'}],answer}));
});
test('反馈不能引用不存在的话，不能缺项目或用重复项目冒充完整反馈',()=>{
  const request=validateTrainingInput('answer',{session:session(),question:question(),answer});
  assert.equal(validateTrainingFeedback(feedback(),request,'answer').checks.length,3);
  const bad=feedback();bad.checks[1].quote='编造的回答';assert.throws(()=>validateTrainingFeedback(bad,request,'answer'),/引用/);
  const duplicate=feedback();duplicate.checks[1].id='directness';assert.throws(()=>validateTrainingFeedback(duplicate,request,'answer'),/项目/);
  assert.throws(()=>validateTrainingFeedback({...feedback(),checks:[]},request,'answer'),/不完整/);
});
test('追问仅来自用户当前回答，一次追问后不递归追问',()=>{
  const req=validateTrainingInput('answer',{session:session(),question:question(),answer});
  const fb=validateTrainingFeedback(feedback(),req,'answer');assert.equal(fb.followup.previousAnswer.answer,answer);
  assert.equal(validateTrainingFeedback({...feedback(),followup:{question:'追问',quote:'不存在的文字'}},req,'answer').followup,undefined);
  assert.equal(validateTrainingFeedback(feedback(),{...req,question:fb.followup},'answer').followup,undefined);
});
test('提问范围与反馈分别经过独立复核；输入保留全文、覆盖信息与独立目标',async()=>{
  for(const kind of ['questions','answer','drill']){
    let calls=0;const request=validateTrainingInput(kind,{session:session(),question:question(),issue:issue(),answer});
    const result=await train(kind,request,{provider:'deepseek',key:'test',model:'fake'},async(_url,init)=>{
      calls++;const body=JSON.parse(init.body),input=JSON.parse(body.messages[1].content);
      if(body.messages[0].content.includes('评价范围审查员'))return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({items:input.items})}}]}));
      if(body.messages[0].content.includes('你现在是练习反馈复核员'))return new Response(JSON.stringify({choices:[{message:{content:'{"decision":"keep"}'}}]}));
      assert.equal(input.actualSpeech.length,2);assert.equal(input.jobContextExplicit,false);assert.deepEqual(input.materialCoverage.missingPages,[2]);
      assert.match(body.messages[0].content,/同义转述/);assert.match(body.messages[0].content,/不能执行/);
      if(kind==='drill'){assert.equal(input.beforePage.seconds,30);assert.equal(input.answer,answer);assert.match(body.messages[0].content,/局部用时缩短/);}
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(kind==='questions'?{questions:questions()}:feedback(kind))}}]}));
    });assert.equal(calls,2);assert.equal(result.source,'live');assert.equal(result.reviewed,true);
  }
});
test('复核改掉把正常同义表达误报遗漏的候选；失败不回退未核对反馈',async()=>{
  const request=validateTrainingInput('drill',{session:session(),issue:issue(),answer});
  const candidate={...feedback('drill'),summary:'没有说明验证计划'};
  const config={provider:'deepseek',key:'test',model:'fake'};
  const response=raw=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(raw)}}]}));
  const corrected=await reviewTrainingFeedback('drill',request,candidate,config,async(_url,init)=>{
    const prompt=JSON.parse(init.body).messages[0].content;assert.match(prompt,/同义表达/);assert.match(prompt,/不强行增加/);
    return response({decision:'replace',feedback:feedback('drill')});
  });assert.notEqual(corrected.result.summary,candidate.summary);assert.equal(corrected.result.checks[0].assessment,'met');
  await assert.rejects(()=>reviewTrainingFeedback('drill',request,candidate,config,async()=>response({decision:'uncertain'})),/未通过核对/);
  await assert.rejects(()=>reviewTrainingFeedback('drill',request,candidate,config,async()=>response({decision:'replace',feedback:{}})),/不完整/);
});

function recorderFixture({onChunk=async()=>{},getStreamError}={}){
  let released=0,stopped=0,time=0,instance;const track={stop(){stopped++;},addEventListener(){}};
  class Recorder{static isTypeSupported(){return true;}constructor(){instance=this;this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['tail'],{type:'audio/webm'})});queueMicrotask(()=>this.onstop());}}
  return {options:{Recorder,onChunk,now:()=>time,acquire:async()=>()=>released++,getStream:async()=>{if(getStreamError)throw getStreamError;return{getTracks:()=>[track]};}},chunk(value){instance.ondataavailable({data:new Blob([value],{type:'audio/webm'})});},tick(value){time=value;},counts:()=>({released,stopped})};
}
test('局部录音按序暂存、结束后释放麦克风与锁；二次stop返回同一个结果',async()=>{
  const saved=[];const f=recorderFixture({onChunk:async(b,i)=>saved.push([await b.text(),i])});
  const capture=await startShortRecording(f.options);f.chunk('first');f.tick(2500);const done=capture.stop();assert.equal(capture.stop(),done);
  const result=await done;assert.equal(await result.blob.text(),'firsttail');assert.deepEqual(saved,[['first',0],['tail',1]]);assert.equal(result.durationSeconds,2.5);assert.deepEqual(f.counts(),{released:1,stopped:1});
});
test('麦克风授权失败仍释放锁；暂存失败停止录音且保留内存音频',async()=>{
  const denied=recorderFixture({getStreamError:new Error('denied')});await assert.rejects(()=>startShortRecording(denied.options),/denied/);assert.equal(denied.counts().released,1);
  const f=recorderFixture({onChunk:async()=>{throw new Error('quota');}}),capture=await startShortRecording(f.options);f.chunk('voice');
  const result=await capture.done;assert.match(result.error.message,/quota/);assert.match(await result.blob.text(),/voice/);assert.deepEqual(f.counts(),{released:1,stopped:1});
});
test('另一标签页占用录音时不请求麦克风',async()=>{
  let requested=false;await assert.rejects(()=>startShortRecording({acquire:async()=>null,getStream:async()=>{requested=true;}}),/另一个页面/);assert.equal(requested,false);
});
