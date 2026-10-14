import {formatTime} from './core.mjs';
import {retryRead} from './retry-read.mjs';
import {acceptDraft} from './revision-core.mjs';
import {goalTiming,goalCandidates,goalReport,nextGoalBaseline,sameGoalMaterial,firstGoalConfirmation,protectedCandidate} from './goal-core.mjs';
export {nextGoalBaseline} from './goal-core.mjs';
const active=r=>['planning','running'].includes(r?.status);
export function createGoalAgent({state,$,escape:esc,getSession,workspace,api,health,message,view,slidePreview,slidePreviews}){
 let polling=false,working=false,paint='',answer='',reason='',keeping=false;
 const review=$('goal-agent-review'),practice=$('goal-agent-practice');
 const current=()=>({session:structuredClone(getSession()),roundId:state.roundId||state.id,audioId:state.audioAssetId||null,complete:state.recordingStatus==='complete'&&!state.jobError&&!['pending','submitting','failed','uncertain'].includes(state.jobStatus)});
 const fresh=g=>g&&JSON.stringify(current())===JSON.stringify(g.current);
 const persist=async()=>{if(!await workspace.saveNow())throw new Error('改进进度未保存成功，请保留页面后重试。');};
 const request=(url,body)=>api(url,{...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const locked=()=>state.busy||state.recording||working;
 function select(g){
   const candidates=goalCandidates(g.report,g.current.session,g.protectedSpeech,state.scripts,state.feedback);
   g.suggestion=candidates[0]||null;g.flow=null;
   if(g.suggestion){
     const index=state.report?.issues?.findIndex(i=>i.segmentId===g.suggestion.segmentId&&i.quote===g.suggestion.quote);
     const flow=index>=0?state.rewrites[index]:null;
     if(flow?.result?.status==='draft'&&!flow.acceptedAt&&flow.result.originalText===g.current.session.segments.find(s=>s.id===g.suggestion.segmentId)?.text)g.flow=structuredClone(flow);
   }
   return Boolean(g.suggestion);
 }
 function render(){
   const now=current(),g=state.goalAgent,isFresh=fresh(g),run=g?.run;
   if(g&&!g.schemaVersion){g.schemaVersion=2;g.protectedSpeech||=[];g.history||=[];if(isFresh&&run?.status==='complete'){g.report=goalReport(run.results);select(g);}}
   if(state.report&&!state.analysis)$('metrics').after(review);else $('review-empty').before(review);
   if(g)$('time-coach').hidden=true;
   const visible=!state.demo&&state.pages.length&&Boolean(state.report||g)&&!state.analysis;
   review.hidden=!visible;
   practice.hidden=!(g&&!state.demo&&!state.report);
   if(!practice.hidden){practice.innerHTML=`<div class="goal-agent-heading"><span>本轮继续：${formatTime(g.targetSeconds)} 内讲清重点</span><button type="button" class="text-button" data-goal-back>查看改进目标</button></div>`;practice.querySelector('button').onclick=()=>view('review');}
   if(!visible)return;
   const key=JSON.stringify([state.id,g,locked(),isFresh,keeping,now.session.targetSeconds]);if(key===paint)return;paint=key;
   const next=isFresh?run?.results?.next:null,c=isFresh?g?.suggestion:null,flow=g?.flow,result=flow?.result;
   const title=g?`目标 ${formatTime(g.targetSeconds)}`:`本次 ${formatTime(now.session.durationSeconds)} · 目标 ${formatTime(now.session.targetSeconds)}`;
   const timing=goalTiming(now.session),initialLabel=timing.reliable&&timing.excessSeconds===0?'确认本次目标':'帮我调整到目标时长内';
   const comparison=isFresh&&run?.results?.comparison?.available?`上轮 ${formatTime(run.results.comparison.beforeSeconds)} → 本轮 ${formatTime(run.results.comparison.afterSeconds)}`:'';
   const disabled=locked()?'disabled':'';
   let body='';
   if(!g)body=`<button type="button" class="button secondary" data-goal-start ${disabled}>${initialLabel}</button>`;
   else if(!isFresh)body=`<button type="button" class="button primary" data-goal-start ${disabled}>检查这次演练</button>`;
   else if(active(run))body=`<p role="status">正在根据你的要求查找调整方案…</p><button type="button" class="text-button" data-goal-cancel>停止</button><button type="button" class="text-button" data-goal-poll>查看进度</button>`;
   else if(g.confirmedAt)body='<p class="goal-agent-next">本次用时已达标，你已确认重点保留，可以结束这项目标。</p>';
   else if(c){
     const original=result?.status==='draft'?result.originalText:c.quote;
     body=`<div class="goal-agent-card"><div class="goal-agent-material">${slidePreview(c.page)}</div><div class="goal-agent-edit"><strong>${esc(c.title)}</strong><span class="goal-agent-label">原话</span><blockquote>${esc(original)}</blockquote>
       ${result?.status==='draft'?`<label class="goal-agent-label" for="goal-draft">建议表达 · 可编辑</label><textarea id="goal-draft" data-goal-draft rows="4" maxlength="12000">${esc(result.revisedText)}</textarea><button class="button primary" data-goal-adopt ${disabled}>采用并更新练习稿</button>`:
       result?.status==='needs_input'?`<p>${esc(result.question)}</p><textarea data-goal-answer rows="2" maxlength="2000" aria-label="补充真实情况">${esc(answer)}</textarea><button class="button primary" data-goal-rewrite ${disabled}>补充后改稿</button>`:
       result?.status==='no_change'?`<p>${esc(result.reason)}</p><button class="button secondary" data-goal-rehearse ${disabled}>保留原稿再练一次</button>`:
       `<p>${esc(c.suggestion)}</p><button class="button primary" data-goal-rewrite ${disabled}>${working?'正在生成修改稿…':'生成修改稿'}</button>`}
       <button class="text-button" data-goal-keep ${disabled}>这段需要保留</button>
       ${keeping?`<div class="goal-agent-keep"><textarea data-goal-reason rows="2" maxlength="300" aria-label="保留原因（选填）" placeholder="原因（选填），例如：老师要求必须讲完整">${esc(reason)}</textarea><button class="button secondary" data-goal-keep-submit ${disabled}>保留并换一处</button><button class="text-button" data-goal-keep-cancel>取消</button></div>`:''}
       ${g.error?`<p role="alert">${esc(g.error)}</p>`:''}</div></div>`;
   }else if(next?.action==='confirm')body=`<p class="goal-agent-next">本次用时已在上限内。请确认需要保留的重点仍然讲清楚。</p>${g.command?`<p class="coach-note">${esc(g.command)}</p>`:''}<div class="goal-agent-evidence">${(next.evidence||[]).map(e=>`<article>${slidePreview(e.page)}<blockquote>${esc(e.quote)}</blockquote></article>`).join('')}</div><button class="button primary" data-goal-confirm ${disabled}>确认重点已保留</button><button class="text-button" data-goal-missing ${disabled}>还有内容需要调整</button>`;
   else if(next?.action==='clarify')body=`<p class="goal-agent-next">${esc(next.message)}</p>${next.needsRecording?`<button class="button secondary" data-goal-practice>回到本次发言</button>`:`<textarea data-goal-answer rows="2" maxlength="600" placeholder="补充需要保留的内容或可以简讲的部分" aria-label="补充目标">${esc(answer)}</textarea><button class="button primary" data-goal-answer-submit ${disabled}>补充后继续</button><button class="text-button" data-goal-rehearse ${disabled}>按当前讲稿重练</button>`}`;
   else if(next?.action==='rehearse')body=`<p class="goal-agent-next">${g.adoptedThisRound?'练习稿已更新。重新讲一次，检查实际用时。':esc(next.message)}</p><button class="button primary" data-goal-rehearse ${disabled}>开始下一轮演练</button>${g.adoptedThisRound?'<button class="text-button" data-goal-scripts>查看练习稿</button>':''}`;
   if(g&&['failed','expired','cancelled'].includes(run?.status))body+=`<p role="alert">${esc(run.message||'已停止，演练记录仍然保留。')}</p><button class="button secondary" data-goal-start ${disabled}>重新检查</button>`;
   review.innerHTML=`<div class="goal-agent-heading"><strong>${esc(title)}</strong>${comparison?`<span class="goal-agent-comparison">${esc(comparison)}</span>`:''}</div>${body}${g?`<details class="goal-agent-options"><summary>目标与已保留内容</summary><p>${esc(g.command)}</p>${(g.protectedSpeech||[]).map(p=>`<p>保留第 ${p.page} 页：${esc(p.quote)}${p.reason?`（${esc(p.reason)}）`:''}</p>`).join('')}<button class="text-button" data-goal-reset ${disabled||active(run)?'disabled':''}>结束此目标</button></details>`:''}`;
   const on=(sel,fn)=>review.querySelector(sel)?.addEventListener('click',()=>void safe(fn));
   review.querySelector('[data-goal-answer]')?.addEventListener('input',e=>answer=e.target.value);
   review.querySelector('[data-goal-reason]')?.addEventListener('input',e=>reason=e.target.value);
   review.querySelector('[data-goal-draft]')?.addEventListener('input',e=>{g.flow.result.revisedText=e.target.value;g.flow.manuallyEdited=true;workspace.saveSoon();});
   on('[data-goal-start]',()=>begin());on('[data-goal-answer-submit]',()=>{if(!answer.trim())throw Error('请补充一句你的要求。');return begin(answer.trim(),true);});
   on('[data-goal-keep]',()=>{keeping=true;render();review.querySelector('[data-goal-reason]')?.focus();});
   on('[data-goal-keep-cancel]',()=>{keeping=false;render();});on('[data-goal-keep-submit]',()=>keep());
   on('[data-goal-rewrite]',()=>rewrite());on('[data-goal-adopt]',()=>adopt());
   on('[data-goal-rehearse]',()=>{if(locked()||!fresh(g))return;return workspace.nextRehearsal();});
   on('[data-goal-practice]',()=>view('practice'));on('[data-goal-scripts]',()=>view('scripts'));
   on('[data-goal-confirm]',async()=>{if(locked()||!fresh(g))return;g.confirmedAt=new Date().toISOString();try{await persist();}catch(e){g.confirmedAt=null;throw e;}render();});
   on('[data-goal-missing]',()=>{g.run.results.next={action:'clarify',message:'哪些重点还没讲清？补充后再调整。',evidence:[]};render();return persist();});
   on('[data-goal-reset]',async()=>{if(locked()||active(run))return;state.goalAgent=null;keeping=false;await persist();render();});
   on('[data-goal-cancel]',()=>change('cancel'));on('[data-goal-poll]',()=>poll());
   review.querySelectorAll('button,textarea').forEach(el=>{if(locked()&&!el.matches('[data-goal-cancel],[data-goal-poll]'))el.disabled=true;});
   slidePreviews.render(review);
   if(active(run)&&!polling&&!working)queueMicrotask(()=>void safe(poll));
 }
 async function safe(fn){try{await fn();}catch(e){message(e.message||'操作未完成，已有内容保留。',true);render();}}
 const localRun=next=>({id:`local-${crypto.randomUUID()}`,status:'complete',results:{next},trace:[],modelCalls:0});
 async function begin(clarification='',force=false){
   if(locked()||active(state.goalAgent?.run))return;
   const before=state.goalAgent,now=current();
   if(before&&!sameGoalMaterial(before.current?.session,now.session)){state.goalAgent=null;return begin();}
   const sameTarget=before?.targetSeconds===now.session.targetSeconds;
   const command=(sameTarget?before.command:now.session.takeaways||'保留核心事实与结论，优先减少重复背景。')+(clarification?`\n补充：${clarification}`:'');
   if(command.length>1000)throw Error('目标说明较长，请结束此目标后简要填写。');
   const g={schemaVersion:2,command,targetSeconds:now.session.targetSeconds,baseline:sameTarget?nextGoalBaseline(before,now):null,current:now,
     protectedSpeech:sameTarget?structuredClone(before.protectedSpeech||[]):[],history:sameTarget?structuredClone(before.history||[]):[],run:null,confirmedAt:null,adoptedThisRound:fresh(before)&&Boolean(before.adoptedThisRound)};
   state.goalAgent=g;keeping=false;answer='';
   if(!now.complete||!now.audioId||!goalTiming(now.session).reliable){g.run=localRun({action:'clarify',needsRecording:true,message:!now.complete?'先完成录音并核对发言，再检查整场目标。':'请核对录音与发言页码；目前还不能可靠判断整场用时。'});}
   else if(!g.baseline&&!force&&firstGoalConfirmation(now)){
     const s=now.session.segments.at(-1);g.run=localRun({action:'confirm',evidence:s?[{page:s.page,segmentId:s.id,quote:s.text.slice(0,500)}]:[]});
   }else if(!force&&goalTiming(now.session).excessSeconds>0){
     g.report=structuredClone(state.report|| (fresh(before)?before.report:null));
     if(select(g))g.run=localRun({action:'rehearse',message:'先调整这一处，再用实际演练检查用时。'});
     else if(g.adoptedThisRound)g.run=localRun({action:'rehearse',message:'练习稿已更新，先重新讲一次。'});
   }
   render();await persist();if(!g.run)await submit(g);
 }
 async function submit(g){
   if(state.goalAgent!==g)return;working=true;g.run={status:'running',trace:[],results:{}};render();
   try{
     if(!state.health)await health();if(!state.health)throw Error('暂时无法连接服务，请稍后重试。');
     const now=g.current;const run=await request('/api/goal-agent',{command:g.command,session:now.session,context:{roundId:now.roundId,audioId:now.audioId,complete:now.complete,baseline:g.baseline,protectedSpeech:g.protectedSpeech}});
     if(state.goalAgent!==g)return;await receive(g,run);
   }catch(e){if(state.goalAgent===g){g.run={status:'failed',message:e.message,results:{}};await persist();}}
   finally{working=false;render();if(state.goalAgent===g)void safe(poll);}
 }
 async function receive(g,run){
   g.run=run;
   if(run.status==='complete'){
     g.report=goalReport(run.results);select(g);
     if(!g.suggestion&&run.results.next?.action==='rehearse')g.run.results.next={action:'clarify',message:'暂未找到适合继续删减的段落。哪些内容可以简讲？也可以保留当前稿再练一次。',evidence:[]};
   }
   await persist();render();
 }
 async function poll(){
   const g=state.goalAgent;if(polling||!active(g?.run)||!g.run.id)return;polling=true;
   try{while(state.goalAgent===g&&active(g.run)){
     const run=await retryRead(()=>request(`/api/goal-agent/${g.run.id}`));if(state.goalAgent!==g)break;
     await receive(g,run);if(active(run))await new Promise(r=>setTimeout(r,500));
   }}catch(e){if(state.goalAgent===g){if(e.status===404){g.run.status='expired';g.run.message='处理任务已过期，演练与目标已保留，请重新检查。';await persist();render();}else message('连接暂时中断，点击“查看进度”继续。',true);}}
   finally{polling=false;}
 }
 async function change(action){const g=state.goalAgent;if(!g?.run?.id)return;await receive(g,await request(`/api/goal-agent/${g.run.id}/${action}`,{}));}
 async function keep(){
   const g=state.goalAgent,c=g?.suggestion;if(locked()||!c||!fresh(g))return;
   if(g.protectedSpeech.length>=20)throw Error('已记录较多保留内容，可以结束目标后重新整理要求。');
   g.protectedSpeech.push({page:c.page,quote:c.quote.slice(0,500),reason:reason.trim()});
   g.history.push({type:'keep',roundId:g.current.roundId,segmentId:c.segmentId,quote:c.quote,reason:reason.trim()});
   const needsInterpretation=Boolean(reason.trim());reason='';keeping=false;g.error='';g.flow=null;
   const alternative=select(g);render();await persist();
   if(g.current.session.segments.every(s=>protectedCandidate({page:s.page,segmentId:s.id,quote:s.text},g.current.session,g.protectedSpeech))){
     g.run=localRun({action:'clarify',message:'你已选择保留这些发言。哪些内容可以简讲？也可以按当前讲稿重练，核对实际用时。',evidence:[]});render();await persist();
   }else if(!alternative||needsInterpretation){g.suggestion=null;await submit(g);}
 }
 async function rewrite(){
   const g=state.goalAgent,c=g?.suggestion;if(locked()||!c||!fresh(g))return;
   const flow=g.flow||={answers:[]},answers=[...(flow.answers||[])];
   if(flow.result?.status==='needs_input'){if(!answer.trim())throw Error('请先补充真实情况。');answers.push({question:flow.result.question,answer:answer.trim()});}
   const source=g.current.session.segments.find(s=>s.id===c.segmentId);
   const existing=state.scripts[c.segmentId];if(existing)throw Error('这段讲稿已更新，请先用现有讲稿重练。');
   working=true;g.error='';render();
   try{
     if(!state.health)await health();
     const protectedText=g.protectedSpeech.map(p=>`保留第${p.page}页「${p.quote}」${p.reason}`).join('；');
     const result=await api('/api/revise',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:getSession(),issue:c,answers,instruction:`限时${g.targetSeconds}秒；${g.command}；${protectedText}`.slice(0,1000)})});
     if(state.goalAgent!==g||!fresh(g))return;
     if(result.status==='draft'&&(result.segmentId!==c.segmentId||result.originalText!==source.text))throw Error('原发言已变化，请重新检查。');
     flow.answers=answers;flow.result=result;answer='';await persist();
   }catch(e){if(state.goalAgent===g)g.error=e.message;}
   finally{working=false;render();}
 }
 async function adopt(){
   const g=state.goalAgent,c=g?.suggestion;if(locked()||!c||!fresh(g))return;
   const source=state.segments.find(s=>s.id===c.segmentId),oldScripts=state.scripts,oldGoal=structuredClone(g);
   if(state.scripts[c.segmentId])throw Error('这段讲稿已更新，请先检查当前讲稿，避免覆盖。');
   state.scripts=acceptDraft(state.scripts,g.flow?.result,source.text,c.title);
   g.history.push({type:'adopt',roundId:g.current.roundId,segmentId:c.segmentId,quote:c.quote});
   g.adoptedThisRound=true;g.suggestion=null;g.flow=null;g.run=localRun({action:'rehearse',message:'练习稿已更新。重新讲一次，检查实际用时。'});
   try{await persist();}catch(e){state.scripts=oldScripts;state.goalAgent=oldGoal;throw e;}
   render();
 }
 return {render};
}
