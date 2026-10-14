import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSession, validateReport } from '../public/core.mjs';
import { validateRevisionInput, initialClarification, validateRevisionResult, acceptDraft } from '../public/revision-core.mjs';
import { revise } from '../lib/rewriter.mjs';

const input = () => ({ session: { pages: [{text:'本周测试8人，仍需核对。'}], segments: [{id:'s1',page:1,text:'本周测试有80人参与。'}], targetSeconds:300 },
  issue: { title:'参与人数需要确认',segmentId:'s1',quote:'本周测试有80人参与',why:'人数不同',suggestion:'先核实人数',action:'clarify',question:'实际是8人还是80人？' }, answers:[] });
const request = data => validateRevisionInput(data || input(), validateSession, validateReport);
test('不采用或否定的建议不能进入改稿；伪造引用不能定位改稿', () => {
  assert.throws(()=>request({...input(),judgment:'incorrect'}),/否定/);
  assert.throws(()=>request({...input(),adoption:'no'}),/不采用/);
  const forged=input();forged.issue.quote='不存在的发言';assert.throws(()=>request(forged),/无法在原文/);
});
test('必要的第一次确认不需要模型；有回答后进入改稿', () => {
  assert.equal(initialClarification(request()).status,'needs_input');
  const answered=input();answered.answers=[{question:'实际是8人还是80人？',answer:'查过记录了，是8人。'}];
  assert.equal(initialClarification(request(answered)),null);
});
test('不把幻灯片数字当作已确认事实，用户确认后可改正', () => {
  const raw={status:'draft',revisedText:'本周测试有8人参与。',reason:'统一已核实的人数'};
  assert.equal(validateRevisionResult(raw,request()).status,'needs_input');
  const answered=input();answered.answers=[{question:'实际是8人还是80人？',answer:'实际为8人。'}];
  assert.equal(validateRevisionResult(raw,request(answered)).status,'draft');
});
test('两轮仍不确定时停止，不无限追问或强行给稿', () => {
  const answered=input();answered.answers=[{question:'多少人？',answer:'不清楚'},{question:'能核对吗？',answer:'暂时不能'}];
  assert.equal(validateRevisionResult({status:'needs_input',question:'到底多少？'},request(answered)).status,'no_change');
  assert.throws(()=>request({...answered,answers:[...answered.answers,{question:'继续',answer:'继续'}]}),/最多/);
});
test('采用只生成讲稿版本，不修改实际发言；旧稿与空稿不能误采用', () => {
  const req=request(), before=structuredClone(req.session);
  const draft={status:'draft',originalText:before.segments[0].text,revisedText:'这周共有80人参加测试。',segmentId:'s1',reason:'口语化'};
  const old={};const scripts=acceptDraft(old,draft,before.segments[0].text,'人数说明','2026-10-09T00:00:00Z');
  assert.deepEqual(req.session,before);assert.deepEqual(old,{});assert.equal(scripts.s1.versions.length,1);
  assert.throws(()=>acceptDraft(old,draft,'已改过的原文','人数说明'),/原发言已变化/);
  assert.throws(()=>acceptDraft(old,{...draft,revisedText:'  '},draft.originalText,'人数说明'),/不能为空/);
});
test('模型收到确认回答和目标段落，输出必须通过改稿校验', async () => {
  const data=input();data.answers=[{question:'实际人数？',answer:'实际8人。'}];let sent;
  const output=await revise(request(data),{key:'test',provider:'deepseek',model:'test'},async(_url,options)=>{
    sent=JSON.parse(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({status:'draft',revisedText:'本周共有8人参加测试。',reason:'采用用户确认的人数'})}}]}));
  });
  assert.equal(sent.confirmedAnswers[0].answer,'实际8人。');assert.equal(sent.targetSegment.id,'s1');assert.equal(output.status,'draft');
});
