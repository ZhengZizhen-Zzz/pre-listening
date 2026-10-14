import test from 'node:test';
import assert from 'node:assert/strict';
import {alignSegments,validateSession,validateReport,hasPageTimeline} from '../public/core.mjs';
import {groupTranscript,editPageTranscript,assignTranscriptPage,compileScriptPages} from '../public/transcript-core.mjs';
import {completeCoachingReport,speechSufficiency} from '../public/coaching-feedback.mjs';
import {timeBudget} from '../public/coaching-core.mjs';
import {compareRounds} from '../public/comparison-core.mjs';
import {analyze,getConfig} from '../lib/providers.mjs';
import {readableReport} from '../public/report-export.mjs';
import {normalizeFeedback,FEEDBACK_CONSENT} from '../public/feedback-core.mjs';
const pages=[{number:1,text:'个人简介、个性标签、实践经历、竞选优势。参加运动会、合唱和辩论赛。'},{number:2,text:'方法与结果'}];
const parts=[{id:'s1',text:'我感觉这件事挺有意思的，反正差不多就这样吧。',start:0,end:8,source:'asr'},{id:'s2',text:'先说到这里，后面我还没准备。',start:9,end:16,source:'asr'}];
const session=()=>validateSession({pages,segments:alignSegments(parts,[{page:1,at:0}],2),events:[{page:1,at:0}],durationSeconds:18,targetSeconds:180,audience:'老师和同学'});
const empty={summary:'暂未发现问题',issues:[],strengths:[],nextStep:'可以保留当前表达'};

test('多页材料无翻页记录不默认第一页，单页和可靠翻页仍按时间定位',()=>{
 for(const events of [[],[{page:1,at:0}],[{page:2,at:0}],[{page:1,at:0},{page:1,at:10}]]){
  const r=alignSegments(parts,events,2);assert.ok(r.every(s=>s.page===0&&s.pageStatus==='unassigned'));assert.deepEqual(r.map(s=>s.text),parts.map(s=>s.text));
 }
 assert.deepEqual(alignSegments(parts,[{page:2,at:0},{page:1,at:9}],2).map(s=>s.page),[2,1]);
 assert.ok(alignSegments(parts,[{page:1,at:0}],1).every(s=>s.page===1&&!s.pageStatus));
 assert.ok(alignSegments(session().segments,[{page:2,at:0},{page:1,at:9}],2).every(s=>!s.pageStatus));
});
test('待确认发言允许保存、成组编辑和讲稿导出，不隐藏原话',()=>{
 const s=session();assert.equal(validateSession(s).segments[0].page,0);
 assert.throws(()=>validateSession({...s,segments:[{...s.segments[0],pageStatus:undefined}]}),/页码/);
 const groups=groupTranscript(s.segments,pages);assert.equal(groups[0].page,0);assert.equal(groups[0].parts.length,2);
 assert.equal(editPageTranscript(s.segments,0,'修改后的真实发言。')[0].pageStatus,'unassigned');
 assert.equal(compileScriptPages(s.segments,pages)[0].page,0);
});
test('确认页码不改文字和时间，单段与整段移动均可校验',()=>{
 const s=session(),moved=assignTranscriptPage(s.segments,['s1'],2,2);
 assert.equal(moved[0].page,2);assert.equal(moved[0].pageStatus,undefined);assert.equal(moved[0].text,parts[0].text);assert.equal(moved[0].end,8);assert.equal(moved[1].page,0);
 const all=assignTranscriptPage(s.segments,['s1','s2'],2,2);assert.ok(all.every(s=>s.page===2));assert.equal(validateSession({...s,segments:all}).segments.length,2);
 assert.throws(()=>assignTranscriptPage(s.segments,['s1'],3,2),/有效页码/);
});
test('缺少可靠翻页记录不产出错误的逐页压缩或前后用时比较',()=>{
 const s=session();s.durationSeconds=240;assert.equal(timeBudget(s),null);assert.equal(hasPageTimeline(s.events,2),false);
 const before={...s,id:'before',recordingStatus:'complete',goals:{}},after={...before,id:'after',previousRoundId:'before'};
 const r=compareRounds(before,after);assert.equal(r.timingAvailable,false);assert.equal(r.pages[0].page,0);assert.match(r.pages[0].currentText,/挺有意思/);assert.equal(r.pages[1].currentText,'');
});
test('短片段空建议不判没问题，也不虚构错误，仍提供可执行练习',()=>{
 const s=session(),r=completeCoachingReport(empty,s);assert.equal(r.issues.length,0);assert.equal(r.inputCoverage.scope,'brief');assert.match(r.summary,/不足以判断整场/);assert.equal(r.practiceSuggestions.length,2);assert.match(r.practiceSuggestions[1].action,/30–60/);assert.doesNotMatch(r.nextStep,/保留当前表达/);assert.equal(r.practiceSuggestions[0].origin,'practice_template');
 assert.equal(speechSufficiency({...s,segments:[{text:'有清晰依据的完整论述。'.repeat(30)}],durationSeconds:180}).scope,'provided_speech');
});
test('充分输入仍不为了条数编造问题；已超时的练习先取舍',()=>{
 const s=session();s.segments[0].text='有清晰依据的完整论述。'.repeat(30);s.durationSeconds=240;
 const r=completeCoachingReport(empty,s);assert.equal(r.issues.length,0);assert.equal(r.inputCoverage.scope,'provided_speech');assert.match(r.practiceSuggestions[0].action,/删去/);assert.doesNotMatch(r.practiceSuggestions[0].action,/例子/);
});
test('只在幻灯片中的经历不能作为已讲清的优点或练习原话',()=>{
 const s=session(),r=validateReport({...empty,strengths:[{text:'具体经历有说服力',segmentId:'s1',quote:'参加运动会、合唱和辩论赛'}],practiceSuggestions:[{title:'讲清贡献',action:'拆解辩论赛经历',segmentId:'s1',quote:'参加运动会、合唱和辩论赛'}]},s,{requireSpeechEvidence:true});
 assert.equal(r.strengths.length,0);assert.equal(r.practiceSuggestions.length,0);
 assert.deepEqual(validateReport({...empty,strengths:['无依据的称赞']},s,{requireSpeechEvidence:true}).strengths,[]);
});
const response=raw=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(raw)}}]}));
test('零问题也复核优点和练习；不把相关幻灯片当成已讲内容',async()=>{
 let calls=0;const s=session(),r=await analyze(s,getConfig({DEEPSEEK_API_KEY:'test'}),async(url,init)=>{
  const body=JSON.parse(init.body);calls++;
  if(calls===1){assert.equal(JSON.parse(body.messages[1].content).inputCoverage.unassignedPages,true);return response({...empty,strengths:[{text:'四段结构清晰',segmentId:'s1',quote:parts[0].text}],practiceSuggestions:[{title:'解释“有意思”',action:'选择一个真实理由说明为什么有意思。',segmentId:'s1',quote:parts[0].text}]});}
  return response({decisions:[],strengthDecisions:[{index:0,keep:false,rationale:'四段结构仅在幻灯片中'}],practiceDecisions:[{index:0,keep:true,rationale:'围绕实际原话提供练法'}]});
 });
 assert.equal(calls,2);assert.equal(r.issues.length,0);assert.equal(r.strengths.length,0);assert.equal(r.practiceSuggestions[0].title,'解释“有意思”');assert.equal(r.practiceSuggestions[0].origin,'model');assert.match(r.summary,/较短/);
});
test('正常转述被复核删除后仍有练法，不把它重新包装成问题',async()=>{
 let calls=0;const s=session(),r=await analyze(s,getConfig({DEEPSEEK_API_KEY:'test'}),async()=>response(++calls===1?{...empty,issues:[{segmentId:'s1',quote:parts[0].text,title:'没有念出全部PPT',why:'关键词缺少',suggestion:'补齐PPT词语',action:'clarify'}]}:{decisions:[{index:0,reason:'normal_expression',rationale:'不需要照念'}]}));
 assert.equal(r.issues.length,0);assert.ok(r.practiceSuggestions.length);assert.doesNotMatch(JSON.stringify(r.practiceSuggestions),/补齐|照念/);
});
test('练习复核缺失时只展示明确标记的通用练法',async()=>{
 let calls=0;const r=await analyze(session(),getConfig({DEEPSEEK_API_KEY:'test'}),async()=>response(++calls===1?{...empty,practiceSuggestions:[{title:'虚构案例',action:'增加99人样本',segmentId:'s1',quote:parts[0].text}]}:{decisions:[]}));
 assert.ok(r.practiceSuggestions.every(p=>p.origin==='practice_template'));assert.doesNotMatch(JSON.stringify(r.practiceSuggestions),/99/);
});
test('页码待确认的建议不能被模型指定成第一页',()=>{
 const r=validateReport({...empty,issues:[{page:1,segmentId:'s1',quote:parts[0].text,title:'笼统表态',why:'缺少所指',suggestion:'解释一个真实理由'}]},session());assert.equal(r.issues[0].page,0);
});
test('文字复盘、备份和主动提交反馈保留练习任务及待确认原话',()=>{
 const s=session(),report=completeCoachingReport(empty,s),record={...s,id:'case',title:'测试',goals:{audience:s.audience,targetMinutes:'3'},report};
 const text=readableReport(record);assert.match(text,/接下来可以这样练/);assert.match(text,/缺少可靠翻页记录/);assert.doesNotMatch(text,/第0页|第 0 页/);
 const backup=validateReport(report,s);assert.equal(backup.practiceSuggestions.length,2);assert.equal(backup.practiceSuggestions[0].origin,'practice_template');
 const feedback=normalizeFeedback({clientId:'test',consent:true,consentVersion:FEEDBACK_CONSENT,record});assert.equal(feedback.record.segments[0].pageStatus,'unassigned');assert.equal(feedback.record.report.practiceSuggestions.length,2);
});
test('导入新版短片段报告不重复添加范围提示，畸形优点不破坏整份报告',()=>{
 const s=session(),raw={...empty,issues:[{title:'笼统表态',why:'不清楚所指',suggestion:'解释一个理由',segmentId:'s1',quote:parts[0].text}],strengths:[null,{},'历史优点']};
 const validated=validateReport(raw,s);assert.equal(validated.strengths.length,1);
 const once=completeCoachingReport(validated,s),twice=completeCoachingReport(once,s);assert.equal(once.summary,twice.summary);
 assert.ok(completeCoachingReport({...empty,practiceSuggestions:[{title:'已有练习',action:'试讲',quote:parts[0].text,segmentId:'s1'}]},s).practiceSuggestions.length>=2);
});
