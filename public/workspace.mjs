import {cleanImportedScript} from './script-import-core.mjs';
import {cleanOriginalNotes} from './pptx-notes.mjs';
import {appendRecordingPart} from './recording-parts.mjs';
import { completeCoachingReport } from './coaching-feedback.mjs';
import { localRecords } from './storage.mjs';
import { validateSession, validateReport, pageLabel, formatTime } from './core.mjs';
import { acceptDraft } from './revision-core.mjs';
import { readableReport } from './report-export.mjs';
import { compileScriptPages } from './transcript-core.mjs';
import { icon } from './icons.mjs';
import { acquireRecordingLock } from './recording-lock.mjs';
import { compareRounds, nextRoundBaseline } from './comparison-core.mjs';
import { contextualAdvice } from './coaching-core.mjs';

export function createWorkspace({ state, $, escape, paragraphs, message, setBusy, health, api, getSession, renderPage, renderSegments, renderReport, view, resetSession, openPdf, attachAudio, readMaterial, slidePreview, renderSlidePreviews }) {
  let timer, sequence = 0, comparisonVersion = 0, chain = Promise.resolve();
  const fresh = () => {
    const id = crypto.randomUUID();
    return { id, roundId: id, previousRoundId: null, comparisonChecks: {}, recordingStatus: null, recordingMime: '',
      job: null, jobStatus: null, jobTerms: null, jobError: '', jobApplied: false,
      createdAt: new Date().toISOString(), pdfAssetId: null, audioAssetId: null, parentId: null,
      audioParts: [],
      goalAgent:null, coach:null, feedback: {}, rewrites: {}, scripts: {}, importedScript: null, originalNotes: [], notesStatus: null, referenceScript: [], originalSegments: [], asrTerms: null, unsaved: false };
  };
  Object.assign(state, fresh());
  const saveLabel = (text, failed = false) => { $('save-status').textContent = text; $('save-status').classList.toggle('error', failed); };
  const audienceValue = () => $('audience').value === '__custom__' ? $('audience-custom').value.trim() : $('audience').value;
  const setAudience = value => {
    const known = [...$('audience').options].some(option => option.value === value);
    $('audience').value = known ? value : '__custom__';
    $('audience-custom').value = known ? '' : (value || '');
    $('audience-custom').hidden = known;
  };
  function snapshot() {
    return structuredClone({ schemaVersion: 3, id: state.id, createdAt: state.createdAt, updatedAt: new Date().toISOString(), title: $('deck-name').textContent,
      pages: state.pages, segments: state.segments, events: state.events, durationSeconds: state.duration, current: state.current,
      goals: { audience: audienceValue(), takeaways: $('takeaways').value, targetMinutes: $('target-minutes').value },
      demo: state.demo, goalAgent:state.goalAgent, coach:state.coach, report: state.report, pdfAssetId: state.pdfAssetId, audioAssetId: state.audioAssetId, audioParts: state.audioParts || [],
      roundId: state.roundId, previousRoundId: state.previousRoundId, comparisonChecks: state.comparisonChecks,
      recordingStatus: state.recordingStatus, recordingMime: state.recordingMime,
      recordingOffset: state.recordingOffset || 0,
      job: state.job, jobStatus: state.jobStatus, jobTerms: state.jobTerms, jobError: state.jobError, jobApplied: state.jobApplied,
      parentId: state.parentId, feedback: state.feedback, rewrites: state.rewrites, scripts: state.scripts, importedScript: state.importedScript, originalNotes: state.originalNotes, notesStatus: state.notesStatus, referenceScript: state.referenceScript, originalSegments: state.originalSegments, asrTerms:state.asrTerms });
  }
  function enqueue(record, version) {
    chain = chain.catch(() => {}).then(async () => {
      try {
        await localRecords.save(record);
        if (state.id === record.id && sequence === version) { state.unsaved = false; saveLabel('已保存在本机'); }
        return true;
      } catch {
        if (state.id === record.id) { state.unsaved = true; saveLabel('保存失败，请导出备份', true); } return false;
      }
    });
    return chain;
  }
  function saveSoon() {
    if (state.materialPending || !state.pages.length || state.recording) return;
    clearTimeout(timer); state.unsaved = true; saveLabel('正在保存…');
    const record = snapshot(), version = ++sequence;
    timer = setTimeout(() => enqueue(record, version), 450);
  }
  function saveNow() {
    clearTimeout(timer);
    if (state.materialPending || !state.pages.length || state.recording) return Promise.resolve(true);
    state.unsaved = true; saveLabel('正在保存…');
    return enqueue(snapshot(), ++sequence);
  }
  async function saveAndClose() {
    if(state.materialPending)return true;
    clearTimeout(timer);
    ++sequence;
    // Finish any older autosave before removing the active-record pointer.
    await chain.catch(() => {});
    try {
      await localRecords.saveAndClearActive(snapshot());
      state.unsaved = false;
      return true;
    } catch {
      state.unsaved = true;
      saveLabel('保存失败，尚未清空', true);
      message('当前记录未能保存，页面尚未清空。请先导出备份后重试。', true);
      return false;
    }
  }
  function forkIfReviewed(force = false) {
    if (!state.report && !force) return;
    // The completed analysis was saved before inputs were unlocked. Preserve it
    // under its existing ID; corrected speech becomes a separate local record.
    clearTimeout(timer);
    const retained = Object.fromEntries(['pdfAssetId','audioAssetId','audioParts','originalSegments','referenceScript','originalNotes','notesStatus','importedScript','asrTerms',
      'goalAgent','roundId','previousRoundId','comparisonChecks','recordingStatus','recordingMime',
      'job','jobStatus','jobTerms','jobError','jobApplied'].map(key => [key, state[key]]));
    const parentId = state.id;
    Object.assign(state, fresh(), retained, { parentId });
    state.report = null; $('review-dot').hidden = true;
  }
  function newRecord() { clearTimeout(timer); Object.assign(state, fresh()); saveLabel('尚未保存'); }
  function replaceReport(report) {
    const identity = value => JSON.stringify([value?.source, value?.promptVersion, value?.summary, value?.issues]);
    if (state.report && identity(state.report) !== identity(report)) forkIfReviewed();
    state.report = report;
    report.issues.forEach((issue,index)=>{if(issue.draft && !state.rewrites[index])state.rewrites[index]={answers:[],result:issue.draft};});
  }
  async function storeAsset(blob, key) {
    try { state[key] = await localRecords.saveAsset(blob); return await saveNow(); }
    catch { state.unsaved = true; saveLabel('附件未保存，请下载备份', true); message('本机空间不足或浏览器存储不可用。请先下载材料和录音；文字记录仍可导出。', true); return false; }
  }
  function checkpointRecording(blob, index, elapsed) {
    const record = snapshot();
    record.durationSeconds = elapsed;
    record.events = record.events.filter(event => event.at <= elapsed);
    state.unsaved = true;
    const version = ++sequence;
    chain = chain.then(async () => {
      await localRecords.checkpointRecording(record, blob, index);
      if (state.id === record.id && version === sequence) saveLabel(`录音暂存至 ${formatTime(elapsed)}`);
    });
    return chain;
  }
  async function finishRecording(blob) {
    await chain.catch(() => {});
    try {
      const before=snapshot();
      state.audioAssetId = await localRecords.finishRecording(before, blob);
      state.audioParts=appendRecordingPart(before,state.audioAssetId);
      state.unsaved = false; saveLabel('已保存在本机'); return true;
    } catch {
      state.recordingStatus = 'interrupted'; state.unsaved = true; saveLabel('录音未完整保存，请下载', true); return false;
    }
  }
  async function restore(record) {
    setBusy(true);
    message('');
    try {
      if (record.recordingStatus === 'recording' || record.recordingStatus === 'interrupted' && (!record.audioAssetId || record.recordingOffset > 0)) {
        const release = await acquireRecordingLock();
        if (!release) throw new Error('另一页面仍在录音。请先在那里结束演练，再打开这条记录。');
        try { record = await localRecords.recoverRecording(await localRecords.get(record.id)); }
        finally { release(); }
      }
      clearTimeout(timer); state.renderTask?.cancel();
      if (state.pdf) await state.pdf.destroy();
      resetSession(); state.pdf = null;
      Object.assign(state, fresh(), { id: record.id, createdAt: record.createdAt, pages: record.pages, segments: record.segments, events: record.events || [], duration: record.durationSeconds ?? null,
        current: record.current || 1, demo: Boolean(record.demo), goalAgent:record.goalAgent||null, coach:record.coach||null, report: record.report || null,
        pdfAssetId: record.pdfAssetId, audioAssetId: record.audioAssetId, audioParts: record.audioParts || (record.audioAssetId ? [{assetId:record.audioAssetId,offset:0,duration:record.durationSeconds||0,events:record.events||[]}]:[]), parentId: record.parentId,
        roundId: record.roundId || record.id, previousRoundId: record.previousRoundId || null, comparisonChecks: record.comparisonChecks || {},
        recordingStatus: record.recordingStatus || null, recordingMime: record.recordingMime || '',
        recordingOffset: record.recordingOffset || 0,
        job: record.job || null, jobStatus: record.jobStatus || null, jobTerms: record.jobTerms || null, jobError: record.jobError || '', jobApplied: Boolean(record.jobApplied),
        feedback: record.feedback || {}, rewrites: record.rewrites || {}, scripts: record.scripts || {}, importedScript: cleanImportedScript(record.importedScript,record.pages.length), originalNotes: cleanOriginalNotes(record.originalNotes, record.pages.length), notesStatus: record.notesStatus || null, referenceScript: record.referenceScript || [], originalSegments: record.originalSegments || [], asrTerms: Array.isArray(record.asrTerms) ? record.asrTerms : null });
      setAudience(record.goals.audience); $('takeaways').value = record.goals.takeaways; $('target-minutes').value = record.goals.targetMinutes;
      $('deck-name').textContent = record.title; $('demo-banner').hidden = !state.demo;
      $('review-dot').hidden = !state.report;
      const [pdf, audio] = await Promise.all([localRecords.getAsset(state.pdfAssetId), localRecords.getAsset(state.audioAssetId)]);
      if (pdf) { try { state.pdf = await openPdf(pdf); } catch { message('文字记录已恢复，PDF附件暂时无法打开。', true); } }
      if (audio) attachAudio(audio);
      $('timer').textContent = state.duration === null ? '00:00' : formatTime(state.duration);
      if (audio) { $('record-label').textContent = '已保存录音'; $('record-hint').textContent = '可回听，也可以开始新一轮演练。'; }
      renderSegments(); renderReference(); await renderPage(); view(state.report ? 'review' : 'practice');
      await saveNow();
      if(state.pdf && !state.report && state.pages.some(page=>!page.text?.trim()))readMaterial?.(state.pdf);
      if (state.recordingStatus === 'interrupted') {
        $('record-label').textContent = '录音曾中断';
        $('record-button').innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14m-7-7h14"/></svg><span>继续汇报</span>';
        $('record-hint').textContent = audio ? '中断前的录音已恢复。点击“继续汇报”可接着讲，当前发言与翻页记录会保留。' : '未找到上一段录音，请重新开始演练。';
        message($('record-hint').textContent, true);
      }
    } catch (error) { message(error.message || '这条记录暂时无法恢复，请尝试导入备份。', true); }
    finally { setBusy(false); }
  }
  async function showHistory() {
    await saveNow();
    try {
      const records = await localRecords.list();
      $('history-list').innerHTML = records.map(record => `<button class="history-row" data-record="${escape(record.id)}"><strong>${escape(record.title)}</strong><span>${record.demo ? '示例 · ' : ''}${record.recordingStatus === 'recording' ? '录音暂存' : record.recordingStatus === 'interrupted' ? '中断的演练' : record.parentId && record.roundId !== record.id ? '发言修订' : record.report ? '已有复盘' : '演练草稿'} · ${new Date(record.updatedAt).toLocaleString('zh-CN')}</span><small>${record.segments.some(s=>s.page===0)?'含待确认页码的发言':new Set(record.segments.map(s => s.page)).size+' 页发言'} · ${Object.keys(record.scripts || {}).length} 段已采用改稿</small></button>`).join('') || '<p class="muted">导入材料后会自动保存第一条记录。</p>';
      $('history-list').querySelectorAll('[data-record]').forEach(button => button.addEventListener('click', async () => {
        const record = await localRecords.get(button.dataset.record); $('history-dialog').close(); if (record) await restore(record);
      }));
      $('history-dialog').showModal();
    } catch { message('无法读取本机记录，请检查浏览器是否允许本地存储。', true); }
  }
  const feedbackFor = index => state.feedback[index] || {};
  const blocked = index => feedbackFor(index).judgment === 'incorrect' || feedbackFor(index).adoption === 'no';
  const draftLengthNote = result => {
    const session = getSession();
    if (!result || !(session.durationSeconds > session.targetSeconds)) return '';
    const count = text => Array.from(String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')).length;
    const original = count(result.originalText), revised = count(result.revisedText);
    if (!original || revised <= original * 1.05) return '';
    return `这份修改稿的文字量比原发言多 ${Math.round((revised / original - 1) * 100)}%。本次已超时，建议按上方压缩计划再精简，并通过重练核对时长。`;
  };
  function issueTools(issue, index) {
    const feedback = feedbackFor(index), flow = state.rewrites[index] || {}, result = flow.result;
    const options = (list, value) => list.map(([id, label]) => `<option value="${id}" ${value === id ? 'selected' : ''}>${label}</option>`).join('');
    let body = '';
    if (result?.status === 'needs_input') body = `<div class="rewrite-question"><strong>先确认一件事</strong><p>${escape(contextualAdvice(result.question, getSession()))}</p><textarea data-answer="${index}" rows="3" maxlength="2000" aria-label="回答第${index + 1}条确认问题" placeholder="填写真实情况；不认可建议也可以直接说明。">${escape(flow.answerDraft || '')}</textarea><button class="button primary workflow-button" data-rewrite="${index}">根据回答改稿 ${icon('arrow')}</button></div>`;
    if (result?.status === 'draft') body = `<h4>${flow.acceptedAt ? '已采用的说法' : '建议说法 · 可编辑'}</h4><textarea rows="${Math.max(2,Math.min(6,Math.ceil(result.revisedText.length/55)))}" data-draft="${index}" aria-label="第${index + 1}条修改稿" ${flow.acceptedAt ? 'readonly' : ''}>${escape(result.revisedText)}</textarea><p class="draft-length-note" data-length-note="${index}" ${draftLengthNote(result) ? '' : 'hidden'}>${escape(draftLengthNote(result))}</p><div class="draft-buttons">${flow.acceptedAt ? `<span class="accepted-label" role="status">${icon('check')} 已更新${issue.page>0?`第 ${issue.page} 页`: '下次'}讲稿</span><button class="text-button workflow-button" data-show-scripts="${issue.page}">查看这一页讲稿</button>` : `<button class="button primary workflow-button" data-accept="${index}">采用这版</button><button class="button secondary workflow-button" data-dismiss="${index}">保留原文</button>`}</div>`;
    if (result?.status === 'no_change') body = `<p class="rewrite-reason">${escape(result.reason)}</p>`;
    return `<div class="issue-tools"><details class="feedback-form"><summary>记录我的判断</summary><div class="feedback-selects"><label>判断对不对<select data-feedback="judgment" data-index="${index}" aria-label="第${index + 1}条建议判断">${options([['','请选择'],['correct','判断正确'],['partial','部分正确'],['incorrect','判断不对'],['unsure','暂不确定']], feedback.judgment)}</select></label><label>愿不愿意采用<select data-feedback="adoption" data-index="${index}" aria-label="第${index + 1}条建议采纳意愿">${options([['','请选择'],['yes','愿意采用'],['no','不采用'],['later','还要考虑']], feedback.adoption)}</select></label></div><textarea data-feedback="reason" data-index="${index}" rows="2" maxlength="2000" aria-label="第${index + 1}条反馈原因" placeholder="为什么？例如：只是换一种说法，不影响理解。">${escape(feedback.reason || '')}</textarea></details><div class="rewrite-panel" data-flow="${index}">${!result ? `<details class="rewrite-preferences"><summary>修改偏好（选填）</summary><label class="rewrite-preference"><input data-instruction="${index}" maxlength="1000" value="${escape(flow.instruction || '')}" placeholder="例如：更口语，压缩到两句话"></label></details><button class="button primary workflow-button" data-rewrite="${index}">生成建议说法 ${icon('arrow')}</button>` : body}<p class="rewrite-status" data-flow-status="${index}">${blocked(index) ? '你已标记不认可或不采用，暂不据此改稿。' : ''}</p></div></div>`;
  }
  function bindIssues() {
    $('issues').querySelectorAll('[data-feedback]').forEach(el => el.addEventListener('input', () => {
      const i = Number(el.dataset.index);
      state.feedback[i] = { ...feedbackFor(i), [el.dataset.feedback]: el.value, updatedAt: new Date().toISOString() };
      const note = $('issues').querySelector(`[data-flow-status="${i}"]`);
      if (note) note.textContent = blocked(i) ? '你已标记不认可或不采用，暂不据此改稿。' : '反馈已记录；确认采用前不会改变你的讲稿。';
      saveSoon();
    }));
    $('issues').querySelectorAll('[data-instruction],[data-answer],[data-draft]').forEach(el => el.addEventListener('input', () => {
      const i = Number(el.dataset.instruction ?? el.dataset.answer ?? el.dataset.draft);
      const flow = state.rewrites[i] ||= { answers: [] };
      if (el.hasAttribute('data-instruction')) flow.instruction = el.value;
      else if (el.hasAttribute('data-answer')) flow.answerDraft = el.value;
      else if (!flow.acceptedAt) {
        flow.result.revisedText = el.value; flow.manuallyEdited = true;
        const note = $('issues').querySelector(`[data-length-note="${i}"]`);
        if (note) { note.textContent = draftLengthNote(flow.result); note.hidden = !note.textContent; }
      }
      saveSoon();
    }));
    $('issues').querySelectorAll('[data-rewrite]').forEach(el => el.addEventListener('click', () => requestRewrite(Number(el.dataset.rewrite))));
    $('issues').querySelectorAll('[data-accept]').forEach(el => el.addEventListener('click', async () => {
      const i = Number(el.dataset.accept), flow = state.rewrites[i], issue = state.report.issues[i];
      if (state.busy || flow.acceptedAt) return;
      if (blocked(i)) return message('你已否定这条建议。如需采用，请先更新你的判断。', true);
      try {
        const previousScripts=state.scripts, previousFeedback=state.feedback[i];
        setBusy(true);
        state.scripts = acceptDraft(state.scripts, flow.result, state.segments.find(s => s.id === issue.segmentId).text, issue.title);
        flow.acceptedAt = new Date().toISOString(); state.feedback[i] = { ...feedbackFor(i), adoption: 'yes', adoptedAt: flow.acceptedAt };
        if (!await saveNow()) { state.scripts=previousScripts; state.feedback[i]=previousFeedback; delete flow.acceptedAt; throw new Error('讲稿未保存成功，请重试采用或先导出备份。'); }
        renderReport(); message('');
      } catch (error) { message(error.message, true); }
      finally { setBusy(false); }
    }));
    $('issues').querySelectorAll('[data-dismiss]').forEach(el => el.addEventListener('click', () => {
      const flow = state.rewrites[Number(el.dataset.dismiss)]; flow.result = { status: 'no_change', reason: '已保留原发言，没有采用这份修改稿。' }; renderReport(); saveSoon();
    }));
    $('issues').querySelectorAll('[data-show-scripts]').forEach(el => el.addEventListener('click', () => { view('scripts'); const card=$(`script-page-${el.dataset.showScripts}`); card?.scrollIntoView({behavior:'smooth',block:'start'}); card?.focus({preventScroll:true}); }));
  }
  async function requestRewrite(index) {
    if (state.busy || blocked(index)) return message('你已标记不认可或不采用，不会依据这条建议改稿。', true);
    const issue = state.report.issues[index], flow = state.rewrites[index] ||= { answers: [] };
    let answers = flow.answers || [];
    if (flow.result?.status === 'needs_input') {
      if (!flow.answerDraft?.trim()) return message('请先回答确认问题。', true);
      answers = [...answers, { question: flow.result.question, answer: flow.answerDraft.trim() }];
    }
    setBusy(true); message('正在处理这段发言…');
    try {
      let result;
      if (state.demo) {
        if (issue.action === 'clarify' && !answers.length) result = { status: 'needs_input', question: issue.question };
        else result = { status: 'draft', segmentId: issue.segmentId, originalText: state.segments.find(s => s.id === issue.segmentId).text,
          revisedText: index === 0 ? '我们希望让同学更方便地使用自习室。目前重点关注提醒和取消流程，不过访谈尚未完成，这两个问题仍需验证。' : '下一步先确认同学在预约和取消过程中遇到的问题，再用任务体验和使用反馈检验方案，而不只依据“觉得不错”决定是否继续。', reason: '这是人工预设的改稿示例，仅演示操作流程。', source: 'demo' };
      } else {
        await health(); result = await api('/api/revise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: getSession(), issue, answers, instruction: flow.instruction || '', ...feedbackFor(index) }) });
      }
      if(result.question)result.question=contextualAdvice(result.question,getSession());
      flow.answers = answers; flow.answerDraft = ''; flow.result = result; flow.updatedAt = new Date().toISOString();
      renderReport(); await saveNow(); message('');
    } catch (error) { message(error.message, true); }
    finally { setBusy(false); }
  }
  function compiledScript() { return compileScriptPages(state.segments, state.pages, state.scripts); }
  function renderScripts() {
    const count = Object.keys(state.scripts).length;
    const pages = compiledScript();
    document.querySelector('.script-help').hidden=!pages.length;
    $('scripts-summary').textContent = pages.some(p=>p.page===0) ? '已整理全部发言；部分页码待确认，不影响查看与导出。' : pages.length ? (count ? `${pages.length} 页讲稿 · 已采用 ${count} 段修改` : `已按 ${pages.length} 页整理本次发言；采用的修改会更新到这里。`) : '先完成一次转写或录入发言，这里就会按页整理成讲稿。';
    $('script-list').innerHTML = pages.length ? pages.map(page => `<article class="script-card" id="script-page-${page.page}" tabindex="-1"><header class="script-page-label"><h3>${pageLabel(page.page)}</h3><span>${page.changed ? '已采用修改' : '本次发言'}</span></header><div class="script-content">${page.page>0?`<div class="script-material">${slidePreview(page.page)}</div>`:''}<div class="script-body">${paragraphs(page.text)}${page.changed ? `<details><summary>查看本页原发言</summary>${paragraphs(state.segments.filter(s => s.page === page.page).map(s => s.text).join('\n'))}</details>` : ''}</div></div></article>`).join('') : '<div class="empty-transcript">还没有发言可整理。回到演练空间，录音转写或输入发言即可。</div>';
    renderSlidePreviews($('script-list'));
    $('export-script').disabled = !pages.length; $('next-rehearsal').disabled = !pages.length || state.demo;
  }
  function renderReference() {
    $('reference-script').hidden = !state.referenceScript.length;
    $('reference-content').innerHTML = state.referenceScript.map(s => `<h4>${pageLabel(s.page)}</h4>${paragraphs(s.text)}`).join('');
  }
  async function nextRehearsal() {
    if (state.busy || state.demo || !state.segments.some(s => s.text.trim())) return;
    if (!await saveNow()) return message('上一轮尚未保存成功，请先导出备份。', true);
    const goalAgent=state.goalAgent;
    const parentId = state.id, previousRoundId = nextRoundBaseline(snapshot()), pdfAssetId = state.pdfAssetId, referenceScript = compiledScript(), originalNotes = state.originalNotes, notesStatus = state.notesStatus, importedScript = state.importedScript, asrTerms = state.asrTerms;
    resetSession(); Object.assign(state, fresh(), { goalAgent, parentId, previousRoundId, pdfAssetId, referenceScript, originalNotes, notesStatus, importedScript, asrTerms });
    state.current = 1; renderReference(); renderSegments(); view('practice'); await renderPage(); await saveNow();
    message('已开始新一轮：PPT和这份讲稿已保留。点击「开始演练」重新录音，上一轮记录在历史记录中。');
  }

  async function renderComparison() {
    const version = ++comparisonVersion, current = snapshot();
    const containers = [$('practice-comparison'), $('review-comparison')];
    if (!current.previousRoundId || !current.segments.some(s => s.text.trim()) && !current.durationSeconds) {
      containers.forEach(el => { el.hidden = true; el.innerHTML = ''; }); return;
    }
    try {
      const previous = await localRecords.get(current.previousRoundId);
      if (version !== comparisonVersion || state.id !== current.id) return;
      const comparison = compareRounds(previous, current);
      const pair = (label, before, after) => `<div><span>${label}</span><strong>${before} → ${after}</strong></div>`;
      let body;
      if (!comparison.available) body = `<p>${escape(comparison.reason)}</p>`;
      else {
        // Use the same whole-second precision as the two displayed totals.
        const delta = Math.round(current.durationSeconds) - Math.round(previous.durationSeconds);
        const deltaLabel = delta === 0 ? '不变' : `${delta > 0 ? '增加' : '减少'} ${formatTime(Math.abs(delta))}`;
        const rate = value => value === null ? '暂无' : `${value} 字词/分钟`;
        body = `<p>上一轮：${escape(new Date(previous.createdAt).toLocaleString('zh-CN'))}。时间变短或原句消失，不代表表达一定更好。</p>
          ${comparison.goalsChanged ? '<p class="comparison-note">两轮的听众、重点或目标时长有变化，请结合不同任务理解差异。</p>' : ''}
          <div class="round-metrics">${comparison.timingAvailable ? pair('总用时', formatTime(previous.durationSeconds), formatTime(current.durationSeconds)) + `<div><span>用时变化</span><strong>${deltaLabel}</strong></div>` : '<p>包含中断、手动或旧版记录，缺少完整计时依据，暂不比较时长。</p>'}
          ${pair('估算语速',rate(comparison.previousMetrics.estimatedRate),rate(comparison.currentMetrics.estimatedRate))}</div>
          <p class="muted">语速按原始识别文本估算：汉字逐字、英文逐词，包含停顿；识别错字会影响结果。</p>
          ${comparison.pages.map(page => `<details class="round-page"><summary>${pageLabel(page.page)}${comparison.timingAvailable ? ` · ${formatTime(page.beforeSeconds)} → ${formatTime(page.afterSeconds)}` : ''}</summary><div class="round-text-pair"><div><h4>上一轮发言</h4>${paragraphs(page.previousText || '本页没有发言记录。')}</div><div><h4>本轮发言</h4>${paragraphs(page.currentText || '本页尚无转写或录入发言。')}</div></div></details>`).join('')}
          ${comparison.issues.length ? `<h3 class="comparison-subtitle">上次的问题，这次怎么样？</h3><p class="muted">结合两轮发言自行核对，系统不自动下改善结论。</p>${comparison.issues.map(issue => `<article class="round-issue"><h4>${escape(issue.title)} <span>${pageLabel(issue.page)} · ${issue.confirmed ? '上次已认可 / 采用' : '上次尚未确认'}</span></h4><blockquote>${escape(issue.quote)}</blockquote><p>${issue.currentText ? issue.quoteRepeated ? '本轮仍出现这段原话，可回看上下文后判断。' : '本轮未找到完全相同的原话，请核对是否只是换了一种说法。' : '本页还没有本轮发言，暂时无法核对。'}</p><label>我的判断 <select data-round-check="${escape(issue.key)}" aria-label="${escape(issue.title)}的本轮变化"><option value="">请选择</option>${[['improved','已改善'],['practice','仍需练习'],['unsure','暂不确定']].map(([key,label]) => `<option value="${key}" ${current.comparisonChecks[issue.key] === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></article>`).join('')}` : ''}`;
      }
      containers.forEach(el => {
        const wasOpen = el.querySelector('details')?.open;
        el.hidden = false; el.innerHTML = `<details class="round-comparison" ${wasOpen ? 'open' : ''}><summary>与上一轮对照</summary><div class="round-comparison-body">${body}</div></details>`;
        el.querySelectorAll('[data-round-check]').forEach(select => {
          select.disabled = state.busy || state.recording;
          select.addEventListener('change', () => {
            state.comparisonChecks[select.dataset.roundCheck] = select.value; saveSoon();
            containers.forEach(c => c.querySelectorAll('[data-round-check]').forEach(other => { if (other.dataset.roundCheck === select.dataset.roundCheck) other.value = select.value; }));
          });
        });
      });
    } catch { containers.forEach(el => { el.hidden = false; el.textContent = '暂时无法读取上一轮，请检查本机存储后重试。'; }); }
  }

  function download(data, name, type) {
    const url = URL.createObjectURL(new Blob([data], { type })), a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportRecord() {
    if (!state.pages.length) return message('请先导入材料。', true);
    download(JSON.stringify({ version: '0.3.0', source: state.demo ? 'demo' : 'live', createdAt: new Date().toISOString(), session: getSession(), report: state.report, record: snapshot() }, null, 2), `演练恢复文件${state.demo ? '-示例' : ''}-${state.id.slice(0,8)}.json`, 'application/json');
  }
  function exportReadableReport() {
    try { download('\ufeff' + readableReport(snapshot()), `演练复盘-${state.id.slice(0,8)}.txt`, 'text/plain;charset=utf-8'); }
    catch (error) { message(error.message, true); }
  }
  async function importRecord(file) {
    if (!file || state.busy || state.recording) return;
    try {
      if (file.size > 3 * 1024 * 1024) throw new Error('备份超过3MB，请使用本工具导出的JSON。');
      const data = JSON.parse(await file.text());
      if (!data.session || !Array.isArray(data.session.segments)) throw new Error('备份缺少演练数据。');
      const emptyDraft = !data.session.segments.length && !data.report;
      const session = validateSession({ ...data.session, segments: emptyDraft ? [{id:'s1',page:1,text:'空白草稿的格式校验'}] : data.session.segments });
      if (emptyDraft) session.segments = [];
      const report = data.report ? { ...validateReport(data.report, session), source: data.source === 'demo' ? 'demo' : 'imported', model: data.report.model || '导入记录', promptVersion: data.report.promptVersion } : null;
      if(report && data.report.inputCoverage)Object.assign(report,completeCoachingReport(report,session));
      await saveNow();
      const record = { ...fresh(), schemaVersion: 3, updatedAt: new Date().toISOString(), title: String(data.record?.title || file.name).slice(0,200),
        importedScript: cleanImportedScript(data.record?.importedScript,session.pages.length), originalNotes: cleanOriginalNotes(data.record?.originalNotes, session.pages.length), notesStatus: data.record?.notesStatus || null, pages: session.pages, segments: session.segments, events: session.events, durationSeconds: session.durationSeconds, current: 1, demo: data.source === 'demo', report,
        goals: { audience: session.audience, takeaways: session.takeaways, targetMinutes: String(session.targetSeconds / 60) } };
      // Imports are text-only. Never follow asset IDs supplied by a file.
      for (const [key, value] of Object.entries(data.record?.scripts || {})) if (/^s\d+$/.test(key) && session.segments.some(s => s.id === key) && typeof value?.text === 'string' && value.text.length <= 12000) record.scripts[key] = { text: value.text, sourceText: session.segments.find(s => s.id === key).text, versions: [{text:value.text,reason:'从备份恢复的讲稿',acceptedAt:new Date().toISOString()}] };
      for (const [key, value] of Object.entries(data.record?.feedback || {})) if (/^\d+$/.test(key) && Number(key) < (report?.issues.length || 0)) record.feedback[key] = { judgment: ['correct','partial','incorrect','unsure'].includes(value?.judgment) ? value.judgment : '', adoption: ['yes','no','later'].includes(value?.adoption) ? value.adoption : '', reason: String(value?.reason || '').slice(0,2000) };
      for (const [key, flow] of Object.entries(data.record?.rewrites || {})) {
        if (!/^\d+$/.test(key) || Number(key) >= (report?.issues.length || 0) || !flow || typeof flow !== 'object') continue;
        const source = session.segments.find(s => s.id === report.issues[Number(key)].segmentId);
        const answers = Array.isArray(flow.answers) ? flow.answers.filter(a => typeof a?.question === 'string' && typeof a.answer === 'string').slice(0,2).map(a => ({question:a.question.slice(0,500),answer:a.answer.slice(0,2000)})) : [];
        const clean = { answers, instruction: String(flow.instruction || '').slice(0,1000), answerDraft: String(flow.answerDraft || '').slice(0,2000) };
        const r = flow.result;
        if (r?.status === 'draft' && r.originalText === source.text && typeof r.revisedText === 'string' && r.revisedText.trim() && r.revisedText.length <= 12000) {
          clean.result = {status:'draft',originalText:source.text,revisedText:r.revisedText,segmentId:source.id,reason:String(r.reason || '从备份恢复的修改稿').slice(0,500)};
          if (flow.acceptedAt && record.scripts[source.id]?.text === r.revisedText) clean.acceptedAt = String(flow.acceptedAt).slice(0,50);
        } else if (r?.status === 'needs_input' && typeof r.question === 'string') clean.result = {status:r.status,question:r.question.slice(0,500),reason:String(r.reason || '').slice(0,500)};
        else if (r?.status === 'no_change') clean.result = {status:r.status,reason:String(r.reason || '').slice(0,500)};
        record.rewrites[key] = clean;
      }
      if (Array.isArray(data.record?.referenceScript)) record.referenceScript = data.record.referenceScript.filter(s => Number.isInteger(s?.page) && s.page >= 0 && s.page <= session.pages.length && typeof s.text === 'string').slice(0,1200).map((s,i)=>({id:`s${i+1}`,page:s.page,text:s.text.slice(0,12000)}));
      await localRecords.save(record); $('history-dialog').close(); await restore(record); message('备份已导入。已恢复文字与报告；原始PPT、PDF页面和录音不包含在JSON备份中。');
    } catch (error) { message(`导入失败：${error.message}`, true); }
    finally { $('backup-input').value = ''; }
  }
  async function boot({restore:shouldRestore=true} = {}) {
    $('history-button').addEventListener('click', showHistory);
    $('close-history').addEventListener('click', () => $('history-dialog').close());
    $('backup-button').addEventListener('click', exportRecord);
    $('import-backup').addEventListener('click', () => $('backup-input').click());
    $('backup-input').addEventListener('change', e => importRecord(e.target.files[0]));
    $('export-script').addEventListener('click', () => download(compiledScript().map(s => `${pageLabel(s.page)}\n${s.text}`).join('\n\n'), '下次汇报讲稿.txt', 'text/plain;charset=utf-8'));
    $('next-rehearsal').addEventListener('click', nextRehearsal);
    setBusy(true); await health();
    try { const id = shouldRestore ? await localRecords.lastId() : null; if (id) { const record = await localRecords.get(id); if (record) await restore(record); } }
    catch { saveLabel('本机自动保存不可用', true); }
    finally { setBusy(false); }
  }
  return { nextRehearsal, snapshot, checkpointRecording, finishRecording, renderComparison, saveSoon, saveNow, saveAndClose, forkIfReviewed, newRecord, replaceReport, storeAsset, renderReference, issueTools, bindIssues, renderScripts, exportRecord, exportReadableReport, boot };
}
