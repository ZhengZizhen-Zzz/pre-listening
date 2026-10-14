import {appendRecordingPart} from './recording-parts.mjs';
import {retryRead} from './retry-read.mjs';
import { demoTrainingRun } from './demo-training.mjs';
import { pageLabel } from './core.mjs';
import { validateSession, formatTime } from './core.mjs';
import { newAttempt, newTrainingRun, appendTrainingQuestion, drillBaseline, MAX_QUESTIONS, questionCountFor, prepareQuestionTurns, trainingProgress, previousAnsweredAttempt, questionKey } from './training-core.mjs';
import { practiceFromDraft } from './answer-revision-core.mjs';
import { localRecords } from './storage.mjs';
import { startShortRecording } from './short-recording.mjs';
import { acquireRecordingLock } from './recording-lock.mjs';
import { extractSpeechTerms, cleanSpeechTerms } from './speech-terms.mjs';
import {QuestionPrefetch} from './question-prefetch.mjs';

export function createTraining({state, $, escape:esc, getSession, setBusy, health, api, message, confirmAction, slidePreview, slidePreviews}) {
  const dialog = $('training-dialog');
  const chrome = dialog.querySelector('.training-chrome');
  new ResizeObserver(() => dialog.style.setProperty('--training-chrome-height', `${chrome.offsetHeight}px`)).observe(chrome);
  let run, turnIndex = 0, attemptIndex = 0, busy = false, capture, audioUrl, pendingBlob, pendingSave = false;
  let saveChain = Promise.resolve(), editTimer, pollCancelled = false, releaseEditor, audioVersion = 0;
  let questionPolling=false,questionEpoch=0;
  let warmTimer;const selectedAudioParts=new Map();
  const prefetch=new QuestionPrefetch({api,storage:localRecords,onChange:entry=>{
    if(dialog.open&&run?.kind==='answer'&&!run.turns.length&&prefetch.key(run.session)===prefetch.key(entry.session))render();
  }});
  function scheduleQuestions(){
    clearTimeout(warmTimer);
    if(state.demo||!state.report||state.viewName!=='review')return;
    let session;try{session=validateSession(getSession());}catch{return;}
    const key=prefetch.key(session);let checks=0;
    const begin=()=>{
      if(state.demo||state.recording||!state.report||state.viewName!=='review')return;
      try{if(prefetch.key(validateSession(getSession()))!==key)return;}catch{return;}
      if(!state.health?.textConfigured){if(++checks<10)warmTimer=setTimeout(begin,1500);return;}
      prefetch.prepare(session);
    };
    warmTimer=setTimeout(begin,1200);
  }
  const currentTurn = () => run.turns[turnIndex];
  const currentAttempt = () => currentTurn()?.attempts[attemptIndex];
  const status = (text = '', error = false) => { $('training-status').textContent=text; $('training-status').classList.toggle('error',error); };
  const save = async () => {
    if (run?.previewOnly) return;
    clearTimeout(editTimer); pendingSave = true;
    run.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(run);
    const task = saveChain.catch(() => {}).then(() => localRecords.saveTraining(snapshot));
    saveChain = task;
    try { await task; if (saveChain === task) pendingSave = false; }
    catch { throw new Error('本机保存失败，请保留页面，先导出练习记录。'); }
  };
  const editorLock = parentId => new Promise((resolve,reject) => {
    if (!navigator.locks) return reject(new Error('请使用新版 Chrome 打开练习。'));
    navigator.locks.request(`rehearsal-training:${parentId}`,{ifAvailable:true},async lock => {
      if (!lock) return resolve(null);
      await new Promise(release => resolve(release));
    }).catch(reject);
  });
  async function renderEntry() {
    scheduleQuestions();
    const entry = $('training-entry'), parentId = state.id;
    entry.innerHTML = '<button type="button" class="button secondary" data-start-questions>模拟听众提问</button><details class="training-history" hidden><summary>练习记录</summary><div data-training-history></div></details>';
    entry.querySelector('[data-start-questions]').onclick = () => launch('answer');
    try {
      const runs = await localRecords.listTraining(parentId);
      if (state.id !== parentId) return;
      if(!state.demo){
        try{
          const session=validateSession(getSession()),key=prefetch.key(session);
          const prior=runs.find(r=>r.kind==='answer'&&prefetch.key(r.session)===key&&(r.questionPreparation?.status==='complete'||!r.questionPreparation));
          if(prior)prefetch.seed(session,prior.questions||prior.turns.map(t=>t.question),prior.questionMetadata);
        }catch{} // An old or invalid record cannot supply a preview question.
      }
      const host = entry.querySelector('[data-training-history]');
      const history=entry.querySelector('.training-history');
      history.hidden=!runs.length;
      history.querySelector('summary').textContent=`练习记录（${runs.length}）`;
      host.innerHTML = runs.map(item => `<button type="button" class="training-history-row" data-run="${esc(item.id)}"><span>${item.kind === 'answer' ? '听众提问' : `第 ${item.issue.page} 页重练`}</span><small>${esc(new Date(item.updatedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))} · ${item.turns.reduce((n,t)=>n+t.attempts.filter(a=>a.feedback).length,0)} 次反馈</small><span>继续 →</span></button>`).join('') || '<p class="muted">完成的练习会保存在这里。</p>';
      host.querySelectorAll('[data-run]').forEach(button => button.onclick = () => launch(null,null,runs.find(r=>r.id===button.dataset.run)));
    } catch { entry.querySelector('.training-history').hidden=false;entry.querySelector('[data-training-history]').textContent = '暂时无法读取本机记录。'; }
  }
  function bindIssues() {
    $('issues').querySelectorAll('[data-train-issue]').forEach(button => button.onclick = () => launch('drill',Number(button.dataset.trainIssue)));
  }
  async function launch(kind,index,saved) {
    if (state.busy || state.recording || dialog.open) return;
    if (state.demo && kind === 'answer') {
      try {
        run=demoTrainingRun(state.id,validateSession(getSession()),$('deck-name').textContent);
        turnIndex=0;attemptIndex=0;pendingBlob=null;busy=false;setBusy(true);
        status();dialog.showModal();render();
      } catch(e) {setBusy(false);message(e.message,true);}
      return;
    }
    if (state.demo) return message('单页重练需要你自己的发言。示例可体验听众提问与回答点评。');
    const feedback = state.feedback?.[index], flow = state.rewrites?.[index], issue = state.report?.issues[index];
    if (kind === 'drill' && (feedback?.judgment === 'incorrect' || feedback?.adoption === 'no')) return message('你已标记不认可这条建议，暂不据此重练。');
    if (kind === 'drill' && issue?.action === 'clarify' && !flow?.answers?.length) return message('请先在这条建议中回答需要确认的问题，再开始重练。');
    setBusy(true);
    try {
      document.querySelectorAll('audio').forEach(audio=>audio.pause());
      releaseEditor = await editorLock(state.id);
      if (!releaseEditor) throw new Error('另一页已打开这场汇报的练习，请先关闭那边的练习窗口。');
      if (saved) {
        const releaseRecording = await acquireRecordingLock();
        if (!releaseRecording) throw new Error('另一页正在录音，请结束后再恢复练习。');
        try { run = await localRecords.recoverTraining(saved); } finally { releaseRecording(); }
      } else {
        run = newTrainingRun(state.id,kind,validateSession(getSession()),{ deckName:$('deck-name').textContent,asrTerms:state.asrTerms,
          ...(kind === 'drill' ? {issue,answers:flow?.answers||[],reference:state.scripts?.[issue.segmentId]?.text||''} : {}) });
        await save();
      }
      run = prepareQuestionTurns(run);
      $('training-count').innerHTML = Array.from({length:8},(_,i)=>`<option value="${i+3}">${i+3} 题</option>`).join('');
      $('training-count').value = String(questionCountFor(run.session));
      turnIndex = Math.max(0,trainingProgress(run).next); attemptIndex = Math.max(0,currentTurn()?.attempts.length-1||0);
      pendingBlob=null; busy=false; dialog.showModal(); render();
      if(kind==='answer'&&!saved)prefetch.prepare(run.session);
      if(run.questionPreparation&&['pending','reviewing'].includes(run.questionPreparation.status))resumeQuestionJob();
    } catch(e) { releaseEditor?.();releaseEditor=null;setBusy(false);message(e.message,true); }
  }
  function drawAudio(attempt) {
    const version = ++audioVersion;
    $('training-audio').pause();$('training-audio').removeAttribute('src');$('training-audio').load();
    if (audioUrl) URL.revokeObjectURL(audioUrl);audioUrl=null;
    const id = attempt?.id;
    const parts=attempt?.audioParts||[],selected=parts.find(p=>p.assetId===selectedAudioParts.get(id))||parts.at(-1);
    const picker=$('training-part-picker');picker.hidden=parts.length<2;picker.disabled=!!capture;picker.innerHTML=parts.map((p,i)=>`<option value="${esc(p.assetId)}">第 ${i+1} 段 · ${formatTime(p.duration)}</option>`).join('');picker.value=selected?.assetId||'';
    const load = pendingBlob ? Promise.resolve(pendingBlob) : localRecords.getAsset(selected?.assetId||attempt?.audioAssetId);
    load.then(blob => {
      if (!dialog.open || version !== audioVersion || currentAttempt()?.id !== id || !blob) return;
      audioUrl = URL.createObjectURL(blob);const player=$('training-audio'),download=$('training-audio-download');
      player.src=audioUrl;player.hidden=false;download.href=audioUrl;download.hidden=false;
      download.download=`${run.kind==='drill'?'单页重练':'问题回答'}-${id.slice(0,8)}.${blob.type.includes('mp4')?'m4a':blob.type.includes('ogg')?'ogg':'webm'}`;
    }).catch(()=>status('录音暂时无法读取，文字仍可查看。',true));
  }
  $('training-part-picker').onchange=()=>{const a=currentAttempt();if(a){selectedAudioParts.set(a.id,$('training-part-picker').value);drawAudio(a);}};
  function render() {
    if (!run || !dialog.open) return;
    const drill=run.kind==='drill',turn=currentTurn(),attempt=currentAttempt(),q=turn?.question||(!drill?prefetch.peek(run.session)?.questions?.[0]:null),progress=trainingProgress(run);
    $('training-progress').hidden=drill||!run.turns.length;
    $('training-progress').textContent=`已练 ${progress.completed} / ${progress.total} 题`;
    $('training-setup').hidden=drill||Boolean(turn);
    $('training-count').disabled=busy;
    $('training-title').textContent=drill ? '单页重练' : '模拟听众提问';
    $('training-eyebrow').textContent=drill ? `${pageLabel(run.issue.page)} · 局部重练` : `听众：${run.session.audience}`;
    $('training-nav').innerHTML=!drill&&run.turns.length ? run.turns.map((t,i)=>`<button type="button" data-turn="${i}" aria-label="第${i+1}题：${esc(t.question.question)}${!run.previewOnly&&t.attempts.some(a=>a.feedback)?'，已反馈':''}" ${i===turnIndex?'aria-current="step"':''} title="${esc(t.question.question)}" class="${i===turnIndex?'active':''} ${!run.previewOnly&&t.attempts.some(a=>a.feedback)?'done':''}" ${busy?'disabled':''}>${i+1}${!run.previewOnly&&t.attempts.some(a=>a.feedback)?'<span aria-hidden="true">✓</span>':''}</button>`).join('') : '';
    $('training-nav').querySelectorAll('[data-turn]').forEach(b=>b.onclick=async()=>{if(busy||capture)return;if(await safeSave()){turnIndex=Number(b.dataset.turn);attemptIndex=currentTurn().attempts.length-1;pendingBlob=null;status();render();dialog.scrollTop=0;}});
    const page=drill?run.issue.page:q?.page??run.session.pages[0]?.number;
    const baseline=drill?drillBaseline(run.session,run.issue):null;
    $('training-context').innerHTML=page!==undefined ? `${page>0?slidePreview(page):'<p class="training-source-label">发言页码待确认</p>'}${drill||q?`<details><summary>对照${drill?'原发言':'提问依据'}</summary><blockquote>${esc(drill?baseline.text:q.previousAnswer?.quote||q.evidence.quote)}</blockquote></details>`:''}${drill&&run.reference?`<details><summary>我已采用的参考说法</summary><p>${esc(run.reference)}</p></details>`:''}` : '';
    $('training-context').hidden=page===undefined;
    dialog.classList.toggle('training-setup-mode',!turn);
    dialog.querySelector('.training-progress-row').hidden=drill||!run.turns.length;
    if(page) slidePreviews.render($('training-context'));
    dialog.querySelector('.training-question-block').hidden=!drill&&!q;
    $('training-question').textContent=drill ? run.issue.suggestion : q?.question||'';
    $('training-rubric').hidden=drill||!q?.rubric;
    $('training-rubric-content').innerHTML=q?.rubric?`<p>${esc(q.rubric.purpose)}</p><ul>${q.rubric.criteria.map(c=>`<li><strong>${esc(c.label)}</strong><span>${esc(c.description)}</span></li>`).join('')}</ul>`:'';
    $('training-focus').textContent=drill ? `本次只练：${run.issue.title}` : q?.previousAnswer ? '追问' : '';
    $('training-generate').hidden=Boolean(turn);$('training-generate').disabled=busy;
    $('training-generate').textContent=questionPolling?'正在准备…':run.questionPreparation?'继续获取问题':q?'开始练习':'生成问题';
    $('training-resume').hidden=!turn||!run.questionPreparation||run.questionPreparation.status==='complete'||questionPolling;
    $('training-resume').disabled=busy;
    $('training-resume').textContent=run.questionPreparation?.status==='failed'?'重试准备点评':'继续获取问题';
    $('training-attempt').hidden=!attempt;
    if(attempt) {
      const completed=Boolean(attempt.feedback),interrupted=attempt.recordingStatus==='interrupted';
      $('training-answer-label').textContent=drill?'这一页，现在这样讲':attempt.source==='draft'?'参考回答（可修改）':'我的回答';
      $('training-answer').value=attempt.text;
      $('training-answer').disabled=busy||completed||Boolean(capture);
      $('training-answer').placeholder=drill?'重新讲这一整页，录音后转写，或直接输入。':'录音回答，或直接输入。';
      $('training-record').hidden=completed;$('training-record').disabled=busy&&!capture;
      $('training-record').textContent=capture?'结束录音':attempt?.recordingStatus==='interrupted'&&attempt.audioAssetId?'继续回答':'录音回答';
      $('training-transcribe').hidden=!(attempt.audioAssetId||attempt.jobId)||completed||Boolean(capture);
      $('training-transcribe').disabled=busy;
      $('training-transcribe').textContent=attempt.jobId && !['complete','failed','uncertain','expired'].includes(attempt.jobStatus)?'获取转写结果':attempt.text?'重新获取转写':'转写录音';
      $('training-audio').hidden=true;$('training-audio-download').hidden=true;drawAudio(attempt);
      $('training-timer').textContent=capture?'录音中':attempt.durationSeconds?`本次 ${formatTime(attempt.durationSeconds)}`:'';
      $('training-compare').textContent=drill?`上次本页 ${formatTime(baseline.seconds)} · 本次 ${formatTime(attempt.durationSeconds)}${baseline.seconds?'（含停顿）':''}`:'';
      $('training-compare').hidden=!drill;
      $('training-feedback-button').hidden=completed;
      $('training-feedback-button').disabled=busy||attempt.text.trim().length<4||interrupted||Boolean(run.questionPreparation&&run.questionPreparation.status!=='complete');
      $('training-feedback-button').textContent=run.questionPreparation&&run.questionPreparation.status!=='complete'?'点评准备中…':'查看回答点评';
      $('training-retry').hidden=!completed&&!interrupted;
      $('training-retry').disabled=busy;
      $('training-attempts').innerHTML=turn.attempts.length>1?`<label>本题练习 <select aria-label="查看练习次数" ${busy?'disabled':''}>${turn.attempts.map((a,i)=>`<option value="${i}" ${i===attemptIndex?'selected':''}>第 ${i+1} 次${a.feedback?' · 已反馈':''}</option>`).join('')}</select></label>`:'';
      $('training-attempts').querySelector('select')?.addEventListener('change',async e=>{if(await safeSave()){attemptIndex=Number(e.target.value);pendingBlob=null;render();}});
      renderFeedback(attempt);
      renderRevision(attempt);
      if(interrupted)status('这次录音曾中断，可回听已保存部分；请重新练一次再评价。',true);
    }
    $('training-close').disabled=(busy&&!questionPolling)||Boolean(capture);
    $('training-pause').hidden=!busy||!attempt?.jobId||Boolean(capture);
    if(run.previewOnly){
      $('training-eyebrow').textContent='示例 · 预设内容';
      $('training-progress').textContent=`第 ${turnIndex+1} / ${run.turns.length} 题`;
      $('training-answer-label').textContent='示例回答';
      $('training-retry').hidden=true;
      $('training-followup').hidden=true;
      $('training-next').hidden=turnIndex===run.turns.length-1;
      $('training-finished').hidden=true;
    }
  }
  function renderFeedback(attempt) {
    const fb=attempt.feedback,drill=run.kind==='drill';
    const labels={met:'已做到',partly:'还可完善',not_yet:'还没做到',uncertain:'需要确认'};
    const changes={improved:'有改善',regressed:'还需留意',steady:'保持',uncertain:'待确认'};
    const beforeIndex=currentTurn().attempts.findIndex(a=>a.id===attempt.comparedWithAttemptId);
    const comparison=fb?.comparison?`<section class="training-difference"><h4>${beforeIndex>=0?`与第 ${beforeIndex+1} 次回答对照`:'与上次回答对照'}</h4>${fb.comparison.checks.map(c=>`<details><summary><span>${esc(c.label)}</span><span class="training-verdict ${c.change}">${changes[c.change]}</span></summary><div class="training-quote-pair"><div><small>上次 · ${labels[c.beforeAssessment]}</small><blockquote>${esc(c.beforeQuote)}</blockquote></div><div><small>本次 · ${labels[c.afterAssessment]}</small><blockquote>${esc(c.afterQuote)}</blockquote></div></div><p>${esc(c.reason)}</p></details>`).join('')}</section>`:'';
    $('training-feedback').innerHTML=fb?`<div class="training-result-heading"><span>${run.previewOnly?'示例点评':'回答点评'}</span></div><h3>${esc(fb.summary)}</h3><div class="training-next-step"><strong>下次重点</strong><p>${esc(fb.nextStep)}</p></div><details class="training-feedback-details"><summary>查看详细点评</summary>${comparison || `<div class="training-checks">${fb.checks.map(c=>`<section class="training-check"><div><span>${esc(c.label)}</span><span class="training-verdict ${c.assessment}">${labels[c.assessment]}</span></div><blockquote>“${esc(c.quote)}”</blockquote><p>${esc(c.reason)}</p></section>`).join('')}</div>`}</details>`:'';
    const progress=trainingProgress(run);
    const hasNext=!drill&&fb&&run.turns.some((t,i)=>i!==turnIndex&&!t.attempts.some(a=>a.feedback));
    $('training-next').hidden=!hasNext;
    $('training-followup').hidden=!(!drill&&fb?.followup&&run.turns.length<MAX_QUESTIONS&&!run.turns.some(t=>t.question.question===fb.followup.question));
    $('training-next').disabled=busy;$('training-followup').disabled=busy;
    $('training-finished').hidden=drill||!progress.complete;
    $('training-finished').textContent=`本组 ${progress.total} 题已练完。可以切换题目回看反馈，或再练一次。`;

  }
  function renderRevision(attempt) {
    const host=$('training-revision');
    host.hidden=Boolean(run.previewOnly)||run.kind!=='answer'||!attempt.feedback;
    if(host.hidden){host.innerHTML='';return;}
    const flow=attempt.revision, result=flow?.result;
    if(!result) host.innerHTML=`<button type="button" class="button secondary" data-answer-rewrite ${busy?'disabled':''}>帮我把这段回答说清楚</button>`;
    else if(result.status==='needs_input') host.innerHTML=`<div class="training-clarify"><label for="training-clarification">${esc(result.question)}</label><textarea id="training-clarification" rows="3" maxlength="2000" placeholder="按你的实际情况说，没有相关信息也可以直接说明。" ${busy?'disabled':''}>${esc(flow.pendingAnswer||'')}</textarea><button type="button" class="button primary" data-answer-clarify ${busy||!flow.pendingAnswer?.trim()?'disabled':''}>补充后整理</button></div>`;
    else if(result.status==='draft') host.innerHTML=`<div class="training-draft"><h4>参考说法</h4><p class="training-draft-text">${esc(result.revisedText)}</p><p class="training-draft-reason">${esc(result.reason)}</p><button type="button" class="button secondary" data-answer-adopt ${busy?'disabled':''}>用这版再练</button></div>`;
    else host.innerHTML=`<p class="training-keep">${esc(result.reason)}</p>`;
    host.querySelector('[data-answer-rewrite]')?.addEventListener('click',()=>rewriteCurrentAnswer(false));
    host.querySelector('[data-answer-clarify]')?.addEventListener('click',()=>rewriteCurrentAnswer(true));
    host.querySelector('#training-clarification')?.addEventListener('input',e=>{
      if(busy)return;flow.pendingAnswer=e.target.value;pendingSave=true;
      host.querySelector('[data-answer-clarify]').disabled=!flow.pendingAnswer.trim();
      clearTimeout(editTimer);editTimer=setTimeout(()=>safeSave(),450);
    });
    host.querySelector('[data-answer-adopt]')?.addEventListener('click',async()=>{
      if(busy||capture||!await safeSave())return;
      try {
        const next=practiceFromDraft(attempt,result,newAttempt);
        currentTurn().attempts.push(next);attemptIndex=currentTurn().attempts.length-1;pendingBlob=null;
        await save();status('参考说法已放入新一次练习，可以继续调整或录音重讲。');render();
        $('training-answer').focus();
      }catch(e){status(e.message,true);}
    });
  }
  function rewriteCurrentAnswer(clarify) {
    return task('正在整理这段回答…',async()=>{
      const a=currentAttempt(),flow=a.revision||{answers:[]};
      const answers=[...flow.answers];
      if(clarify){if(flow.result?.status!=='needs_input'||!flow.pendingAnswer?.trim())return;answers.push({question:flow.result.question,answer:flow.pendingAnswer.trim()});}
      const result=await model('rewrite',{session:run.session,question:currentTurn().question,answer:a.text,feedback:a.feedback,answers});
      // Keep the pending clarification intact if the API fails; never duplicate
      // it on retry or replace the original answer with an unaccepted draft.
      a.revision={answers,result,pendingAnswer:''};
    });
  }
  async function safeSave() {try {await save();return true;}catch(e){status(e.message,true);return false;}}
  async function task(label, action) {
    if(busy||capture)return;
    busy=true;status(label);render();
    try {await save();await action();await save();status();}
    catch(e){status(e.name==='TimeoutError'?'等待超时，内容已保留。可以稍后重试。':e.message||'操作未完成，请重试。',true);}
    finally{busy=false;render();}
  }
  async function model(kind,body) {
    if(run?.previewOnly)throw new Error('示例仅展示预设内容，请使用自己的材料开始真实练习。');
    await health();
    return api(`/api/training/${kind}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(110000)});
  }
  async function resumeQuestionJob() {
    if(questionPolling||capture||busy)return;
    questionPolling=true;let firstPending=!run.turns.length;busy=firstPending;const epoch=++questionEpoch,runId=run.id;
    status(run.turns.length?'可以先回答，点评要点准备中…':'正在生成问题…');render();
    try{
      run.questionPreparation??={status:'pending',count:Number($('training-count').value)};
      await save();if(!state.health?.csrf)await health();
      const selected=run.questionPreparation.count;
      let warmFailed=false;
      if(!run.questionPreparation.id){
        const preparing=prefetch.prepare(run.session);
        const immediate=prefetch.peek(run.session);
        if(immediate?.questions.length&&!run.turns.length){run.questions=immediate.questions.slice(0,selected);run=prepareQuestionTurns(run);busy=false;firstPending=false;render();await save();}
        const warmed=await preparing;
        warmFailed=warmed.status==='failed';
        if(epoch!==questionEpoch||run.id!==runId||!dialog.open)return;
        if(warmed.status==='complete'&&warmed.questions.length>=selected){
          run.questions=warmed.questions.slice(0,selected);run=prepareQuestionTurns(run);
          run.questionPreparation={status:'complete',count:selected};run.questionMetadata={model:warmed.result?.model,usage:warmed.result?.usage,promptVersion:warmed.result?.promptVersion};
          if(firstPending)busy=false;firstPending=false;await save();if(!busy&&!capture){status();render();}return;
        }
        if(warmed.questions.length&&!run.turns.length){run.questions=warmed.questions.slice(0,selected);run=prepareQuestionTurns(run);busy=false;firstPending=false;await save();render();}
      }
      let job;
      if(run.questionPreparation?.id&&run.questionPreparation.status!=='failed')job=await retryRead(()=>api(`/api/training/question-jobs/${encodeURIComponent(run.questionPreparation.id)}`,{signal:AbortSignal.timeout(15000)}));
      else job=await api('/api/training/question-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:run.session,count:selected,retry:run.questionPreparation?.status==='failed'||warmFailed,...(run.questions?.length?(run.questions.length===selected?{prepared:{questions:run.questions}}:{seedQuestions:run.questions}):{})}),signal:AbortSignal.timeout(15000)});
      const began=Date.now();
      while(dialog.open&&epoch===questionEpoch&&run.id===runId){
        const changed=run.questionPreparation?.status!==job.status||run.questionPreparation?.id!==job.id;
        run.questionPreparation={id:job.id,status:job.status,count:run.questionPreparation?.count||Number($('training-count').value),retryable:job.retryable};
        if(job.questions.length&&(job.questions.length>run.turns.length||job.status==='complete')){
          run.questions=job.questions;run=prepareQuestionTurns(run);
          for(const turn of run.turns){const question=job.questions.find(q=>questionKey(q)===questionKey(turn.question));if(question)turn.question=question;}
          run.questionMetadata=job.result?{model:job.result.model,usage:job.result.usage,promptVersion:job.result.promptVersion}:{};
          if(firstPending){busy=false;firstPending=false;}await save();
          // Do not interrupt an active recording or another action to redraw.
          if(!capture&&!busy)render();
          if(!busy&&!capture)status(job.status==='complete'?'':'可以先回答，点评要点准备中…');
        }else if(changed)await save();
        if(job.status==='complete')return;
        if(job.status==='failed')throw new Error(job.error||'问题准备未完成，请重试。');
        if(Date.now()-began>240000)throw new Error('准备时间较长，内容已保留。可以稍后继续获取。');
        await new Promise(resolve=>setTimeout(resolve,1000));
        if(!dialog.open||epoch!==questionEpoch||run.id!==runId)return;
        job=await retryRead(()=>api(`/api/training/question-jobs/${encodeURIComponent(job.id)}`,{signal:AbortSignal.timeout(15000)}));
      }
    }catch(e){
      if(epoch===questionEpoch&&run.id===runId){
        if(e.status===404&&run.questionPreparation)run.questionPreparation.status='failed';
        status(e.name==='TimeoutError'?'连接暂时未响应，可以继续获取问题。':e.message||'问题准备未完成，请重试。',true);await safeSave();
      }
    }finally{if(epoch===questionEpoch&&run.id===runId){questionPolling=false;if(firstPending)busy=false;if(!busy&&!capture)render();}}
  }
  $('training-generate').onclick=resumeQuestionJob;
  $('training-resume').onclick=resumeQuestionJob;
  $('training-answer').oninput=()=>{
    const a=currentAttempt();if(!a||a.feedback||busy)return;
    a.text=$('training-answer').value;a.source=a.audioAssetId?'edited':'manual';pendingSave=true;
    $('training-feedback-button').disabled=a.text.trim().length<4||a.recordingStatus==='interrupted'||Boolean(run.questionPreparation&&run.questionPreparation.status!=='complete');
    clearTimeout(editTimer);editTimer=setTimeout(()=>safeSave(),450);
  };
  $('training-feedback-button').onclick=()=>task('正在对照原文，查看这次练习…',async()=>{
    if(run.questionPreparation&&run.questionPreparation.status!=='complete')throw new Error('点评要点仍在准备中，可以先填写回答。');
    const a=currentAttempt();
    const previous=run.kind==='answer'?previousAnsweredAttempt(currentTurn(),attemptIndex):null;
    const request={session:run.session,answer:a.text,durationSeconds:a.durationSeconds,
      ...(previous?{previousAttempt:{answer:previous.text,feedback:previous.feedback}}:{}),
      ...(run.kind==='drill'?{issue:run.issue,answers:run.answers}:{question:currentTurn().question})};
    a.feedback=await model(run.kind,request);
    if(previous)a.comparedWithAttemptId=previous.id;
  });
  async function anotherAttempt() {
    if(busy||capture)return;
    if(!await safeSave())return;
    currentTurn().attempts.push(newAttempt());attemptIndex=currentTurn().attempts.length-1;pendingBlob=null;
    await safeSave();status();render();
  }
  $('training-retry').onclick=anotherAttempt;
  async function nextQuestion(followup) {
    if(busy||capture)return;
    if(run.previewOnly){turnIndex=Math.min(turnIndex+1,run.turns.length-1);attemptIndex=0;render();dialog.scrollTop=0;return;}
    if(!await safeSave())return;
    try {
      if(followup){
        const q=currentAttempt()?.feedback?.followup;if(!q)return;
        run=appendTrainingQuestion(run,q);turnIndex=run.turns.length-1;
      } else {
        const pending=run.turns.map((t,i)=>({t,i})).filter(({t,i})=>i!==turnIndex&&!t.attempts.some(a=>a.feedback));
        const next=pending.find(({i})=>i>turnIndex)||pending[0];if(!next)return;turnIndex=next.i;
      }
      attemptIndex=currentTurn().attempts.length-1;pendingBlob=null;await save();status();render();
    }catch(e){status(e.message,true);}
  }

  $('training-next').onclick=()=>nextQuestion(false);$('training-followup').onclick=()=>nextQuestion(true);
  $('training-record').onclick=async()=>{
    if(capture){capture.stop();return;}if(busy)return;
    const a=currentAttempt();
    const continuing=a.recordingStatus==='interrupted'&&!!a.audioAssetId;
    if(!continuing&&(a.text||a.audioAssetId)){if(!await confirmAction('重新录音会开始一次新练习，当前文字和录音仍保留在练习记录里。'))return;await anotherAttempt();}
    const attempt=currentAttempt(),offset=continuing?(attempt.durationSeconds||0):0,previousStatus=attempt.recordingStatus;
    busy=true;status('正在连接麦克风…');render();
    try {
      attempt.recordingOffset=offset;attempt.recordingStatus='recording';await save();
      capture=await startShortRecording({onTick:seconds=>{$('training-timer').textContent=formatTime(offset+seconds);},
        onChunk:async(blob,index,seconds)=>{attempt.durationSeconds=offset+seconds;await localRecords.checkpointTraining(structuredClone(run),attempt.id,blob,index);},
        onError:error=>status(error.message,true)});
      status('');render();
      const result=await capture.done;capture=null;pendingBlob=result.blob;
      attempt.durationSeconds=offset+result.durationSeconds;attempt.recordingStatus=result.error?'interrupted':'complete';
      if(!result.blob.size)throw new Error('没有收到声音，请检查麦克风后重新练习。');
      const id=await localRecords.finishTraining(run,attempt.id,result.blob);attempt.audioParts=appendRecordingPart(attempt,id);attempt.audioAssetId=id;pendingBlob=null;await save();
      status(result.error?result.error.message:'录音已保存，转写后核对一下发言。',Boolean(result.error));
    } catch(e){attempt.recordingStatus=e.name==='AbortError'?previousStatus:'interrupted';pendingSave=true;await safeSave();status(e.name==='AbortError'?'':e.message,e.name!=='AbortError');}
    finally{busy=false;capture=null;render();}
  };
  $('training-transcribe').onclick=()=>task('正在转写这次练习…',async()=>{
    const a=currentAttempt();pollCancelled=false;
    await health();if(!state.health?.asrConfigured)throw new Error('语音转写未连接，可以先输入发言。');
    const parts=a.audioParts?.length?a.audioParts:[a];
    if(parts.some(part=>['failed','uncertain','expired'].includes(part.jobStatus))&&!await confirmAction('上次转写未成功。重新提交可能再次计费，是否继续？'))return;
    if(a.text&&!await confirmAction('获取转写会替换当前练习的文字。是否继续？'))return;
    a.terms ||= cleanSpeechTerms(run.asrTerms || extractSpeechTerms(run.session.pages));await save();
    for(const part of parts){
      if(part.transcribed)continue;
      const terminal=['failed','uncertain','expired'].includes(part.jobStatus);let job;
      if(part.jobId&&!terminal)job=await api(`/api/transcriptions/${encodeURIComponent(part.jobId)}`,{signal:AbortSignal.timeout(45000)});
      else {
        const blob=await localRecords.getAsset(part.assetId||part.audioAssetId);if(!blob)throw new Error('找不到这段录音，请先保留当前文字。');
        const form=new FormData();form.append('audio',blob,'practice.webm');form.append('terms',JSON.stringify(a.terms));if(terminal&&part.jobId)form.append('retryId',part.jobId);
        try{job=await api('/api/transcriptions',{method:'POST',body:form,signal:AbortSignal.timeout(120000)});}catch(e){if(e.jobId){part.jobId=e.jobId;part.jobStatus='uncertain';await save();}throw e;}
      }
      const began=Date.now();
      for(;;){
        part.jobId=job.id;part.jobStatus=job.status;a.jobId=job.id;a.jobStatus=job.status;await save();render();
        if(job.status==='complete'){
          part.transcriptText=job.segments.map(s=>s.text).join('');part.transcribed=true;
          a.text=parts.map(p=>p.transcriptText||'').filter(Boolean).join('\n');a.source='asr';await save();break;
        }
        if(['failed','uncertain','expired'].includes(job.status))throw new Error(job.error||'转写未完成，可以稍后重新提交。');
        if(pollCancelled||Date.now()-began>600000)return;
        await new Promise(resolve=>setTimeout(resolve,2500));if(pollCancelled)return;
        job=await api(`/api/transcriptions/${encodeURIComponent(part.jobId)}`,{signal:AbortSignal.timeout(45000)});
      }
      if(pollCancelled)return;
    }
  });
  $('training-pause').onclick=()=>{pollCancelled=true;status('正在保留转写任务…');};
  async function close() {
    if((busy&&!questionPolling)||capture){status('请先结束录音或等待当前操作完成。');return;}
    if(pendingBlob?.size){
      try{currentAttempt().audioAssetId=await localRecords.finishTraining(run,currentAttempt().id,pendingBlob);pendingBlob=null;}
      catch{status('录音尚未保存，请先下载录音，或释放浏览器存储后重试关闭。',true);return;}
    }
    if(!await safeSave())return;
    $('training-audio').pause();if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=null;
    questionEpoch++;questionPolling=false;busy=false;
    dialog.close();releaseEditor?.();releaseEditor=null;setBusy(false);renderEntry();
  }
  $('training-close').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  $('training-export').onclick=()=>{
    const lines=[...(run.previewOnly?['预设示例 · 非真实演练结果']:[]),run.kind==='drill'?'单页重练记录':'模拟听众提问记录',run.deckName,`听众：${run.session.audience}`,`保存时间：${run.updatedAt}`];
    for(const [i,t] of run.turns.entries()){
      lines.push('',run.kind==='drill'?`${pageLabel(run.issue.page)} · ${run.issue.title}`:`第 ${i+1} 题：${t.question.question}`);
      for(const [j,a] of t.attempts.entries())lines.push(`第 ${j+1} 次 · ${formatTime(a.durationSeconds)}`,a.text,...(a.feedback?[a.feedback.summary,...a.feedback.checks.map(c=>`${c.label}：${c.reason}\n依据：“${c.quote}”`),`下一次：${a.feedback.nextStep}`]:['尚未生成反馈']));
    }
    const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='针对性练习记录.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  window.addEventListener('beforeunload',e=>{if(capture||pendingSave){e.preventDefault();e.returnValue='';}});
  async function openQuestions(result,session) {
    if(state.busy||state.recording||dialog.open)return;
    const prepared=newTrainingRun(state.id,'answer',validateSession(session),{deckName:$('deck-name').textContent,asrTerms:state.asrTerms});
    prepared.questions=result.questions;prepared.questionMetadata={model:result.model,promptVersion:result.promptVersion};
    const ready=prepareQuestionTurns(prepared);
    try {await localRecords.saveTraining(ready);await launch(null,null,ready);}catch(e){message(e.message,true);}
  }
  return {renderEntry,bindIssues,openQuestions};
}
