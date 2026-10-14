import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSession} from '../public/core.mjs';
import {validateTrainingInput,validateQuestion,validateQuestions,validateTrainingFeedback,feedbackCriteria,previousAnsweredAttempt,newAttempt,newTrainingRun,prepareQuestionTurns} from '../public/training-core.mjs';
import {validateAnswerRevisionResult,practiceFromDraft} from '../public/answer-revision-core.mjs';
import {rewriteAnswer} from '../lib/answer-rewriter.mjs';
import {train,reviewTrainingFeedback,reviewQuestionRubrics} from '../lib/training.mjs';

const session=()=>validateSession({pages:[{text:'我们计划通过访谈研究同学使用自习空间的过程。'}],segments:[{id:'s1',page:1,text:'我选择访谈了解大家使用自习空间的想法。还没有开始招募。',start:0,end:30}],events:[{page:1,at:0}],durationSeconds:30,targetSeconds:300,audience:'导师和同学'});
const question=()=>({question:'为什么选择访谈来研究自习空间？',evidence:{source:'speech',segmentId:'s1',quote:'我选择访谈了解大家使用自习空间的想法'},rubric:{purpose:'理解方法为什么适合你的研究目标',criteria:[{label:'与研究问题的关系',description:'说明访谈可以帮助了解这个研究问题的什么信息'},{label:'实际选择理由',description:'说明自己的选择依据；未验证时可说明尚待验证'}]}});
const answer='因为访谈可以了解大家的想法，所以我选择了访谈。';
const better='我想了解同学选择自习空间时的考虑和取舍，因此计划用访谈听他们描述经历。目前还没有开始招募。';
const baseFeedback=(a=answer)=>({summary:'说明了方法用途，可以补充它与研究目标的联系。',checks:[{id:'point_1',assessment:'partly',quote:a.slice(0,12),reason:'说明了方法的一般用途。'},{id:'point_2',assessment:'partly',quote:a.slice(0,12),reason:'还可以说明实际选择时的考虑。'}],nextStep:'补充你当时想了解什么。'});
const req=(extra={})=>validateTrainingInput('answer',{session:session(),question:question(),answer,...extra});
const response=raw=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(raw)}}],usage:{prompt_tokens:20,completion_tokens:10}}));
const config={provider:'deepseek',key:'test',model:'fake'};
const rewriteReq=(answers=[])=>validateTrainingInput('rewrite',{session:session(),question:question(),answer,feedback:baseFeedback(),answers});

test('新出题必须有独立要点；历史题可继续使用，不静默改变其标准',()=>{
  const q=validateQuestion(question(),session());assert.deepEqual(q.rubric.criteria.map(c=>c.id),['point_1','point_2']);
  assert.equal(feedbackCriteria('answer',q).length,2);
  const old={...question()};delete old.rubric;assert.equal(feedbackCriteria('answer',validateQuestion(old,session())).length,3);
  assert.throws(()=>validateQuestion({...question(),rubric:{...q.rubric,criteria:[q.rubric.criteria[0],q.rubric.criteria[0]]}},session()),/不能重复/);
  assert.throws(()=>validateQuestions({questions:[old,{...old,question:'为什么还没招募？'},{...old,question:'你会访谈哪些场景？'}]},session(),3,true),/暂未准备好/);
  const run=prepareQuestionTurns(newTrainingRun('parent','answer',session(),{questions:[q]}));
  const frozen=structuredClone(run);run.questions[0].rubric.criteria[0].label='修改输入';
  assert.deepEqual(run.turns[0].question.rubric,frozen.turns[0].question.rubric);
});
test('评价必须覆盖本题的全部固定要点，标签由题目提供，不能退回通用三维度',()=>{
  const request=req();const fb=validateTrainingFeedback(baseFeedback(),request,'answer');assert.equal(fb.checks[0].label,'与研究问题的关系');
  assert.throws(()=>validateTrainingFeedback({...baseFeedback(),checks:[...baseFeedback().checks,{id:'clarity',assessment:'met',quote:'访谈可以了解大家',reason:'清晰'}]},request,'answer'),/不完整/);
  assert.throws(()=>validateTrainingFeedback({...baseFeedback(),checks:baseFeedback().checks.map(c=>({...c,id:'directness'}))},request,'answer'),/项目/);
});
test('新追问需要自己的标准，无效可选追问不会隐藏可用反馈',()=>{
  const request=req(),followup={question:'你想听到哪些具体经历？',quote:'访谈可以了解大家的想法'};
  assert.equal(validateTrainingFeedback({...baseFeedback(),followup},request,'answer').followup,undefined);
  const result=validateTrainingFeedback({...baseFeedback(),followup:{...followup,rubric:{purpose:'了解具体想追问的经历',criteria:[{label:'经历范围',description:'说明要听什么经历'},{label:'关联',description:'与研究目标有关'}]}}},request,'answer');
  assert.equal(result.followup.rubric.criteria[0].label,'经历范围');assert.notDeepEqual(result.followup.rubric,request.question.rubric);
});
test('提问标准独立审查可去掉额外任务，保持原问题和证据；缺项不能静默上线',async()=>{
  const q=validateQuestion(question(),session());q.rubric.criteria.push({id:'point_3',label:'对比其他方法',description:'必须说明为什么没选问卷'});
  const result=await reviewQuestionRubrics([q],config,async(_url,init)=>{
    const b=JSON.parse(init.body);assert.match(b.messages[0].content,/不能要求回答招募人数/);
    return response({items:[{index:1,rubric:question().rubric}]});
  });
  assert.equal(result.questions[0].rubric.criteria.length,2);assert.equal(result.questions[0].question,q.question);assert.deepEqual(result.questions[0].evidence,q.evidence);
  await assert.rejects(()=>reviewQuestionRubrics([q],config,async()=>response({items:[]})),/未准备完整/);
});
test('同题比较引用两版原文，变化由相同要点评价计算，无法判断不能冒充进步',()=>{
  const request=req({answer:better,previousAttempt:{answer,feedback:baseFeedback()}}),raw=baseFeedback(better);
  raw.checks[0].assessment='met';raw.checks[1].assessment='uncertain';
  raw.comparison={checks:raw.checks.map(c=>({id:c.id,beforeAssessment:'partly',beforeQuote:'访谈可以了解大家的想法',reason:'本次说明希望了解选择过程。',change:'improved'}))};
  raw.comparison.checks[0].beforeAssessment='not_yet';
  const result=validateTrainingFeedback(raw,request,'answer');assert.equal(result.comparison.checks[0].beforeAssessment,'partly');assert.deepEqual(result.comparison.checks.map(c=>c.change),['improved','uncertain']);
  assert.equal(result.comparison.checks[0].afterQuote,raw.checks[0].quote);
  const fabricated=structuredClone(raw);fabricated.comparison.checks[0].beforeQuote='访谈了十个人';
  assert.throws(()=>validateTrainingFeedback(fabricated,request,'answer'),/上次回答引用/);
  const recovered=validateTrainingFeedback(baseFeedback(better),request,'answer');
  assert.equal(recovered.comparison.checks[0].beforeQuote,request.previousAttempt.feedback.checks[0].quote);
  assert.equal(recovered.comparison.checks[0].reason,recovered.checks[0].reason);
  assert.equal(validateTrainingFeedback(raw,req({answer:better}),'answer').comparison,undefined);
});
test('重练只找本题之前完成反馈的回答，不把未回答或别题当作基线',()=>{
  const first={id:'a',text:answer,feedback:baseFeedback()},pending={id:'b',text:'尚未评价'};
  assert.equal(previousAnsweredAttempt({attempts:[first,pending,{text:better}]},2),first);
  assert.equal(previousAnsweredAttempt({attempts:[pending,{text:better}]},1),null);
  assert.equal(previousAnsweredAttempt({attempts:[first]},0),null);
});
test('模型输入使用本题固定要点，比较与评价共用两次调用，复核可纠正伪进步',async()=>{
  const request=req({answer:better,previousAttempt:{answer,feedback:baseFeedback()}});let calls=0;
  const candidate=baseFeedback(better);candidate.comparison={checks:candidate.checks.map(c=>({id:c.id,beforeAssessment:'not_yet',beforeQuote:'访谈可以了解大家的想法',reason:'更短所以更好。'}))};
  const corrected=structuredClone(candidate);corrected.comparison.checks.forEach(c=>{c.beforeAssessment='partly';c.reason='两版均说明了方法用途，没有必要仅因措辞不同判断进步。';});
  const result=await train('answer',request,config,async(_url,init)=>{
    const b=JSON.parse(init.body),input=JSON.parse(b.messages[1].content);calls++;
    assert.equal(input.criteria[0].id,'point_1');assert.equal(input.previousAttempt.answer,answer);
    return response(calls===1?candidate:{decision:'replace',feedback:corrected});
  });
  assert.equal(calls,2);assert.equal(result.comparison.checks[0].change,'steady');assert.deepEqual(result.usage,{inputTokens:40,outputTokens:20});
  const recovered=await reviewTrainingFeedback('answer',request,result,config,async()=>response({decision:'replace',feedback:baseFeedback(better)}));
  assert.equal(recovered.result.comparison.checks[0].beforeAssessment,'partly');
});
test('回答改写复用确认上限与数字保护，PPT或点评中的数字不作为用户事实',()=>{
  const request=rewriteReq();request.session.pages[0].text+='已经访谈30人。';
  const unsafe={status:'draft',revisedText:'我已访谈30人，所以选择这个方法。',reason:'补充依据'};
  assert.equal(validateAnswerRevisionResult(unsafe,request).status,'needs_input');
  const twice={...request,answers:[{question:'谁？',answer:'同学'},{question:'完成了？',answer:'还没有'}]};
  assert.equal(validateAnswerRevisionResult(unsafe,twice).status,'no_change');
  assert.equal(validateAnswerRevisionResult({status:'needs_input',question:'还有数据吗？',reason:'需要事实'},twice).status,'no_change');
  assert.throws(()=>rewriteReq(Array(3).fill({question:'哪种原因？',answer:'真实考虑'})),/最多/);
  assert.equal(validateAnswerRevisionResult({status:'draft',revisedText:answer,reason:'换词'},request).status,'no_change');
});
test('修改缺少事实时先问；确认不会丢失，草稿不自动覆盖或标记为已练',async()=>{
  let calls=0;const ask=await rewriteAnswer(rewriteReq(),config,async()=>{calls++;return response({status:'needs_input',question:'你当时最想了解什么？',reason:'需要你实际选择的理由'});});
  assert.equal(calls,1);assert.equal(ask.status,'needs_input');
  const request=rewriteReq([{question:ask.question,answer:'同学选择自习空间时的考虑和取舍，还没开始招募'}]);calls=0;
  const result=await rewriteAnswer(request,config,async(_url,init)=>{
    const b=JSON.parse(init.body),input=JSON.parse(b.messages[1].content);assert.equal(input.confirmedAnswers.length,1);
    assert.equal(input.slideMaterial,undefined);assert.equal(input.actualSpeech,undefined);assert.equal(typeof input.question,'string');
    assert.match(b.messages[0].content,/计划|成果/);
    return response(++calls===1?{status:'draft',revisedText:better,reason:'将研究目标和选择理由放在一起，保留未开始的前提。'}:{decision:'keep'});
  });
  assert.equal(calls,2);assert.equal(result.reviewed,true);assert.deepEqual(result.usage,{inputTokens:40,outputTokens:20});
  const original={id:'a',text:answer,feedback:baseFeedback()},copy=structuredClone(original);
  const next=practiceFromDraft(original,result,newAttempt);assert.deepEqual(original,copy);assert.equal(next.text,better);assert.equal(next.feedback,undefined);assert.equal(next.durationSeconds,null);assert.equal(next.basedOnAttemptId,'a');
  assert.throws(()=>practiceFromDraft({...original,text:'原文已变化'},result,newAttempt),/原回答已变化/);
});
test('独立复核能拦下没有新数字的事实编造；失败不回退未核对的稿子',async()=>{
  const request=rewriteReq(),invented={status:'draft',revisedText:'我已经做过访谈，也比较过问卷的效果，所以选择访谈。',reason:'补充选择理由'};
  let calls=0;const repaired=await rewriteAnswer(request,config,async()=>response(++calls===1?invented:{decision:'replace',revision:{status:'needs_input',question:'你当时实际考虑了哪些因素？',reason:'不能假设已经做过比较'}}));
  assert.equal(repaired.status,'needs_input');assert.equal(repaired.revisedText,undefined);
  calls=0;await assert.rejects(()=>rewriteAnswer(request,config,async()=>response(++calls===1?invented:{decision:'uncertain'})),/暂时无法核对/);
});
