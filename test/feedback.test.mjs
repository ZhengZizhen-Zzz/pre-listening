import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FeedbackStore} from '../lib/feedback-store.mjs';
import {normalizeFeedback,FEEDBACK_CONSENT,FEEDBACK_MAX_BYTES} from '../public/feedback-core.mjs';

const sample=()=>({clientId:'record-1',consent:true,consentVersion:FEEDBACK_CONSENT,nickname:'试用者',helpful:'partly',comment:'第二条不准确。',record:{title:'合成反馈测试',demo:false,pages:[{text:'方案与验证'}],segments:[{id:'s1',page:1,text:'我计划先邀请同学试用，尚未开始验证。',start:0,end:20}],events:[{page:1,at:0}],durationSeconds:20,goals:{targetMinutes:5,audience:'同学'},report:{summary:'请说明验证安排。',issues:[{title:'验证安排',page:1,segmentId:'s1',quote:'错误的模型引用也应被保留用于排错',why:'需要更清楚',suggestion:'补充计划'}]},feedback:{0:{judgment:'incorrect',adoption:'no',reason:'模型把计划说成了完成。'}},rewrites:{0:{result:{status:'draft',revisedText:'我计划邀请同学试用。'},acceptedAt:''}},scripts:{},audioAssetId:'private-audio',pdfAssetId:'private-pdf',job:'private-job'},training:[{kind:'answer',createdAt:'2026-10-10T00:00:00Z',session:{secret:'not collected'},turns:[{question:{question:'为什么这样验证？',rubric:{criteria:[{label:'验证目标',description:'说明要验证什么'}]}},attempts:[{text:'我想先发现使用中的障碍。',audioAssetId:'private-audio',jobId:'private-job',feedback:{summary:'说明了目标。',checks:[{label:'验证目标',assessment:'met',quote:'发现使用中的障碍',reason:'目标清晰'}],nextStep:'补充场景'},revision:{result:{status:'draft',revisedText:'先通过试用发现操作障碍。'}}}]}]}]});
async function store(t,options){const directory=await mkdtemp(path.join(tmpdir(),'rehearsal-feedback-'));t.after(()=>rm(directory,{recursive:true,force:true}));return new FeedbackStore(directory,options);}
test('反馈需明确确认范围，拒绝旧版本确认、示例和空白感受',()=>{
  for(const input of [{...sample(),consent:false},{...sample(),consentVersion:'old'},{...sample(),record:{...sample().record,demo:true}},{...sample(),record:null,comment:''}])assert.throws(()=>normalizeFeedback(input),{status:400});
  assert.throws(()=>normalizeFeedback({...sample(),record:{...sample().record,report:{issues:[null]}}}),{status:400});
});
test('保留被用户否定的原建议、改稿与问答，剔除文件引用和转写任务信息',()=>{
  const result=normalizeFeedback(sample()),serialized=JSON.stringify(result);
  assert.equal(result.record.report.issues[0].feedback.judgment,'incorrect');
  assert.equal(result.record.report.issues[0].quote,sample().record.report.issues[0].quote);
  assert.equal(result.training[0].turns[0].attempts[0].revision.revisedText,'先通过试用发现操作障碍。');
  for(const marker of ['private-audio','private-job','private-pdf','not collected'])assert.ok(!serialized.includes(marker));
  const comment=normalizeFeedback({...sample(),record:null});assert.equal(comment.record,null);assert.deepEqual(comment.training,[]);
});
test('保存落盘、权限受限，进程重启后仍能读取完整反馈',async t=>{
  const s=await store(t),receipt=await s.submit('alice',sample()),reboot=new FeedbackStore(s.directory),saved=await reboot.get(receipt.id);
  assert.equal(saved.comment,'第二条不准确。');assert.equal(saved.record.segments[0].text,sample().record.segments[0].text);
  assert.equal((await stat(path.join(s.directory,receipt.id+'.json'))).mode&0o777,0o600);
  assert.equal((await reboot.list())[0].judged,1);
  assert.ok(!(await readFile(path.join(s.directory,receipt.id+'.json'),'utf8')).includes('alice'));
});
test('网络重试幂等，同一演练更新保留提交时间，两个身份不能覆盖彼此',async t=>{
  let now='2026-10-10T00:00:00Z';const s=await store(t,{now:()=>now});
  const results=await Promise.all([s.submit('alice',sample()),s.submit('alice',sample()),s.submit('bob',sample())]);
  assert.equal(results[0].id,results[1].id);assert.equal(results[1].unchanged,true);assert.notEqual(results[0].id,results[2].id);
  now='2026-10-10T01:00:00Z';await s.submit('alice',{...sample(),comment:'补充反馈'});
  assert.equal((await s.get(results[0].id)).revision,2);assert.equal((await s.get(results[0].id)).createdAt,'2026-10-10T00:00:00Z');
  assert.equal((await s.get(results[2].id)).comment,'第二条不准确。');assert.equal((await s.list()).length,2);
});
test('拒绝路径穿越、超大内容和超额新记录，已保存记录仍可更新',async t=>{
  const s=await store(t,{maxEntries:1});await assert.rejects(s.get('../access'),{status:404});
  await assert.rejects(s.submit('alice',{...sample(),comment:'x'.repeat(FEEDBACK_MAX_BYTES+1)}),{status:413});
  await s.submit('alice',sample());await assert.rejects(s.submit('bob',sample()),{status:429});
  await s.submit('alice',{...sample(),comment:'仍可更新'});assert.equal((await s.list()).length,1);
});
test('汇总区分判断、采纳意愿与已采用，未知字段不扩大采集范围',async t=>{
  const s=await store(t),p=sample();p.record.feedback[0]={judgment:'correct',adoption:'yes'};
  const receipt=await s.submit('alice',{...p,ip:'do-not-save',credentials:'do-not-save'}),row=(await s.list())[0];
  assert.equal(row.correct,1);assert.equal(row.willing,1);assert.equal(row.adoptionAnswered,1);
  assert.equal((await s.get(receipt.id)).record.report.issues[0].rewrite.acceptedAt,'');
  assert.ok(!JSON.stringify(await s.get(receipt.id)).includes('do-not-save'));
});
