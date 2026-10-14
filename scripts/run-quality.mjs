import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {getConfig,analyze,DIAGNOSIS_PROMPT_VERSION} from '../lib/providers.mjs';
import {revise,REVISION_PROMPT_VERSION} from '../lib/rewriter.mjs';
import {validateSession,validateReport} from '../public/core.mjs';
import {validateRevisionInput,initialClarification} from '../public/revision-core.mjs';
import {screenCase} from './eval-metrics.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),args=process.argv.slice(2);
const arg=(name,fallback)=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1)??fallback;
const suite=JSON.parse(await readFile(path.join(root,'evals/quality/cases.json'),'utf8'));
const ids=arg('--ids','').split(',').filter(Boolean),selected=ids.length?suite.cases.filter(c=>ids.includes(c.id)):suite.cases;
if(ids.some(id=>!suite.cases.some(c=>c.id===id)))throw new Error('存在未知案例编号');
for(const c of selected)c.kind==='diagnosis'?validateSession(c.session):validateRevisionInput(c.request,validateSession,validateReport);
if(!args.includes('--live')){console.log(JSON.stringify({mode:'offline-validation',validCases:selected.length,paidCalls:0,cases:selected.map(c=>({id:c.id,kind:c.kind,split:c.split}))},null,2));process.exit(0);}
if(!ids.length)throw new Error('真实调用必须用 --ids 明确选择案例，默认不会跑全部案例。');
const cap=Number(arg('--max-calls','0'));
if(!Number.isSafeInteger(cap)||cap<1||cap>20)throw new Error('--max-calls 必须为1到20，不会自动重试。');
const output=path.resolve(root,arg('--out','evals/quality/live-results.json'));
try{await readFile(output);throw new Error('输出文件已存在；请选择新文件，避免覆盖证据或误重复计费。');}catch(e){if(e.code!=='ENOENT')throw e;}
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const config=getConfig();if(!config.key)throw new Error('未配置文字模型。');
const data={date:'2026-10-10',startedAt:new Date().toISOString(),mode:'live',provider:config.provider,model:config.model,diagnosisPrompt:DIAGNOSIS_PROMPT_VERSION,revisionPrompt:REVISION_PROMPT_VERSION,maxModelCalls:cap,attemptedModelCalls:0,asrCalls:0,results:[],limitations:'自动约束筛查不是人工语义通过率。合成案例不能代表真实用户效果。错误不自动重试；包含证据复核的诊断计2次模型调用。'};
await mkdir(path.dirname(output),{recursive:true});
const persist=async()=>{await writeFile(output+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(output+'.tmp',output);};
const trackedFetch=async(url,init)=>{
 if(data.attemptedModelCalls>=cap)throw new Error('评估调用预算已用完。');
 data.attemptedModelCalls++;await persist();
 return fetch(url,init);
};
await persist();
for(const item of selected){
 const request=item.kind==='revision'?validateRevisionInput(item.request,validateSession,validateReport):null;
 const localResult=request&&initialClarification(request);
 const reservation=localResult?0:item.kind==='diagnosis'?2:1;
 if(data.attemptedModelCalls+reservation>cap){data.results.push({id:item.id,status:'skipped',reason:'剩余预算不足以保证完成该案例'});continue;}
 const start=Date.now(),before=data.attemptedModelCalls;
 const record={id:item.id,kind:item.kind,split:item.split,expected:item.expected||item.allowedStatuses,inputHash:createHash('sha256').update(JSON.stringify(item)).digest('hex'),status:'running'};
 data.results.push(record);await persist();
 try{
   const result=localResult||await(item.kind==='diagnosis'?analyze(validateSession(item.session),config,trackedFetch):revise(request,config,trackedFetch));
   Object.assign(record,{status:'complete',result,screen:screenCase(item,result)});
 }catch(e){Object.assign(record,{status:'error',error:String(e.message).slice(0,300)});}
 Object.assign(record,{modelCalls:data.attemptedModelCalls-before,elapsedMs:Date.now()-start});await persist();
 console.log(JSON.stringify({id:item.id,status:record.status,calls:record.modelCalls,screen:record.screen?.screenPassed,failures:record.screen?.failures}));
}
data.finishedAt=new Date().toISOString();data.summary={selected:selected.length,completed:data.results.filter(r=>r.status==='complete').length,screenPassed:data.results.filter(r=>r.screen?.screenPassed).length,errors:data.results.filter(r=>r.status==='error').length,semanticReviewed:0};await persist();console.log(JSON.stringify(data.summary));
