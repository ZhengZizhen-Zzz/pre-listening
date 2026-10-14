import {formatTime} from './core.mjs';
import {retryRead} from './retry-read.mjs';
const active=run=>['planning','running'].includes(run?.status);
export function createCoach({state,$,escape:esc,getSession,workspace,api,health,setBusy,message,training,view,waitForMaterial}){
  let polling=false,paintKey='',mutating=false;
  const host=$('coach-output'),command=$('coach-command');
  const unchanged=()=>state.coach&&JSON.stringify(getSession())===JSON.stringify(state.coach.session);
  const persist=async()=>{if(!await workspace.saveNow())message('本次任务已显示，但本机保存失败。请先保留页面。',true);};
  const errorText=e=>e.name==='TimeoutError'?'连接暂时中断，任务可能仍在处理。点击“继续查看”即可恢复。':e.message;
  function render(){
    const record=state.coach,run=record?.run,locked=state.busy||state.recording;
    $('coach-panel').hidden=!state.pages.length||state.demo||(!state.segments.some(s=>s.text.trim())&&!run);
    $('coach-submit').disabled=locked||active(run)||!state.segments.some(s=>s.text.trim())||!state.health?.textConfigured;
    command.disabled=locked||active(run);document.querySelectorAll('[data-coach-example]').forEach(b=>b.disabled=locked||active(run));
    const key=JSON.stringify([state.id,run,Boolean(unchanged()),locked]);if(key===paintKey)return;paintKey=key;
    if(!run){host.replaceChildren();return;}
    if(!command.value)command.value=run.command;
    const fresh=unchanged(),r=run.results||{},plan=run.plan;
    const trace=(run.trace||[]).map(t=>`<li><span>${t.status==='complete'?'✓':t.status==='failed'?'未完成':'处理中'}</span>${esc(t.label)}</li>`).join('');
    host.innerHTML=`${!fresh?'<p class="coach-note">材料或发言已变化，下面保留的是上次结果；请重新安排本次练习。</p>':''}
      <p class="coach-state" role="status">${esc(run.message||(run.status==='planning'?'正在理解你想练什么…':run.status==='running'?'正在结合这次演练准备…':run.status==='ready'?'按下面的目标开始练习：':''))}</p>
      ${plan?.status==='ready'?`<div class="coach-plan"><strong>${esc(plan.summary)}</strong><p>${plan.pages.length?`第 ${plan.pages.map(esc).join('、')} 页`:'整场汇报'}${plan.focus?` · ${esc(plan.focus)}`:''}${plan.actions.includes('compress')?` · 整场目标 ${formatTime(plan.targetSeconds)}`:''}${plan.actions.includes('questions')?` · ${plan.questionCount} 道问题`:''}</p></div>`:''}
      ${trace?`<details class="coach-progress" ${active(run)?'open':''}><summary>处理进度</summary><ol>${trace}</ol></details>`:''}
      <div class="coach-actions">${run.status==='ready'&&fresh?'<button type="button" class="button primary" data-coach-start>开始准备</button>':''}${active(run)?'<button type="button" class="button secondary" data-coach-poll>继续查看</button><button type="button" class="text-button" data-coach-cancel>停止任务</button>':''}${['failed','partial'].includes(run.status)&&run.retries<1&&fresh?'<button type="button" class="button secondary" data-coach-retry>重试未完成步骤</button>':''}</div>
      ${Object.entries(run.failures||{}).map(([action,error])=>`<p class="coach-note">${esc(({compress:'压缩方案',diagnose:'表达建议',questions:'听众问题'})[action]||'任务')}：${esc(error)}</p>`).join('')}
      ${r.timing?`<section class="coach-result"><h3>实际用时</h3><p>${esc(r.timing.note)}</p>${r.timing.reliable?`<p>总用时 ${formatTime(r.timing.durationSeconds)} · 目标 ${formatTime(r.timing.targetSeconds)}</p><div class="coach-times">${r.timing.pages.map(p=>`<span>第 ${p.page} 页 <b>${formatTime(p.seconds)}</b></span>`).join('')}</div>`:''}</section>`:''}
      ${r.investigation?.checkedPages?.length?`<p class="coach-note">本次重点查证了第 ${r.investigation.checkedPages.map(esc).join('、')} 页，并结合全场发言核对。${esc(r.investigation.note||'')}</p>`:''}
      ${r.compress?`<section class="coach-result"><h3>压缩练习方案</h3>${r.compress.message?`<p>${esc(r.compress.message)}</p>`:(r.compress.items||[]).map(i=>`<article><strong>第 ${i.page} 页 · ${formatTime(i.currentSeconds)} → 试讲 ${formatTime(i.targetSeconds)}</strong><p>${esc(i.action)}</p><details><summary>对照原话</summary><p>保留：${esc(i.keepQuote)}</p><p>合并或缩短：${esc(i.cutQuote)}</p></details></article>`).join('')}<p class="coach-note">${esc(r.compress.note||'')}</p></section>`:''}
      ${r.diagnose?`<section class="coach-result"><h3>${plan.pages.length?'所选页表达建议':'表达建议'}</h3><p>${esc(r.diagnose.summary)}</p>${r.diagnose.issues.map(i=>`<article><strong>第 ${i.page||'待确认'} 页 · ${esc(i.title)}</strong><blockquote>${esc(i.quote)}</blockquote><p>${esc(i.suggestion)}</p></article>`).join('')}${fresh?'<button type="button" class="button secondary" data-coach-review>在复盘中修改与重练</button>':''}</section>`:''}
      ${r.questions?`<section class="coach-result"><h3>针对性听众问题</h3><ol>${r.questions.questions.map(q=>`<li><strong>${esc(q.question)}</strong><p class="coach-note">第 ${q.page||'待确认'} 页 · ${esc(q.rubric?.purpose||'')}</p></li>`).join('')}</ol>${fresh?'<button type="button" class="button primary" data-coach-practice>开始逐题回答</button>':''}</section>`:''}`;
    host.querySelector('[data-coach-start]')?.addEventListener('click',()=>change('start'));
    host.querySelector('[data-coach-retry]')?.addEventListener('click',()=>change('retry'));
    host.querySelector('[data-coach-cancel]')?.addEventListener('click',()=>change('cancel'));
    host.querySelector('[data-coach-poll]')?.addEventListener('click',()=>poll());
    host.querySelector('[data-coach-review]')?.addEventListener('click',async()=>{
      if(state.busy||state.recording||!unchanged())return;
      workspace.replaceReport({...r.diagnose,...(r.compress?.items?{timePlan:r.compress}:{})});
      $('target-minutes').value=String(plan.targetSeconds/60);
      await persist();view('review');
    });
    host.querySelector('[data-coach-practice]')?.addEventListener('click',()=>{if(!state.busy&&!state.recording&&unchanged())training.openQuestions(r.questions,record.session);});
    host.querySelectorAll('button').forEach(b=>{if(!b.hasAttribute('data-coach-cancel')&&!b.hasAttribute('data-coach-poll'))b.disabled=locked;});
    if(active(run)&&!polling&&!mutating)queueMicrotask(()=>poll());
  }
  async function poll(){
    if(polling||!active(state.coach?.run))return;
    polling=true;const record=state.coach,id=record.run.id,parent=state.id;
    try{
      await health();
      while(state.id===parent&&state.coach===record&&active(record.run)){
        const next=await retryRead(()=>api(`/api/coach/${id}`,{signal:AbortSignal.timeout(15000)}));
        if(state.id!==parent||state.coach!==record)break;
        record.run=next;render();await persist();
        if(active(next))await new Promise(resolve=>setTimeout(resolve,1800));
      }
    }catch(e){if(state.coach===record){if(e.status===404){record.run.status='expired';record.run.message=e.message;render();await persist();}else message(errorText(e),true);}}
    finally{polling=false;}
  }
  async function change(action){
    if(mutating||!state.coach)return;
    if(action!=='cancel'&&(state.busy||state.recording||!unchanged()))return;
    mutating=true;const record=state.coach;
    try{await health();record.run=await api(`/api/coach/${record.run.id}/${action}`,{method:'POST'});await persist();render();}
    catch(e){message(errorText(e),true);}
    finally{mutating=false;if(active(record.run))void poll();}
  }
  $('coach-form').addEventListener('submit',async event=>{
    event.preventDefault();if(state.busy||state.recording||active(state.coach?.run))return;
    const text=command.value.trim();if(!text)return;
    setBusy(true);mutating=true;message('');
    try{
      await waitForMaterial();await health();
      if(!await workspace.saveNow())throw new Error('发言尚未保存，请保留页面后重试。');
      const session=structuredClone(getSession());
      const run=await api('/api/coach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:text,session}),signal:AbortSignal.timeout(15000)});
      state.coach={run,session};await persist();render();
    }catch(e){message(errorText(e),true);}
    finally{mutating=false;setBusy(false);void poll();}
  });
  document.querySelectorAll('[data-coach-example]').forEach(b=>b.addEventListener('click',()=>{command.value=b.dataset.coachExample;command.focus();}));
  return {render};
}
