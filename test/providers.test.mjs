import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, analyze, startTranscription, pollTranscription, buildDiagnosisInput, auditSpeechEvidence } from '../lib/providers.mjs';
const response = data => new Response(JSON.stringify(data), {status:200,headers:{'Content-Type':'application/json'}});
test('诊断输入区分幻灯片与发言，并保留跨页发言',()=>{
  const input=buildDiagnosisInput({pages:[{number:2,text:'已拟定测试指标'}],segments:[{id:'s1',page:1,text:'我在此先说明指标'},{id:'s2',page:2,text:'接下来试用'}],audience:'评委',takeaways:'说明验证方案',events:[],durationSeconds:null,targetSeconds:300});
  assert.equal(input.slideMaterial[0].text,'已拟定测试指标');
  assert.equal(input.actualSpeech.length,2);
  assert.equal(input.actualSpeech[0].page,1);
  assert.equal(input.timing.durationSeconds,null);
});
test('DeepSeek 文字与百炼转写密钥独立配置',()=>{const c=getConfig({LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'test-text'});assert.equal(c.key,'test-text');assert.equal(c.asrKey,undefined);});
test('DeepSeek 模拟响应经过原文证据核对',async()=>{let request;const output=await analyze({pages:[{number:1,text:'研究进度'}],segments:[{id:'s1',page:1,start:null,end:null,text:'还需要收集真实用户的反馈。'}]},getConfig({LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'test'}),async(url,init)=>{if(JSON.parse(init.body).messages[0].content.includes('证据复核员'))return response({choices:[{message:{content:JSON.stringify({decisions:[{index:0,reason:'expression_issue',rationale:'明确要求说明验证计划'}]})}}]});request={url,body:JSON.parse(init.body)};return response({choices:[{message:{content:JSON.stringify({summary:'还需验证',issues:[{title:'验证计划',segmentId:'s1',quote:'收集真实用户的反馈',why:'需要细化',suggestion:'确认参与对象',action:'clarify'}]})},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:50}})});assert.equal(request.url,'https://api.deepseek.com/chat/completions');assert.equal(request.body.thinking.type,'disabled');assert.equal(output.source,'live');assert.equal(output.issues[0].start,null);});
test('缺少密钥不会执行网络请求',async()=>{await assert.rejects(()=>analyze({},getConfig({}),()=>{throw new Error('不应调用')}),/尚未配置/)});
test('无材料文字也调用分析，并显式限制模型和报告的分析范围',async()=>{
  let sent;
  const result=await analyze({pages:[{number:1,text:''}],segments:[{id:'s1',page:1,text:'先介绍我的职责，再说明关键决策和成果。',start:null,end:null}]},getConfig({DEEPSEEK_API_KEY:'test'}),async(url,init)=>{
    sent=JSON.parse(init.body);return response({choices:[{message:{content:JSON.stringify({summary:'发言顺序清楚',issues:[]})}}]});
  });
  assert.equal(JSON.parse(sent.messages[1].content).materialCoverage.mode,'speech_only');
  assert.match(sent.messages[0].content,/空白 text 只是没有提取到文字/);
  assert.equal(result.materialCoverage.mode,'speech_only');assert.match(result.limits[0],/暂不核对幻灯片内容/);
});
test('无效 JSON 不展示成成功报告',async()=>{await assert.rejects(()=>analyze({},getConfig({DEEPSEEK_API_KEY:'test'}),async()=>response({choices:[{message:{content:'not json'}}]})),/有效 JSON/)});
test('转写上传使用同一模型和 OSS 解析头',async()=>{const calls=[];const config=getConfig({DASHSCOPE_API_KEY:'test'});const id=await startTranscription(Buffer.from('fake audio'),'audio/webm',config,async(url,init)=>{calls.push({url,init});if(calls.length===1)return response({data:{upload_host:'https://test.oss-cn-beijing.aliyuncs.com',upload_dir:'uploads',policy:'test',signature:'test',oss_access_key_id:'test',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});if(calls.length===2)return new Response('',{status:200});return response({output:{task_id:'task1'}})});assert.equal(id,'task1');assert.match(calls[0].url,/model=fun-asr/);assert.equal(calls[2].init.headers['X-DashScope-OssResourceResolve'],'enable');assert.equal(JSON.parse(calls[2].init.body).model,'fun-asr');});
test('异步转写先返回 pending，完成后转换毫秒时间戳',async()=>{assert.deepEqual(await pollTranscription('id',getConfig({DASHSCOPE_API_KEY:'test'}),async()=>response({output:{task_status:'RUNNING'}})),{status:'pending'});let count=0;const r=await pollTranscription('id',getConfig({DASHSCOPE_API_KEY:'test'}),async()=>++count===1?response({output:{task_status:'SUCCEEDED',results:[{subtask_status:'SUCCEEDED',transcription_url:'https://result.oss-cn-beijing.aliyuncs.com/result.json'}]}}):response({properties:{original_duration_in_milliseconds:3000},transcripts:[{sentences:[{begin_time:100,end_time:2300,text:'你好'}]}]}));assert.equal(r.segments[0].start,.1);assert.equal(r.segments[0].end,2.3);});
test('任务整体成功但文件失败时不误报完成',async()=>{await assert.rejects(()=>pollTranscription('id',getConfig({DASHSCOPE_API_KEY:'test'}),async()=>response({output:{task_status:'SUCCEEDED',results:[{subtask_status:'FAILED'}]}})),/未成功/)});
test('证据复核去掉识别噪声，同步清理旧摘要；保留真正冲突并先确认',async()=>{
 const report={summary:'姓名口误及人数冲突',nextStep:'修改口误',strengths:[],issues:[{title:'姓名口误',segmentId:'s1',suggestion:'改姓氏'},{title:'人数冲突',segmentId:'s2',quote:'已经访谈30人',suggestion:'先确认人数',action:'revise'}]};
 const output=await auditSpeechEvidence({segments:[{id:'s2',page:1,text:'已经访谈30人'}],pages:[{number:1,text:'已经访谈5人'}]},report,getConfig({DEEPSEEK_API_KEY:'test'}),async()=>response({choices:[{message:{content:JSON.stringify({decisions:[{index:0,reason:'asr_noise'},{index:1,reason:'meaning_conflict',evidence:[{source:'slide',page:1,quote:'已经访谈5人'},{source:'speech',segmentId:'s2',quote:'已经访谈30人'}]}]})}}]}));
 assert.equal(output.report.issues.length,1);assert.equal(output.report.issues[0].action,'clarify');assert.ok(output.report.issues[0].question);assert.ok(!output.report.summary.includes('口误'));assert.match(output.report.nextStep,/先说明/);assert.equal(report.issues.length,2);
});
test('证据复核缺漏建议时不回退展示未经复核的诊断',async()=>{
 await assert.rejects(()=>auditSpeechEvidence({segments:[],pages:[]},{issues:[{title:'口误'}]},getConfig({DEEPSEEK_API_KEY:'test'}),async()=>response({choices:[{message:{content:'{"decisions":[]}'}}]})),/复核未完成/);
});
test('单条冲突引用失败仅隐藏该建议，其余已核对结果保留；全被过滤不报没有问题',async()=>{
 const session={pages:[{number:1,text:''}],segments:[{id:'s1',page:1,text:'已经访谈30人，接下来继续说明。'}]};
 const issues=[{segmentId:'s1',quote:'已经访谈30人',title:'待核对冲突',suggestion:'不应展示'},{segmentId:'s1',quote:'接下来继续说明',title:'结构建议',suggestion:'先给结论'}];
 const run=async(all)=>auditSpeechEvidence(session,{summary:'原摘要',issues:all?issues.slice(0,1):issues,limits:[]},getConfig({DEEPSEEK_API_KEY:'test'}),async()=>response({choices:[{message:{content:JSON.stringify({decisions:[{index:0,reason:'meaning_conflict',evidence:[{source:'slide',page:1,quote:'幻灯片中不存在'},{source:'speech',segmentId:'s1',quote:'已经访谈30人'}]},...(!all?[{index:1,reason:'expression_issue'}]:[])]})}}]}));
 const partial=(await run(false)).report;assert.equal(partial.issues.length,1);assert.equal(partial.issues[0].title,'结构建议');assert.equal(partial.evidenceRejected,1);
 const empty=(await run(true)).report;assert.equal(empty.issues.length,0);assert.match(empty.summary,/不能据此判断表达没有问题/);assert.match(empty.limits[0],/已隐藏/);
});
test('付费 POST 前必须先保存提交意图；保存失败时不会请求识别',async()=>{
 const calls=[];const fetcher=async(url)=>{calls.push(url);if(calls.length===1)return response({data:{upload_host:'https://test.oss-cn-beijing.aliyuncs.com',upload_dir:'uploads',policy:'test',signature:'test',oss_access_key_id:'test'}});return new Response('',{status:200});};
 await assert.rejects(startTranscription(Buffer.from('fake'),'audio/webm',getConfig({DASHSCOPE_API_KEY:'test'}),fetcher,async()=>{throw new Error('journal unavailable');}),/journal unavailable/);assert.equal(calls.length,2);
});
test('识别服务明确4xx拒绝带确定标记，网络断开不带确定标记',async()=>{
 const run=async(fail)=>{let count=0;return startTranscription(Buffer.from('fake'),'audio/webm',getConfig({DASHSCOPE_API_KEY:'test'}),async()=>{if(++count===1)return response({data:{upload_host:'https://test.oss-cn-beijing.aliyuncs.com',upload_dir:'uploads',policy:'test',signature:'test'}});if(count===2)return new Response('',{status:200});return fail();});};
 await assert.rejects(run(()=>new Response(JSON.stringify({message:'denied'}),{status:403})),e=>e.providerRejected===true);
 await assert.rejects(run(()=>{throw new Error('network lost');}),e=>!e.providerRejected);
});
test('损坏转写内容或时间戳不作为成功结果交给前端',async()=>{
 for(const sentence of [{text:'测试',begin_time:'not time',end_time:3000},{text:'测试',begin_time:3000,end_time:2000},{text:null,begin_time:0,end_time:3000}]){
  let calls=0;await assert.rejects(pollTranscription('id',getConfig({DASHSCOPE_API_KEY:'test'}),async()=>++calls===1?response({output:{task_status:'SUCCEEDED',results:[{subtask_status:'SUCCEEDED',transcription_url:'https://result.oss-cn-beijing.aliyuncs.com/result.json'}]}}):response({transcripts:[{sentences:[sentence]}]})),e=>e.terminal===true&&e.message.includes('格式异常'));
 }
});
