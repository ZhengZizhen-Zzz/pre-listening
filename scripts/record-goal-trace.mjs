// Opt-in integration evidence using synthetic inputs and the production Agent / MCP.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GoalAgentRuns,GOAL_AGENT_VERSION,validateGoalContext} from '../lib/goal-agent.mjs';
import {validateCoachRequest} from '../lib/coach-router.mjs';
import {getConfig,callTextModel} from '../lib/providers.mjs';

const args=process.argv.slice(2),root=fileURLToPath(new URL('../',import.meta.url));
const value=key=>args[args.indexOf(key)+1];
const fixture=JSON.parse(await readFile(new URL('../evals/goal/fixtures.json',import.meta.url),'utf8'));
const initial={roundId:'synthetic-round-1',audioId:'synthetic-audio-1',complete:true};
const after={...fixture.session,durationSeconds:fixture.after.durationSeconds,events:fixture.after.events,
  segments:fixture.session.segments.map((s,i)=>i===0?{...s,text:fixture.after.firstSpeech}:s)};
const cases=[
  {id:'incomplete',session:fixture.session,context:{...initial,complete:false}},
  {id:'overtime',session:fixture.session,context:initial},
  {id:'all-protected',session:fixture.session,context:{...initial,protectedSpeech:fixture.session.segments.map(s=>({page:s.page,quote:s.text,reason:'本轮这些内容都要求保留，请先确认取舍，不能直接删减。'}))}},
  {id:'within-limit',session:after,context:{roundId:'synthetic-round-2',audioId:'synthetic-audio-2',complete:true,baseline:{...initial,session:fixture.session}}}
];
for(const item of cases){const request=validateCoachRequest({command:fixture.command,session:item.session});validateGoalContext(item.context,request.session);}
if(!args.includes('--live')){
  console.log('Validated 4 synthetic inputs; no model requests. Live capture: node --env-file=.env scripts/record-goal-trace.mjs --live --max-model-calls 8 --output .local/goal-trace.json');
  process.exit(0);
}
const cap=Number(value('--max-model-calls')),output=value('--output');
if(!args.includes('--max-model-calls')||!Number.isInteger(cap)||cap<1||cap>10||!args.includes('--output')||!output||output.startsWith('--'))throw Error('Explicit --max-model-calls (1–10) and --output are required.');
const config=getConfig();if(!config.key)throw Error('Configure a text-model key first.');
let requests=0;
const evidence={schemaVersion:1,capturedAt:new Date().toISOString(),source:'synthetic_inputs_real_model_and_local_mcp',
  description:fixture.description,agentVersion:GOAL_AGENT_VERSION,provider:config.provider,configuredModel:config.model,
  maxModelCalls:cap,sourceHashes:{},runs:[]};
for(const name of ['lib/goal-agent.mjs','lib/coach-runs.mjs','lib/providers.mjs','lib/time-coach.mjs','lib/coach-mcp-client.mjs','scripts/coach-mcp.mjs','evals/goal/fixtures.json','scripts/record-goal-trace.mjs']){
  evidence.sourceHashes[name]=createHash('sha256').update(await readFile(path.join(root,name))).digest('hex');
}
for(const item of cases){
  const decisions=[],steps=[],responses=[];
  const fetcher=async(url,options)=>{
    if(requests>=cap)throw Object.assign(Error('Explicit model-call budget reached.'),{status:429});
    requests++;
    const response=await fetch(url,options);
    // Never persist headers, credentials, provider request IDs or reasoning content.
    const safe={status:response.status};
    try{const body=await response.clone().json();safe.model=body.model;safe.usage=body.usage;}catch{}
    responses.push(safe);return response;
  };
  class ObservedRuns extends GoalAgentRuns {
    async step(run,label,kind,fn,extra={}){
      const output=await super.step(run,label,kind,fn,extra);
      steps.push({label,kind,...extra,output:structuredClone(output)});return output;
    }
  }
  const runs=new ObservedRuns({config,paidTask:fn=>fn(),fetcher,decide:async(prompt,data,cfg,trackedFetch)=>{
    const result=await callTextModel(prompt,data,cfg,trackedFetch);
    decisions.push({modelOutput:result.raw,usage:result.usage});return result;
  }});
  const input={command:fixture.command,session:item.session,context:item.context};
  const begin=Date.now(),created=runs.create(input,'synthetic-trace-owner');
  await runs.runs.get(created.id).pending;
  const result=runs.get(created.id,'synthetic-trace-owner');
  evidence.runs.push({id:item.id,input,status:result.status,message:result.message,elapsedMs:Date.now()-begin,
    modelCalls:result.modelCalls,decisions,steps,trace:result.trace,results:result.results,responses});
  console.log(`${item.id}: ${result.status}; ${result.modelCalls} model requests; next=${result.results.next?.action||'none'}`);
}
evidence.totalNetworkModelRequests=requests;evidence.finishedAt=new Date().toISOString();
evidence.limitations=['Synthetic timings / audio IDs exercise control flow, not microphone or ASR integrity.','Single model capture, not a success-rate or latency benchmark.','No manuscript was adopted and no human rerehearsal was measured in this capture.'];
const target=path.resolve(output);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(evidence,null,2)+'\n');
if(evidence.runs.some(r=>r.status!=='complete'))process.exitCode=1;
