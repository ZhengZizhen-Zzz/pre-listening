import {createHash,randomUUID} from 'node:crypto';
import {validateCoachRequest,routeCoach,COACH_VERSION,ACTIONS} from './coach-router.mjs';
import {connectCoachTools} from './coach-mcp-client.mjs';
import {analyze} from './providers.mjs';
import {makeTimePlan} from './time-coach.mjs';
import {train} from './training.mjs';
import {investigateRehearsal,investigationSummary} from './coach-react.mjs';

export const MAX_COACH_MODEL_CALLS=10;

const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const exhausted=run=>['failed','partial'].includes(run.status)&&run.retries>=1;
const needsGeneration=(run,action)=>!run.results[action]||(action==='diagnose'&&Boolean(run.results.diagnose.evidenceRejected));
export class CoachRuns {
  constructor({config,paidTask,fetcher=fetch,connect=connectCoachTools,router=routeCoach,diagnose=analyze,compress=makeTimePlan,questions=train,investigate=investigateRehearsal,now=Date.now}={}) {
    Object.assign(this,{config,paidTask,fetcher,connect,router,diagnose,compress,questions,investigate,now});this.config={...config,jsonMode:true};this.runs=new Map();
  }
  prune(){for(const [id,run] of this.runs)if(run.expires<this.now()&&!['planning','running'].includes(run.status))this.runs.delete(id);}
  owned(id,owner){this.prune();const run=this.runs.get(id);if(!run||run.owner!==owner)throw fault('这次任务已过期或服务已重启，请重新安排；已有演练内容仍保留。',404);return run;}
  public(run){return structuredClone({id:run.id,status:run.status,command:run.request.command,plan:run.plan||null,message:run.message||'',results:run.results,failures:run.failures,trace:run.trace,modelCalls:run.modelCalls,retries:run.retries,createdAt:run.createdAt,version:COACH_VERSION});}
  get(id,owner){return this.public(this.owned(id,owner));}
  record(run,label,kind='workflow',extra={}){const item={label,kind,status:'running',startedAt:new Date().toISOString(),...extra};run.trace.push(item);return item;}
  async step(run,label,kind,fn,extra={}){const trace=this.record(run,label,kind,extra);try{const output=await fn();trace.status='complete';return output;}catch(e){trace.status='failed';throw e;}finally{trace.durationMs=Date.now()-Date.parse(trace.startedAt);}}
  modelFetch(run){return async(url,options={})=>{
    if(run.attemptCalls>=MAX_COACH_MODEL_CALLS)throw fault('本次任务已达到模型调用上限，请拆成更小的练习目标。',429);
    if(run.controller.signal.aborted)throw fault('任务已停止。',409);
    run.modelCalls++;run.attemptCalls++;
    return this.fetcher(url,{...options,signal:AbortSignal.any([run.controller.signal,AbortSignal.timeout(180000),...(options.signal?[options.signal]:[])])});
  };}
  createAutomatic(input,owner){
    if(!['diagnose','compress'].includes(input?.kind))throw fault('不支持的自动演练任务。');
    const command=input.kind==='diagnose'?'自动诊断本次演练，主动查证需改进的页面，超时时提供压缩建议':'结合实际用时与发言，主动查证可压缩内容并制定整场压缩建议';
    const request=validateCoachRequest({command,session:input.session});
    const plan={status:'ready',actions:[input.kind],pages:[],targetSeconds:request.session.targetSeconds,questionCount:3,focus:'',summary:ACTIONS[input.kind]};
    const run=this.create(request,owner,plan);
    return run.status==='ready'?this.start(run.id,owner):run;
  }
  create(input,owner,automaticPlan=null,identity=null){
    this.prune();const request=validateCoachRequest(input);
    const key=createHash('sha256').update(JSON.stringify({owner,request,automatic:Boolean(automaticPlan),identity,version:COACH_VERSION})).digest('hex');
    const existing=[...this.runs.values()].reverse().find(r=>r.key===key&&r.status!=='cancelled');
    if(existing&&!exhausted(existing))return this.public(existing);
    if([...this.runs.values()].some(r=>r.owner===owner&&['planning','running'].includes(r.status)))throw fault('上一项练习还在处理，请先等待或停止。',409);
    // Automatic feedback may be requested repeatedly after edits; retain active or retryable work.
    while(this.runs.size>=32||[...this.runs.values()].filter(r=>r.owner===owner).length>=8){
      const ownerFull=[...this.runs.values()].filter(r=>r.owner===owner).length>=8;
      const old=[...this.runs.values()].find(r=>(!ownerFull||r.owner===owner)&&(['complete','cancelled','clarify','unsupported'].includes(r.status)||exhausted(r)));
      if(!old)throw fault('暂存任务较多，请先完成已有练习。',429);
      this.runs.delete(old.id);
    }
    const run={id:randomUUID(),owner,key,request,status:'planning',results:{},failures:{},trace:[],modelCalls:0,attemptCalls:0,retries:0,controller:new AbortController(),createdAt:new Date().toISOString(),expires:this.now()+2*60*60*1000};
    this.runs.set(run.id,run);
    // A new explicit submission may recover after the one retry is exhausted.
    // Preserve successful work, but never reuse rejected evidence as a final result.
    if(existing?.plan?.status==='ready'){
      run.plan=structuredClone(existing.plan);run.results=structuredClone(existing.results);
      for(const action of run.plan.actions)if(needsGeneration(existing,action))delete run.results[action];
      if(existing.investigation)run.investigation=structuredClone(existing.investigation);
      run.status='ready';
    }
    else if(automaticPlan){run.plan=automaticPlan;run.status='ready';}
    else run.pending=this.prepare(run);
    return this.public(run);
  }
  async prepare(run){
    try {
      const plan=await this.step(run,'理解这次练习目标','router',()=>this.paidTask(()=>this.router(run.request,this.config,this.modelFetch(run)),run.owner));
      if(run.controller.signal.aborted)return;
      run.plan=plan;run.status=plan.status==='ready'?'ready':plan.status;run.message=plan.message||'';
    }catch(e){if(run.status!=='cancelled'){run.status='failed';run.message=e.status?e.message:'目标识别未完成，请稍后重试。';}}
  }
  start(id,owner,{retry=false}={}){
    const run=this.owned(id,owner);
    if(['running','complete'].includes(run.status))return this.public(run);
    if([...this.runs.values()].some(r=>r!==run&&r.owner===owner&&['planning','running'].includes(r.status)))throw fault('上一项练习还在处理，请先等待或停止。',409);
    if(retry){
      if(!['failed','partial'].includes(run.status)||run.retries>=1)throw fault('本次任务不能再次重试，请重新安排目标。');
      run.retries++;run.attemptCalls=0;run.controller=new AbortController();run.message='';
      if(!run.plan||run.plan.status!=='ready'){run.status='planning';run.pending=this.prepare(run);return this.public(run);}
    }else if(run.status!=='ready')throw fault('请先完成目标确认。');
    run.status='running';run.pending=this.execute(run);return this.public(run);
  }
  cancel(id,owner){const run=this.owned(id,owner);if(['planning','running','ready'].includes(run.status)){run.controller.abort();run.status='cancelled';run.message='已停止；已完成的结果和原始发言仍保留。';}return this.public(run);}
  async execute(run){
    const {plan}=run,session={...run.request.session,targetSeconds:plan.targetSeconds};
    const focus={command:run.request.command,pages:plan.pages,topic:plan.focus};
    const scopedSession={...session,coachFocus:focus};let client;
    const guard=()=>{if(run.controller.signal.aborted)throw fault('任务已停止。',409);};
    const timeout=setTimeout(()=>run.controller.abort(),240000);
    try {
      await this.paidTask(async()=>{
        client=await this.connect();guard();
        if(!run.investigation&&plan.actions.some(a=>['diagnose','compress'].includes(a)&&!run.results[a])){
          const investigation=await this.investigate({session,actions:plan.actions.filter(a=>['diagnose','compress'].includes(a)),focus,client,config:this.config,fetcher:this.modelFetch(run),signal:run.controller.signal,step:(...args)=>this.step(run,...args)});
          guard();run.investigation=investigation;run.results.investigation=investigationSummary(investigation);run.results.timing=investigation.timing;
        }
        if(run.investigation)scopedSession.coachInvestigation=run.investigation;
        if(!run.results.context&&plan.actions.includes('questions'))run.results.context=await this.step(run,'读取相关页材料与实际发言','mcp',()=>client.call('get_page_context',{session,pages:plan.pages}),{tool:'get_page_context'});
        if(run.results.context){
          if(plan.pages.length)scopedSession.coachEvidence=run.results.context;
          else {scopedSession.pages=run.results.context.pages;scopedSession.segments=[...run.results.context.speech,...run.results.context.unassignedSpeech];}
        }
        guard();
        if(!run.results.timing&&plan.actions.some(a=>['timing','compress'].includes(a)))run.results.timing=await this.step(run,'核对真实逐页用时','mcp',()=>client.call('get_timing_summary',{session}),{tool:'get_timing_summary'});
        for(const action of plan.actions){
          guard();if(action==='timing'||!needsGeneration(run,action))continue;
          if(action==='compress'&&!run.results.timing.reliable){run.results.compress={status:'needs_input',message:run.results.timing.note};continue;}
          if(action==='compress'&&run.results.timing.excessSeconds===0){run.results.compress={status:'not_needed',message:'本次实际用时没有超过所选目标，不需要为了达标强行删减。'};continue;}
          try {
          const result=await this.step(run,ACTIONS[action],'model',async()=>{
            const fetcher=this.modelFetch(run);
            if(action==='compress')return this.compress({...session,coachFocus:{...focus,pages:[]},...(run.investigation?{coachInvestigation:run.investigation}:{})},this.config,fetcher,{repair:true});
            if(action==='questions')return this.questions('questions',{session:scopedSession,count:plan.questionCount,coachFocus:focus},this.config,fetcher);
            return this.diagnose(scopedSession,this.config,fetcher);
          });
          guard();
          if(['diagnose','compress'].includes(action)&&result&&run.investigation)result.investigation=investigationSummary(run.investigation);
          if(action==='diagnose'&&plan.pages.length){
            result.issues=result.issues.filter(i=>plan.pages.includes(i.page));
            result.strengthEvidence=(result.strengthEvidence||[]).filter(i=>plan.pages.includes(session.segments.find(s=>s.id===i.segmentId)?.page));
            result.strengths=result.strengthEvidence.map(i=>i.text);
            result.practiceSuggestions=(result.practiceSuggestions||[]).filter(i=>plan.pages.includes(session.segments.find(s=>s.id===i.segmentId)?.page));
            result.scope={pages:plan.pages};
          }
          run.results[action]=result;
          if(action==='diagnose'&&result.evidenceRejected)run.failures[action]='部分建议的引用未通过校验，已隐藏；可以重试分析，其他结果保留。';
          else delete run.failures[action];
          }catch(e){guard();run.failures[action]=e.status?e.message:'这一步未完成，可稍后重试。';}
        }
      },run.owner);
      guard();run.status=Object.keys(run.failures).length?(plan.actions.some(a=>run.results[a])?'partial':'failed'):'complete';
      run.message=Object.keys(run.failures).length?'部分步骤未完成，已保留其他结果；可以重试未完成步骤。':run.results.compress?.status==='needs_input'?'已保留可用结果；压缩方案还需要可靠的逐页计时。':'本次练习准备好了。';
    }catch(e){
      if(run.status!=='cancelled'){
        run.status=plan.actions.some(a=>run.results[a])?'partial':'failed';
        run.message=run.controller.signal.aborted?'处理已超时，已完成结果保留。可以重试未完成步骤。':e.status?e.message:'有一步未能完成，已完成结果保留。可以重试未完成步骤。';
      }
    }finally{clearTimeout(timeout);client?.close();}
  }
}
