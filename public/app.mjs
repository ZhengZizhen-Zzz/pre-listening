import {autoGrowTextarea} from './auto-grow.mjs';
import {createGoalAgent} from './goal-agent.mjs';
import {createScriptImport} from './script-import.mjs';
import {readPptxNotes,cleanOriginalNotes} from './pptx-notes.mjs';
import {watchRecording} from './recording-guard.mjs';
import {readApiResponse} from './api-response.mjs';
import {transcriptionRecoveryText,rejectedTranscriptionSubmission} from './transcription-recovery.mjs';
import {createPresenter} from './presenter.mjs';
import {createCoach} from './coach.mjs';
import {automaticCoach} from './automatic-coach.mjs';
import { PDF_PREVIEW_BASE, createPreviewRenderer, previewFailure } from './preview-renderer.mjs';
import { alignSegments, pageLabel, hasPageTimeline, formatTime, pageDurations, conciseIssueTitle, validateSession, materialCoverage } from './core.mjs';
import { demo } from './demo.mjs';
import { renderDemoSlide } from './demo-slides.mjs';
import { icon } from './icons.mjs';
import { createWorkspace } from './workspace.mjs';
import { groupTranscript, assignTranscriptPage, editPageTranscript, compileScriptPages, transcriptSource as getTranscriptSource } from './transcript-core.mjs';
import { extractSpeechTerms, cleanSpeechTerms } from './speech-terms.mjs';
import { getRecordingStream } from './audio-capture.mjs';
import { acquireRecordingLock } from './recording-lock.mjs';
import { nextRoundBaseline, speechMetrics } from './comparison-core.mjs';
import { validateMaterialSize, validateMaterialPages } from './material-limits.mjs';
import { timeBudget, contextualReport } from './coaching-core.mjs';
import { createSlidePreviews } from './slide-previews.mjs';
import { readMissingText, readNativeText } from './material-text.mjs';
import { pageNumbers, createPreviewSizer } from './preview-controls.mjs';
import { createPreviewCache } from './preview-cache.mjs';
import { localRecords } from './storage.mjs';
import { createTraining } from './training.mjs';
import { createFeedback } from './feedback.mjs';
import { importPresentation, describeMaterialError } from './material-import.mjs';
import {localPptxPreview} from './pptx-local-preview.mjs';
import { firstPptxPages, compactPptxPreview } from './pptx-first-pages.mjs';
import { readPptxPageCount } from './pptx-preflight.mjs';
const previewCache = createPreviewCache(localRecords);
const manualTranscriptPages = new Set();

let pdfLibrary, sharedPdfWorker;
let materialReading = null;
let replayPartUrl=null;let replayPartVersion=0;
let materialController=null, pendingMaterialFile=null;
async function loadPdfLibrary() {
  if (!pdfLibrary) pdfLibrary = import(`${PDF_PREVIEW_BASE}/pdf.min.mjs`).then(async pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDF_PREVIEW_BASE}/pdf.worker.min.mjs`;
    sharedPdfWorker = new pdfjs.PDFWorker({name: 'rehearsal-preview'});
    await sharedPdfWorker.promise;
    return pdfjs;
  }).catch(error => { sharedPdfWorker?.destroy(); sharedPdfWorker = null; pdfLibrary = null; throw error; });
  return pdfLibrary;
}
const $ = id => document.getElementById(id);
const fitTakeaways = autoGrowTextarea($('takeaways'));
const audienceValue = () => $('audience').value === '__custom__' ? $('audience-custom').value.trim() : $('audience').value;
const setAudience = value => {
  const known = [...$('audience').options].some(option => option.value === value);
  $('audience').value = known ? value : '__custom__';
  $('audience-custom').value = known ? '' : (value || '');
  $('audience-custom').hidden = known;
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const paragraphs = value => String(value || '').split(/\n+|(?<=[。！？])\s*(?=.)/).map(text => text.trim()).filter(Boolean).map(text => `<p>${escape(text)}</p>`).join('');
const state = { pages: [], pdf: null, current: 1, segments: [], events: [], duration: null, blob: null, audioUrl: null, report: null, demo: false, recording: false, busy: false, health: null, renderTask: null, renderVersion: 0, timer: null, recorder: null, stream: null, started: null, job: null };
const openPdf = async blob => {
  const [pdfjs, bytes] = await Promise.all([loadPdfLibrary(), blob.arrayBuffer()]);
  return pdfjs.getDocument({ data: new Uint8Array(bytes), worker: sharedPdfWorker, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', isEvalSupported: false }).promise;
};
const workspace = createWorkspace({ state, $, escape, paragraphs, message, setBusy, health, api, getSession, renderPage, renderSegments, renderReport, view, resetSession, openPdf, attachAudio, readMaterial:startMaterialReading, slidePreview:page=>slidePreview(page), renderSlidePreviews:root=>slidePreviews.render(root) });
const slidePreviews = createSlidePreviews({getPdf:()=>state.pdf,getText:page=>state.pages[page-1]?.text,getCurrent:()=>state.current,onNavigate:goPage,isRecording:()=>state.recording});
const slidePreview = page => state.demo && demo.pages[page-1] ? `<div class="demo-evidence"><div class="demo-material-label">第 ${page} 页材料</div><div class="demo-mini-slide">${renderDemoSlide(demo.pages[page-1])}</div></div>` : `<button type="button" class="issue-slide-preview" data-preview-page="${page}" aria-label="放大第${page}页PPT" disabled><img alt="第 ${page} 页 PPT" hidden><span class="preview-note">正在读取第 ${page} 页预览…</span></button>`;
const training = createTraining({state,$,escape,getSession,setBusy,health,api,message,confirmAction,slidePreview,slidePreviews});
const presenter=createPresenter({state,onNavigate:goPage,onRecord:startRecording,onTranscribe:transcribe,
  onOpen:()=>{state.renderTask?.cancel();++state.renderVersion;},onClose:()=>{void renderPage();workspace.saveSoon();},
  getTarget:()=>Number($('target-minutes').value)*60||300,getTitle:()=>$('deck-name').textContent,
  getMessage:()=>({text:$('status').textContent,error:$('status').classList.contains('error')}),renderDemo:renderDemoSlide});
const scriptImport=createScriptImport({state,workspace,openPdf,escape,onChanged:()=>{presenter.sync();updateControls();}});
createFeedback({state,$,workspace,api,health,setBusy,message,escape,renderReport});
const coach=createCoach({state,$,escape,getSession,workspace,api,health,setBusy,message,training,view,waitForMaterial:async()=>{if(materialReading)await materialReading.promise;}});

const goalAgent=createGoalAgent({state,$,escape,getSession,workspace,api,health,message,view,slidePreview,slidePreviews});

function message(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); $('status').hidden = !text; presenter.sync(); }
function confirmAction(text) {
  const dialog = $('action-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('action-question').textContent = text; dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'continue'), {once:true});
    dialog.showModal();
  });
}
function dirty() { workspace.forkIfReviewed(); workspace.saveSoon(); }
function setBusy(value) { state.busy = value; updateControls(); }
function transcriptionRecoveryMessage() {
  return transcriptionRecoveryText(state);
}
function updateControls() {
  scriptImport.sync();
  presenter.sync();
  coach.render();
  goalAgent.render();
  $('goal-focus-state').textContent=$('takeaways').value.trim()?'已填写':'选填';
  fitTakeaways();
  const locked = state.busy || state.recording;
  const navigationLocked=state.busy&&!state.materialPending;
  $('cancel-material').hidden=!materialController;
  $('retry-material').hidden=!state.materialPending||!!materialController;
  document.body.classList.toggle('has-material',Boolean(state.pages.length));
  $('import-material').hidden=!state.pages.length;
  $('clear-workspace').hidden=!state.pages.length;
  const needsTranscriptionRecovery = !state.demo && Boolean(state.jobError || state.health?.asrError || ['failed','uncertain','expired','missing'].includes(state.jobStatus));
  $('manual-entry').hidden=state.demo||Boolean(state.segments.length)||(needsTranscriptionRecovery&&Boolean(state.blob));
  $('manual-entry').textContent=needsTranscriptionRecovery?'手动填写发言':'手动填写本次发言';
  $('goal-section').hidden = !state.pages.length;
  $('transcript-section').hidden = !state.pages.length || (!state.segments.length && !manualTranscriptPages.size);
  $('manual-entry').disabled = !state.pages.length || locked || state.demo || !!state.materialPending;
  $('pdf-input').disabled = locked;
  $('import-material').disabled = locked;
  $('clear-workspace').disabled = locked || !state.pages.length;
  $('upload-prompt').disabled = locked;
  $('demo-button').disabled = locked;
  $('exit-demo').disabled = locked;
  $('submit-feedback-nav').disabled = locked || state.demo;
  $('prev-page').disabled = !state.pages.length || state.current === 1 || navigationLocked;
  $('next-page').disabled = !state.pages.length || state.current === state.pages.length || navigationLocked;
  $('record-button').disabled = !state.pages.length || state.busy || state.demo || !!state.materialPending;
  $('add-segment').disabled = !state.pages.length || locked || state.demo;
  $('analyze-button').disabled = !state.pages.length || !state.segments.some(s => s.text.trim()) || locked || (!state.demo && !state.health?.textConfigured);
  $('analyze-button').innerHTML = state.analysis?.status === 'pending' ? '正在分析…' : `${state.demo ? '查看示例复盘' : state.recordingStatus === 'interrupted' ? '分析已录到内容' : '查看演练反馈'} ${icon('arrow')}`;
  $('retry-analysis').disabled = locked;
  document.querySelectorAll('[data-time-plan]').forEach(button=>button.disabled=locked);
  document.querySelectorAll('[data-train-issue],[data-start-questions],[data-run]').forEach(button=>button.disabled=locked);
  $('repair-report-material').disabled=locked;
  $('review-script').disabled=locked||!state.segments.some(s=>s.text.trim());
  $('jump-page').disabled = navigationLocked;
  $('thumbs').querySelectorAll('button').forEach(button => button.disabled = navigationLocked);
  $('transcribe-button').disabled = !state.blob || locked || !state.health?.asrConfigured || state.health?.asrReady === false;
  $('transcribe-button').hidden = ['failed','expired','missing'].includes(state.jobStatus);
  const audioPicker=$('audio-part-picker'),parts=state.audioParts||[];
  audioPicker.hidden=parts.length<2;audioPicker.disabled=locked;
  const audioOptions=parts.map((part,i)=>`<option value="${i}">第 ${i+1} 段 · ${formatTime(part.duration)}</option>`).join('');
  if(audioPicker.dataset.options!==audioOptions){audioPicker.innerHTML=audioOptions;audioPicker.dataset.options=audioOptions;audioPicker.value=String(parts.length-1);}
  const pendingAudioParts = (state.audioParts || []).filter(part => !part.transcribed).length;
  $('transcribe-button').textContent = state.health?.asrError ? '转写暂不可用，请检查任务记录' : state.health?.asrConfigured ? (state.audioParts?.length > 1 && pendingAudioParts ? `转写全部录音片段（${pendingAudioParts}）` : state.jobError || state.jobStatus && state.jobStatus !== 'complete' ? '继续转写' : state.segments.length ? '重新获取识别原文' : '转写录音') : '转写暂不可用';
  $('retry-transcription').hidden = !['failed','uncertain','expired'].includes(state.jobStatus) || !state.job;
  $('retry-transcription').disabled = locked || !state.blob || !state.health?.asrConfigured || state.health?.asrReady === false;
  $('pause-transcription').hidden = !state.asrController;
  const showTranscriptionStatus = needsTranscriptionRecovery || ['submitting','pending'].includes(state.jobStatus);
  $('transcription-recovery').hidden = !showTranscriptionStatus;
  $('transcription-status').hidden = !showTranscriptionStatus;
  $('transcription-status').textContent = needsTranscriptionRecovery ? transcriptionRecoveryMessage() : '正在转写，录音已保留。';
  $('manual-after-transcription').hidden = !needsTranscriptionRecovery;
  $('manual-after-transcription').disabled = locked || !state.pages.length || !!state.materialPending;
  $('manual-after-transcription').textContent = state.segments.some(s=>s.text.trim()) ? '继续编辑发言' : '手动填写发言';
  // Pending/uncertain submissions retain immutable terms so recovery cannot create a duplicate job.
  $('asr-terms').disabled = locked || ['submitting','pending','uncertain','missing'].includes(state.jobStatus);
  $('refresh-report').disabled = locked;
  $('analysis-hint').textContent = state.demo ? '示例发言，可查看演练反馈。' : state.recordingStatus === 'interrupted' ? '可修改已录到的发言，分析只依据这部分内容。' : !state.health?.textConfigured ? '分析服务暂不可用，可以先编辑发言。' : '识别错字可直接改，分析会使用这里的内容。';
  ['audience','audience-custom','takeaways','target-minutes'].forEach(id => $(id).disabled = locked || state.demo);
  document.querySelectorAll('.segment textarea,.segment select,.segment .delete,[data-goal]').forEach(el => el.disabled = locked || state.demo);
  document.querySelectorAll('[data-round-check],.workflow-button,.feedback-form select,.feedback-form textarea,.rewrite-panel input,.rewrite-panel textarea').forEach(el => el.disabled = locked);
  ['history-button','import-backup','backup-button','next-rehearsal','export-script'].forEach(id => $(id).disabled = locked || (id === 'next-rehearsal' && (state.demo || !state.segments.some(s => s.text.trim()))) || (id === 'export-script' && !state.segments.some(s => s.text.trim())));
}

async function api(route, options = {}) {
  let response;
  try { response = await fetch(route, { ...options, headers: { ...options.headers, 'X-Local-Token': state.health?.csrf || '' } }); }
  catch(e){if(['TimeoutError','AbortError'].includes(e.name))throw e;throw Object.assign(new Error('连接暂时中断，内容已保留，请稍后重试。'),{retryable:true});}
  return readApiResponse(response);
}

async function health() {
  try {
    const response = await fetch('/api/health', {signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('本地服务不可用');
    state.health = await response.json();
    $('feedback-inbox-link').hidden = state.health.trialMode;
    $('connection').classList.toggle('connected', state.health.textConfigured);
    const textStatus = state.health.textConfigured ? `${state.health.provider === 'deepseek' ? 'DeepSeek' : '百炼'} 已配置` : '文字未配置';
    const serviceDetails = `${textStatus} · ${state.health.asrConfigured ? '语音已配置' : '语音未配置'}`;
    $('connection').querySelector('span').textContent = state.health.textConfigured && state.health.asrConfigured ? '服务正常' : '服务待连接';
    $('connection').title = serviceDetails;
    $('connection-details').textContent = serviceDetails + (state.health.asrError ? `。${state.health.asrError}` : '');
  } catch { state.health = null; message('暂时无法连接服务，请稍后刷新重试。', true); }
  updateControls();
}

function view(name) {
  if (state.viewName !== name) window.scrollTo({ top: 0 });
  state.viewName = name;
  $('demo-review').hidden=name==='review';
  $('practice-view').hidden = name !== 'practice';
  $('review-view').hidden = name !== 'review';
  $('scripts-view').hidden = name !== 'scripts';
  $('breadcrumb').textContent = name === 'practice' ? '演练空间' : name === 'review' ? '演练复盘' : '下次讲稿';
  $('page-title').textContent = name === 'practice' ? '演练空间' : name === 'review' ? '演练复盘' : '下次讲稿';
  $('page-subtitle').textContent = name === 'practice' ? '用你的 PPT 试讲一次，看看哪里讲不清、哪里可以缩短。' : name === 'review' ? '结合实际发言，决定哪些地方值得调整。' : '采用的修改会更新到对应页面，留给下一次练习。';
  document.querySelectorAll('[data-view]').forEach(el => {
    const active = el.dataset.view === name; el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-phase]').forEach(el => el.classList.toggle('active', el.dataset.phase === name));
  if (name === 'review') renderReport();
  else if (name === 'scripts') workspace.renderScripts();
  else if (state.pdf) renderPage();
  if (name === 'practice') { requestAnimationFrame(fitTranscriptBoxes); fitTakeaways(); }
  workspace.renderComparison();
}

function fitTranscriptBoxes() {
  if ($('practice-view').hidden) return;
  $('segments').querySelectorAll('textarea').forEach(box => {
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + 2}px`;
  });
}
window.addEventListener('resize', fitTranscriptBoxes);

function resetSession({keepMaterialReading=false}={}) {
  state.materialPending=false;pendingMaterialFile=null;
  manualTranscriptPages.clear();
  if(!keepMaterialReading){materialReading?.controller.abort();materialReading=null;}
  slidePreviews.reset();
  document.querySelectorAll('.review-audio').forEach(audio=>audio.pause());
  state.analysis = null;
  $('audio-player').pause();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  if (state.audioPartUrls) { for (const url of state.audioPartUrls.values()) URL.revokeObjectURL(url); state.audioPartUrls.clear(); }
  state.blob = null; state.audioUrl = null; state.segments = []; state.events = []; state.duration = null; state.report = null; state.job = null; state.jobStatus = null; state.jobError = ''; state.jobTerms = null; state.jobApplied = false;
  $('audio-player').removeAttribute('src'); $('audio-section').hidden = true;
  $('audio-player').load(); $('download-audio').removeAttribute('href');
  $('timer').textContent = '00:00'; $('review-dot').hidden = true;
  $('record-label').textContent = '准备开始';
  $('record-button').innerHTML = `${icon('mic')}<span>开始演练</span>`;
  $('record-hint').textContent = ''; $('record-hint').hidden=true;
}

async function clearWorkspace() {
  if (state.busy || state.recording || !state.pages.length) return;
  setBusy(true);
  try {
    if (state.blob && !state.audioAssetId || state.pdf && !state.pdfAssetId && !state.materialPending) {
      message('当前附件尚未保存，请先保留原材料并保存录音，再重新尝试保存，避免清空后无法找回。', true);
      return;
    }
    if (!await workspace.saveAndClose()) return;
    const pdf = state.pdf;
    ++state.renderVersion;
    state.renderTask?.cancel(); state.renderTask = null; state.pdf = null;
    resetSession(); workspace.newRecord();
    state.pages = []; state.current = 1; state.demo = false;
    $('pdf-input').value = '';
    $('pdf-canvas').width = 0; $('pdf-canvas').height = 0;
    $('sample-slide').textContent = '';
    $('demo-banner').hidden = true;
    $('deck-name').textContent = '尚未导入材料';
    setAudience('老师和同学'); $('target-minutes').value = 5; $('takeaways').value = '';
    $('save-status').textContent = '导入后自动保存';
    $('save-status').classList.remove('error');
    ['issues','metrics','report-material','report-summary','report-strengths','report-next-step'].forEach(id => $(id).textContent = '');
    workspace.renderReference(); workspace.renderScripts(); renderSegments(); renderReport();
    view('practice'); await renderPage();
    if (pdf) await pdf.destroy().catch(() => {});
    message('当前页面已清空，可以上传新材料。刚才的内容已保存在历史记录中。');
    $('upload-prompt').focus();
  } catch {
    message('清空未完成，请刷新后查看历史记录。', true);
  } finally { setBusy(false); }
}

function renderThumbs() {
  const count = state.pages.length;
  $('page-navigation').hidden = !count;
  $('jump-page').max = count;
  if (document.activeElement !== $('jump-page')) $('jump-page').value = state.current;
  const markup = pageNumbers(count, state.current).map(number => typeof number === 'number'
    ? `<button class="thumb ${number === state.current ? 'selected' : ''}" data-page="${number}" aria-label="第 ${number} 页" ${number === state.current ? 'aria-current="page"' : ''}>${number}</button>`
    : '<span class="page-gap" aria-hidden="true">…</span>').join('');
  // Preserve keyboard focus during preview resizing and background updates.
  if ($('thumbs').dataset.markup === markup) return;
  const focused = $('thumbs').contains(document.activeElement);
  $('thumbs').innerHTML = markup; $('thumbs').dataset.markup = markup;
  $('thumbs').querySelectorAll('button').forEach(el => el.addEventListener('click', () => { if (!state.busy||state.materialPending) goPage(Number(el.dataset.page)); }));
  if (focused) $('thumbs').querySelector('.selected')?.focus({preventScroll:true});
}

let visiblePreview=null;
const previewFailures=new WeakMap();
const pageRenderer=createPreviewRenderer({createCanvas:()=>document.createElement('canvas'),commit:(staging,geometry)=>{
  const canvas=$('pdf-canvas');canvas.width=staging.width;canvas.height=staging.height;
  canvas.style.width=`${geometry.cssWidth}px`;canvas.style.height=`${geometry.cssHeight}px`;
  const context=canvas.getContext('2d');if(!context)throw new Error('Canvas context not supported');
  context.drawImage(staging,0,0);canvas.hidden=false;
}});
function showPreviewFailure(error,pdf,page,version){
  if(version!==state.renderVersion)return;
  const failure=previewFailure(error),panel=$('preview-error');
  $('pdf-canvas').hidden=true;panel.hidden=false;
  $('preview-error-title').textContent=`第 ${page} 页预览未能显示`;
  $('preview-error-detail').textContent=failure.message;
  $('preview-error-reference').textContent='';
  $('preview-error-reference').hidden=true;
  let keys=previewFailures.get(pdf);if(!keys){keys=new Map();previewFailures.set(pdf,keys);}
  const key=`${page}:${failure.code}:${failure.reason}`;
  if(!keys.has(key)&&state.health?.csrf){
    const fileFormat=$('deck-name').textContent.split('.').at(-1).toLowerCase();
    keys.set(key,api('/api/materials/failures',{method:'POST',body:JSON.stringify({stage:'render',code:failure.code,reason:failure.reason,page,pageCount:state.pages.length,format:['ppt','pptx','pdf'].includes(fileFormat)?fileFormat:'pdf',renderer:'legacy-5.6.205'}),signal:AbortSignal.timeout(10000)}).catch(()=>null));
  }
  keys.get(key)?.then(record=>{if(record?.reference&&version===state.renderVersion&&!panel.hidden){$('preview-error-reference').textContent=`问题编号：${record.reference}`;$('preview-error-reference').hidden=false;}});
}

async function renderPage() {
  const version = ++state.renderVersion;
  state.renderTask?.cancel();
  $('upload-prompt').hidden = Boolean(state.pages.length);
  $('preview-error').hidden=true;
  const waiting=!!state.materialPending&&state.current>state.pdf.numPages;
  $('preview-pending').hidden=!waiting;
  $('pdf-canvas').hidden = !state.pdf || visiblePreview?.pdf!==state.pdf || visiblePreview?.page!==state.current;
  $('sample-slide').hidden = !state.demo;
  $('text-slide').hidden = !state.pages.length || Boolean(state.pdf) || state.demo;
  $('text-slide').textContent = state.pages[state.current - 1]?.text || '';
  $('page-position').textContent = state.pages.length ? `${state.current} / ${state.pages.length}` : '— / —';
  $('page-count').textContent = state.pages.length ? `${state.pages.length} 页` : 'PPT / PDF';
  $('preview-resizer').hidden = !state.pages.length;
  $('fit-preview').hidden = !state.pages.length;
  $('expand-preview').hidden = !state.pdf&&!state.demo;
  renderThumbs(); updateControls();
  if(presenter.isOpen())return;
  if(waiting)return;
  if (state.demo) {
    const p = state.pages[state.current - 1];
    previewSizer.setAspectRatio($('slide-area').clientWidth<550?3/5:16/9);
    $('sample-slide').innerHTML = renderDemoSlide(p);
  } else if (state.pdf) {
    const pdf=state.pdf,pageNumber=state.current;
    state.renderTask=pageRenderer;
    try {
      const page = await pdf.getPage(pageNumber);
      if (version !== state.renderVersion) return;
      const area = $('slide-area'),base=page.getViewport({scale:1});
      previewSizer.setAspectRatio(base.width/base.height);
      if(area.clientWidth<=24||area.clientHeight<=24)return;
      const result=await pageRenderer.render(page,{width:area.clientWidth,height:area.clientHeight,pixelRatio:devicePixelRatio||1});
      if(version!==state.renderVersion||result.status==='cancelled')return;
      if(result.status==='failed')showPreviewFailure(result.error,pdf,pageNumber,version);
      else {visiblePreview={pdf,page:pageNumber};$('preview-error').hidden=true;}
    } catch (error) { if(error.name!=='RenderingCancelledException')showPreviewFailure(error,pdf,pageNumber,version); }
  }
}

function goPage(number) {
  if (number < 1 || number > state.pages.length || number === state.current) return;
  state.current = number;
  if (state.recording) state.events.push({ page: number, at: (state.recordingOffset || 0) + (performance.now() - state.started) / 1000 });
  renderPage();
  if(!state.materialPending||state.current<=state.pdf.numPages)slidePreviews.sync();
  workspace.saveSoon();
}

async function loadPdf(file) {
  if (!file || state.busy || state.recording) return;
  const extension = file.name.split('.').at(-1).toLowerCase();
  if (!['ppt', 'pptx', 'pdf'].includes(extension)) { $('pdf-input').value = ''; return message('请选择 PPT、PPTX 或 PDF 文件。', true); }
  try { validateMaterialSize(file.size); }
  catch (error) { $('pdf-input').value = ''; return message(error.message, true); }
  const controller=new AbortController();materialController=controller;
  const signal=controller.signal;
  setBusy(true); message('正在打开材料…');
  loadPdfLibrary().catch(()=>{});
  let pdf,deckPages=null,fullImport=null,firstPreparation=null,quickNode=null,quickUrl=null,quickChrome=null,previewInstalled=false;
  const clearQuick=(restore=false)=>{quickNode?.remove();quickNode=null;if(quickUrl)URL.revokeObjectURL(quickUrl);quickUrl=null;if(restore&&quickChrome)for(const [id,text] of Object.entries(quickChrome))$(id).textContent=text;quickChrome=null;};
  const quick=extension==='pptx'?localPptxPreview(file,{signal}).catch(()=>null):Promise.resolve(null);
  const showQuick=result=>{
    if(!result||signal.aborted||previewInstalled)return;
    quickUrl=URL.createObjectURL(result.blob);quickNode=document.createElement('div');quickNode.id='pptx-quick-preview';
    const image=document.createElement('img');image.src=quickUrl;image.alt='第 1 页快速预览';
    const label=document.createElement('span');label.textContent='第 1 页 · 快速预览';
    quickChrome=Object.fromEntries(['deck-name','page-position','page-count'].map(id=>[id,$(id).textContent]));
    $('deck-name').textContent=file.name;$('page-position').textContent=`1 / ${result.totalPages}`;$('page-count').textContent=`${result.totalPages} 页`;
    quickNode.append(image,label);$('slide-area').append(quickNode);
  };
  let notesResult={notes:[],status:null};
  const notesPromise=extension==='pptx'?readPptxNotes(file,{signal}).then(result=>{notesResult=result;}).catch(()=>{}):Promise.resolve();
  // Partial previews are deliberately not persisted as a complete rehearsal.
  const install=async(next,total,pending)=>{
    signal.throwIfAborted();previewInstalled=true;
    const replacingPartial=state.materialPending&&pendingMaterialFile===file;
    const current=replacingPartial?state.current:1;
    state.renderTask?.cancel();++state.renderVersion;
    const previous=state.pdf;
    if(!replacingPartial){
      if (state.demo) { setAudience('老师和同学'); $('target-minutes').value = 5; $('takeaways').value = ''; }
      resetSession();workspace.newRecord();
      state.pages=Array.from({length:total},(_,i)=>({number:i+1,text:''}));
    }
    if(replacingPartial&&state.pages.length!==total)state.pages=Array.from({length:total},(_,i)=>({number:i+1,text:''}));
    state.materialPending=pending;pendingMaterialFile=pending?file:null;
    await notesPromise;signal.throwIfAborted();
    state.originalNotes=cleanOriginalNotes(notesResult.notes,total);state.notesStatus=notesResult.status;
    state.pdf=next;state.current=Math.min(current,total);state.demo=false;
    $('demo-banner').hidden=true;$('deck-name').textContent=file.name;
    $('save-status').textContent=pending?'材料加载中':'正在保存…';
    workspace.renderReference();renderSegments();view('practice');await renderPage();clearQuick();
    if(previous&&previous!==next)await previous.destroy().catch(()=>{});
  };
  try {
    if (!await workspace.saveNow()) throw new Error('当前演练保存失败，请先在历史记录中保存恢复文件，再更换材料。');
    quick.then(showQuick);
    if(extension==='pptx'){
      deckPages=await readPptxPageCount(file);if(deckPages!==null)validateMaterialPages(deckPages);
      if(!(deckPages!==null&&deckPages<=6&&file.size<=5*1024*1024)&&!(state.materialPending&&pendingMaterialFile===file))firstPreparation=firstPptxPages(file,{signal}).catch(error=>{if(signal.aborted)return null;throw error;});
    }
    let preview=file,cached={};
    if(extension!=='pdf'){
      cached=await previewCache.find(file);signal.throwIfAborted();
      if(cached.blob&&(extension!=='ppt'||cached.notes?.status==='complete')){preview=cached.blob;if(extension==='ppt')notesResult=cached.notes;}
      else{
        if(!state.health?.csrf)await health();signal.throwIfAborted();
        // Small decks need only one conversion. Large decks prepare a compact
        // full preview while the first two pages are being converted.
        let compact=null;
        const startFull=()=>{
          if(!fullImport)fullImport=(async()=>{
            const prepared=await compact;signal.throwIfAborted();
            return importPresentation(prepared?.blob||file,extension,{token:state.health?.csrf,signal,fast:true,inline:true,onNotes:result=>{notesResult=result;},message:text=>{if(state.materialPending)message(`前两页已打开 · ${text.replace('正在上传 PPT','其余页面加载中')}`);else if(!state.pdf)message(text);}});
          })().then(blob=>({blob}),error=>({error}));
        };
        const shortDeck=deckPages!==null&&deckPages<=6&&file.size<=5*1024*1024;
        if(extension==='pptx'&&shortDeck)compact=compactPptxPreview(file,{signal}).catch(()=>null);
        if(extension==='pptx'&&!shortDeck&&!(state.materialPending&&pendingMaterialFile===file)){
          const first=await firstPreparation;
          compact=compactPptxPreview(file,{signal}).catch(()=>null);
          if(first){
            try{
              const earlySignal=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
              const early=await importPresentation(first.blob,'pptx',{token:state.health?.csrf,signal:earlySignal,fast:true,inline:true,onUploaded:startFull,message:()=>message('正在打开前两页…')});
              pdf=await openPdf(early);signal.throwIfAborted();
              if(pdf.numPages!==first.previewPages)throw new Error('Preview page count mismatch');
              await install(pdf,first.totalPages,true);
              message('前两页已打开，其余页面继续加载…');
            }catch(error){
              if(pdf&&pdf!==state.pdf){await pdf.destroy().catch(()=>{});pdf=null;}
              signal.throwIfAborted();
              // Unsupported/slow first-page conversion must not block full import.
            }
          }
        }
        if(extension==='pptx'&&!compact)compact=compactPptxPreview(file,{signal}).catch(()=>null);
        startFull();const result=await fullImport;if(result.error)throw result.error;preview=result.blob;
      }
    }
    signal.throwIfAborted();pdf=await openPdf(preview);signal.throwIfAborted();
    validateMaterialPages(pdf.numPages);
    await install(pdf,pdf.numPages,false);
    if(cached.assetId)state.pdfAssetId=cached.assetId;
    const saved=cached.assetId?await workspace.saveNow():await workspace.storeAsset(preview,'pdfAssetId');
    if(saved)void previewCache.remember(cached.key,state.pdfAssetId,extension==='ppt'?notesResult:null);
    startMaterialReading(pdf);
    message(saved?'':'材料已打开，但未完整保存在本机。请保留原文件。',!saved);
  }catch(e){
    if(pdf&&pdf!==state.pdf)await pdf.destroy().catch(()=>{});
    if(signal.aborted){message(state.materialPending?'已暂停加载，前两页仍可查看。':'已取消加载。');}
    else{
      const detail=describeMaterialError(e);
      message((state.materialPending?'其余页面未加载完成，可以点击“继续加载”。':'')+detail.message+(e.reference?`（问题编号：${e.reference}）`:''),true);
      if(state.health?.csrf)void api('/api/materials/failures',{method:'POST',body:JSON.stringify({stage:'preview',code:detail.code,format:extension,size:file.size,status:e.status||0}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
    }
  }finally{previewInstalled=true;clearQuick(true);if(fullImport)await fullImport;materialController=null;setBusy(false);$('pdf-input').value='';}
}

function startMaterialReading(pdf) {
  materialReading?.controller.abort();
  const task={pdf,controller:new AbortController(),page:0,total:state.pages.length,phase:'读取'};
  const initialTerms=JSON.stringify(state.asrTerms);
  materialReading=task;
  const current=()=>materialReading===task && state.pdf===pdf && !task.controller.signal.aborted;
  const progress=(n,total)=>{if(!current())return;task.page=n;task.total=total;};
  const onPage=page=>{
    if(!current())return;
    state.pages[page.number-1]=page;
    workspace.saveSoon();
  };
  task.promise=(async()=>{
    try{
      let pages=await readNativeText(pdf,state.pages,{progress,onPage,signal:task.controller.signal});
      if(!current())return;
      if(materialCoverage(pages).missingPages.length){
        if(!state.health)await health();
        if(!current())return;
        task.phase='识别';
        pages=await extractImageText(pdf,pages,progress,{onPage,signal:task.controller.signal});
      }
      if(!current())return;
      state.pages=pages;
      if(JSON.stringify(state.asrTerms)===initialTerms && !state.job){state.asrTerms=extractSpeechTerms(pages);$('asr-terms').value=state.asrTerms.join('\n');}
      await workspace.saveNow();
    }catch(error){if(current())workspace.saveSoon();}
    finally{if(materialReading===task){materialReading=null;updateControls();}}
  })();
  updateControls();return task.promise;
}

async function extractImageText(pdf,pages,progress,{onPage,signal}={}) {
  if(!state.health?.materialOcrConfigured)return pages;
  return readMissingText(pdf,pages,{progress,onPage,signal,recognize:blob=>api('/api/materials/ocr',{method:'POST',headers:{'Content-Type':'image/png'},body:blob,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000)})});
}
async function repairMaterialText() {
  if(state.busy||state.recording||!state.pdf)return;
  setBusy(true);
  try {
    await health();
    if(!state.health?.materialOcrConfigured)throw new Error('本机文字识别暂时不可用。');
    if(!await workspace.saveNow())throw new Error('请先保存当前记录后再读取文字。');
    const pages=await extractImageText(state.pdf,state.pages,(n,total)=>message(`正在识别材料文字 ${n} / ${total}…`));
    if(pages.some((p,i)=>p.text!==state.pages[i].text)){workspace.forkIfReviewed();state.pages=pages;await workspace.saveNow();}
    const missing=materialCoverage(pages).missingPages.length;
    renderSegments();await renderPage();view('practice');
    message(missing?`还有 ${missing} 页未读出文字，可继续演练或稍后重试。`:'材料文字已读取，分析时会结合这些内容。',Boolean(missing));
  }catch(error){message(error.message,true);}finally{setBusy(false);}
}

function renderSegments() {
  if (state.asrTerms === null) state.asrTerms = extractSpeechTerms(state.pages);
  $('asr-terms').value = state.asrTerms.join('\n');
  $('asr-terms-summary').textContent = '辅助识别：人名与术语（选填）';
  renderTimings();
  const groups = groupTranscript(state.segments, state.pages).filter(group => group.parts.length || manualTranscriptPages.has(group.page));
  $('transcript-source').textContent = state.demo ? '预设示例发言' : state.segments.some(s => s.source === 'asr') ? '录音转写' : '手动填写';
  if (!state.pages.length) {
    $('segments').innerHTML = '<div class="empty-transcript">导入材料后，每页会有一个发言框。</div>';
    updateControls(); return;
  }
  const durations = pageDurations(state.events, state.duration, state.pages.length);
  const timingAvailable=hasPageTimeline(state.events,state.pages.length) && !state.segments.some(s=>s.page===0);
  const pageOptions=selected=>state.pages.map(p=>`<option value="${p.number}" ${p.number===selected?'selected':''}>第 ${p.number} 页</option>`).join('');
  $('segments').innerHTML = groups.map(group => `<article class="segment page-transcript ${group.page===0?'unassigned-transcript':''}" data-page="${group.page}"><div class="page-transcript-heading"><h3>${group.page===0?'待分配页码':pageLabel(group.page)}</h3><span>${timingAvailable && state.duration!==null && group.page>0 ? `用时 ${formatTime(durations[group.page-1])}` : ''}</span>${state.audioUrl && (group.start!==null || state.events.some(e=>e.page===group.page))?'<button class="replay" type="button">'+icon('play')+'回听</button>':''}${group.page===0?`<label class="assign-all-label">对应页面<select data-assign-all aria-label="整段发言归到哪页"><option value="">选择页码</option>${pageOptions(0)}</select></label>`:''}</div>${group.page===0?'<p class="assignment-note">未记录翻页，可选择对应页码，也可直接分析发言。</p>':''}<textarea rows="${Math.max(3,Math.min(12,Math.ceil(group.text.length/45)))}" maxlength="12000" aria-label="${pageLabel(group.page)}发言" placeholder="录音转写后会显示在这里，也可以直接输入这页实际讲过的话。">${escape(group.text)}</textarea>${group.parts.length>1?`<details class="sentence-timeline"><summary>分段回听与页码调整</summary>${group.parts.map(part=>`<div><span>${formatTime(part.start)}</span><p>${escape(part.text)}</p>${state.audioUrl && part.start!==null?`<button type="button" data-replay="${part.start}">回听</button>`:''}<select data-move="${part.id}" aria-label="调整${part.id}的页码">${part.page===0?'<option value="0" selected disabled>待确认</option>':''}${pageOptions(part.page)}</select></div>`).join('')}</details>`:''}</article>`).join('');
  $('segments').querySelectorAll('.segment').forEach(el => {
    const page = Number(el.dataset.page);
    el.querySelector('textarea').addEventListener('input', e => {
      manualTranscriptPages.add(page);
      workspace.forkIfReviewed();
      if (!state.originalSegments.length) state.originalSegments = structuredClone(state.segments);
      state.segments = editPageTranscript(state.segments, page, e.target.value);
      el.querySelector('.sentence-timeline')?.remove();
      fitTranscriptBoxes();
      dirty(); updateControls();
    });
    el.querySelector('textarea').addEventListener('change', () => renderSegments());
    el.querySelector('.replay')?.addEventListener('click', () => replayPage(page));
  });
  $('segments').querySelectorAll('[data-replay]').forEach(el => el.addEventListener('click', () => replay(Number(el.dataset.replay))));
  $('segments').querySelectorAll('[data-move]').forEach(el => el.addEventListener('change', () => {
    workspace.forkIfReviewed();
    if (!state.originalSegments.length) state.originalSegments = structuredClone(state.segments);
    state.segments = assignTranscriptPage(state.segments,[el.dataset.move],Number(el.value),state.pages.length);
    dirty(); renderSegments();
  }));
  $('segments').querySelector('[data-assign-all]')?.addEventListener('change',e=>{
    if(!e.target.value)return;
    workspace.forkIfReviewed();
    if(!state.originalSegments.length)state.originalSegments=structuredClone(state.segments);
    state.segments=assignTranscriptPage(state.segments,state.segments.filter(s=>s.page===0).map(s=>s.id),Number(e.target.value),state.pages.length);
    dirty();renderSegments();
  });
  fitTranscriptBoxes();
  updateControls();
  workspace.renderComparison();
}

function replayPage(page) {
  const at = state.events.find(event => event.page === page)?.at ?? state.segments.find(segment => segment.page === page && segment.start !== null)?.start;
  if (Number.isFinite(at)) replay(at);
}

function renderTimings() {
  const available = Number.isFinite(state.duration) && hasPageTimeline(state.events,state.pages.length) && !state.segments.some(s=>s.page===0);
  const durations = pageDurations(state.events, state.duration, state.pages.length);
  const rate = speechMetrics(workspace.snapshot()).estimatedRate;
  $('practice-timing-details').hidden = !available;
  $('review-timing-details').hidden = !available;
  const max = Math.max(...durations, 1);
  for (const id of ['practice-timing', 'review-timing']) {
    const container = $(id); container.hidden = !available;
    if (!available) { container.innerHTML = ''; continue; }
    const expanded=container.querySelector('.timing-overflow')?.open || false;
    const row = page => `<div class="page-timing"><span>第 ${page.number} 页</span><div class="timing-track"><i style="width:${durations[page.number - 1] / max * 100}%"></i></div><strong>${formatTime(durations[page.number - 1])}</strong>${state.audioUrl && state.events.some(event => event.page === page.number) ? `<button type="button" data-timing-replay="${page.number}" aria-label="回听第${page.number}页">${icon('play')}</button>` : ''}</div>`;
    container.innerHTML = `<div class="timing-heading"><h3>每页用时</h3><span>总计 ${formatTime(state.duration)} / 目标 ${formatTime(Number($('target-minutes').value) * 60)}</span></div><p>${state.recordingStatus === 'interrupted' ? '仅为中断前暂存时长，末尾可能缺失' : '包含停顿与回翻时间'}${rate !== null ? ` · 估算语速 ${rate} 字词/分钟（含停顿，依据识别原文）` : ''}</p><div class="page-timings">${state.pages.slice(0,20).map(row).join('')}</div>${state.pages.length>20?`<details class="timing-overflow" ${expanded?'open':''}><summary>其余 ${state.pages.length-20} 页用时</summary><div class="page-timings">${state.pages.slice(20).map(row).join('')}</div></details>`:''}`;
    container.querySelectorAll('[data-timing-replay]').forEach(button => button.addEventListener('click', () => replayPage(Number(button.dataset.timingReplay))));
  }
}

function replay(time) {
  if (!state.audioUrl || time === null) return;
  void selectAudioForTime($('audio-player'), time);
}

async function selectAudioForTime(player, time) {
  const parts = state.audioParts || [];
  const part = parts.find(item => time >= item.offset && time <= item.offset + item.duration);
  let url = state.audioUrl, localTime = time;
  if (part) {
    localTime = Math.max(0,time-part.offset);
    if (part.assetId !== state.audioAssetId) {
      state.audioPartUrls ||= new Map();
      url = state.audioPartUrls.get(part.assetId);
      if (!url) {
        const blob = await localRecords.getAsset(part.assetId);
        if (!blob) return message('这段录音暂时无法读取。', true);
        url = URL.createObjectURL(blob); state.audioPartUrls.set(part.assetId,url);
      }
    }
  }
  if (player.getAttribute('src') !== url) player.src = url;
  player.currentTime = localTime;
  player.play().catch(() => message('请点击播放器继续回听。'));
}

function attachAudio(blob) {
  replayPartVersion++;if(replayPartUrl){URL.revokeObjectURL(replayPartUrl);replayPartUrl=null;}
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.blob = blob; state.audioUrl = URL.createObjectURL(blob);
  $('audio-player').src = state.audioUrl; $('audio-section').hidden = false;
  $('download-audio').href = state.audioUrl;
  $('download-audio').download = `演练录音.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`;
}

async function startRecording() {
  if (state.recording) return stopRecording();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return message('当前浏览器无法录音，请用新版 Chrome 打开本地地址。', true);
  const continuing = state.recordingStatus === 'interrupted' && Boolean(state.blob);
  if (!continuing && (state.blob || state.segments.length) && !await confirmAction('开始新的录音前会保存当前记录。新一轮需要重新转写或录入实际发言。')) return;
  setBusy(true);
  let release, stream;
  try {
    release = await acquireRecordingLock();
    if (!release) throw new Error('另一页面正在录音。请先结束那次演练，再开始新的录音。');
    stream = await getRecordingStream();
    if (!await workspace.saveNow()) throw new Error('当前记录保存失败，请先下载备份。');
    const priorId = state.id, previousRoundId = nextRoundBaseline(workspace.snapshot()), pdfAssetId = state.pdfAssetId, referenceScript = state.segments.some(s=>s.text.trim())?compileScriptPages(state.segments,state.pages,state.scripts):state.referenceScript, originalNotes = state.originalNotes, notesStatus = state.notesStatus, importedScript = state.importedScript, asrTerms = state.asrTerms;
    const offset = continuing ? (state.duration || 0) : 0;
    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    if (!continuing) {
      resetSession({keepMaterialReading:true}); workspace.newRecord();
      Object.assign(state, { parentId: priorId, previousRoundId, pdfAssetId, referenceScript, originalNotes, notesStatus, importedScript, asrTerms, audioParts: [], recordingStatus: 'recording' });
    } else {
      // Keep this same round, its transcript and page timeline. Each clip stays
      // separate so mobile browsers do not need to decode a large audio file.
      state.job = null; state.jobStatus = null; state.jobError = ''; state.jobApplied = false;
      state.recordingStatus = 'recording';
    }
    Object.assign(state, { recordingMime: recorder.mimeType || mimeType || 'audio/webm', recordingOffset: offset });
    state.stream = stream; state.recorder = recorder;
    const chunks = []; let interrupted = false, checkpointFailed = false, disposeGuard=()=>{};
    state.recordingStoppedAt=null;state.recordingStopRequested=false;
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      const index = chunks.length; chunks.push(event.data);
      const elapsed = offset + ((state.recordingStoppedAt??performance.now()) - state.started) / 1000;
      if (!checkpointFailed) workspace.checkpointRecording(event.data, index, elapsed).catch(() => {
        checkpointFailed = true; interrupted = true;
        if (!state.recording) state.recordingStatus = 'interrupted';
        message('录音临时保存失败，已停止继续录制。请先下载录音，避免丢失。', true); stopRecording();
      });
    };
    recorder.onstart = () => {
      state.started = performance.now();
      if (continuing) state.events.push({ page: state.current, at: offset });
      else state.events = [{ page: state.current, at: 0 }];
      state.recording = true; state.unsaved = true;
      disposeGuard=watchRecording({stream,recorder,onInterrupt:()=>{interrupted=true;stopRecording();}});
      setBusy(false); $('record-button').innerHTML = `${icon('stop')}<span>结束演练</span>`; $('record-indicator').classList.add('live');
      $('record-label').textContent = continuing ? '继续汇报中' : '正在录音'; $('record-hint').hidden=false; $('record-hint').textContent = '请在网页里用 ← → 或翻页按钮切换 PPT。WPS / PowerPoint 中的翻页不会同步。';
      state.timer = setInterval(() => { const elapsed = offset + ((state.recordingStoppedAt??performance.now()) - state.started) / 1000; $('timer').textContent = formatTime(elapsed); if (elapsed >= 1200) stopRecording(); }, 250);
    };
    recorder.onstop = async () => {
      clearInterval(state.timer); setBusy(true);
      disposeGuard();
      if(!state.recordingStopRequested)interrupted=true;
      const clipDuration = Math.max(0,((state.recordingStoppedAt??performance.now()) - state.started) / 1000);
      state.duration = offset + clipDuration;
      state.recording = false; state.recordingStatus = interrupted ? 'interrupted' : 'complete';
      stream.getTracks().forEach(track => track.stop());
      let saved = false;
      try {
        if (chunks.length) {
          const clip = new Blob(chunks, { type: state.recordingMime });
          attachAudio(clip); saved = await workspace.finishRecording(clip);
          if (saved) {
            await workspace.saveNow();
          }
        }
        else { state.recordingStatus = 'interrupted'; saved = await workspace.saveNow(); }
      } finally { release(); }
      $('record-button').innerHTML = `${icon('mic')}<span>${interrupted ? '继续汇报' : '重新演练'}</span>`; $('record-indicator').classList.remove('live');
      $('record-label').textContent = interrupted ? '录音曾中断' : '演练已结束';
      $('record-hint').textContent = !chunks.length ? '没有录到有效音频，请检查麦克风权限后重试。' : !saved ? '请先下载录音，本机未能完整保存。' : interrupted ? '已暂停并保存录音。点击“继续汇报”接着讲，暂停时间不计入演练。' : continuing ? '续录已接在本次演练后，点击“转写录音”会依次处理所有片段。' : '录音已保存在本机，转写后可核对发言。';
      $('timer').textContent = formatTime(state.duration); renderSegments(); setBusy(false);
      message($('record-hint').textContent, !saved || interrupted || !chunks.length);
    };
    recorder.onerror = () => { interrupted = true; message('录音设备发生错误，正在保存已录到的片段…', true); stopRecording(); };
    state.duration=offset;
    if(!await workspace.saveNow())throw new Error('录音准备保存失败，请检查本机空间后重试。');
    recorder.start(500); message('');
  } catch (e) {
    stream?.getTracks().forEach(track => track.stop()); release?.();
    if(e.name==='AbortError'){message('');setBusy(false);return;}
    message(e.name === 'NotAllowedError' ? '麦克风权限未开启。可以允许录音，也可以手动录入发言。' : e.message || '录音未能开始，请检查麦克风和浏览器。', true); setBusy(false);
  }
}

function stopRecording() {
  if (!state.recording) return;
  if(state.recordingStopRequested)return;
  state.recordingStopRequested=true;state.recordingStoppedAt=performance.now();
  state.duration = (state.recordingOffset || 0) + (state.recordingStoppedAt - state.started) / 1000;
  clearInterval(state.timer); setBusy(true);
  if (state.recorder?.state !== 'inactive') state.recorder.stop();
}

async function transcribe(retry = false) {
  if (!state.blob || state.busy || state.recording) return;
  if (!state.transcribingParts && state.audioParts?.length > 1) return transcribeAudioParts(retry);
  const terminal = ['failed','uncertain','expired'].includes(state.jobStatus);
  if (retry && (!terminal || !state.job)) return;
  if (retry && !await confirmAction(state.jobStatus === 'uncertain' ? '上次提交未能确认，服务商可能已经计费。重新提交可能产生重复费用。确定要重新提交吗？' : '将重新调用语音服务处理这条录音，可能产生费用。确定继续吗？')) return;
  if (!state.activeAudioPart && state.segments.some(s=>s.text.trim()) && !await confirmAction('获取转写结果后会替换当前发言。当前内容会先保存在历史记录中。继续吗？')) return;
  setBusy(true); message(state.job && !retry ? '正在获取已有转写任务…' : '正在检查录音并提交转写…');
  try {
    if (!await workspace.saveNow()) throw new Error('当前记录未保存成功，请先下载录音和备份。');
    await health();
    if (!state.health) throw new Error('无法连接本地服务。录音仍保留，服务恢复后可继续获取。');
    if (state.health.asrError) throw new Error(state.health.asrError);
    if (!state.health.asrConfigured) throw new Error('语音服务尚未配置，请填写百炼密钥并重启本地服务。');
    // Persist immutable terms before POST. A lost response can then be looked up
    // with exactly the same audio fingerprint instead of silently making a new job.
    const termsKey = terms => JSON.stringify([...cleanSpeechTerms(terms || [])].sort());
    if (state.jobStatus === 'complete' && termsKey(state.jobTerms) !== termsKey(state.asrTerms)) {
      state.job = null; state.jobStatus = null; state.jobApplied = false;
    }
    if (!state.job || retry) {
      const termsChanged = termsKey(state.jobTerms) !== termsKey(state.asrTerms);
      const retryId = retry && !termsChanged ? state.job : null;
      if (!state.jobStatus || retry) state.jobTerms = [...(state.asrTerms || [])];
      state.job = null; state.jobStatus = 'submitting'; state.jobError = ''; state.jobApplied = false;
      if (!await workspace.saveNow()) throw new Error('任务设置未保存成功，尚未提交识别。');
      const form = new FormData(); form.append('audio',state.blob,'recording'); form.append('terms',JSON.stringify(state.jobTerms || []));
      if (retryId) form.append('retryId', retryId);
      const submission = await api('/api/transcriptions', {method:'POST',body:form,signal:AbortSignal.timeout(120000)});
      state.job = submission.id; state.jobStatus = submission.status; state.jobError = submission.error || '';
      if (!await workspace.saveNow()) throw new Error('服务已收到任务，但本机保存失败。请保留此页面，修复存储后继续获取。');
    }
    state.asrController = new AbortController(); updateControls();
    const until = Date.now() + 10 * 60 * 1000;
    while (Date.now() < until) {
      const result = await api(`/api/transcriptions/${state.job}`, {signal:AbortSignal.any([state.asrController.signal, AbortSignal.timeout(45000)])});
      state.jobStatus = result.status; state.jobError = result.error || '';
      if (result.status === 'complete') {
        if (!await workspace.saveNow()) throw new Error('当前修改未保存，暂未替换发言。请先导出备份。');
        workspace.forkIfReviewed(state.segments.some(s => s.text.trim()));
        const part = state.activeAudioPart;
        if (part) {
          const shifted = result.segments.map(segment => ({ ...segment, start:segment.start + part.offset, end:segment.end + part.offset }));
          const aligned = alignSegments(shifted, state.events, state.pages.length).map((segment,index) => ({ ...segment, id:`s${state.segments.length + index + 1}`, audioPartIndex:state.audioParts.indexOf(part) }));
          state.segments = [...state.segments, ...aligned]; part.transcribed = true; part.transcript = structuredClone(aligned);
        } else {
          state.segments = alignSegments(result.segments, state.events, state.pages.length);
          const latestPart = state.audioParts?.at(-1);
          if (latestPart?.assetId === state.audioAssetId) {
            latestPart.transcribed = true; latestPart.transcript = structuredClone(state.segments);
            Object.assign(latestPart, { job:state.job, jobStatus:state.jobStatus, jobTerms:state.jobTerms, jobError:state.jobError });
          }
        }
        state.originalSegments = structuredClone(state.segments); state.jobApplied = true;
        const saved = await workspace.saveNow();
        renderSegments();
        message(saved ? `${result.vocabularyWarning || ''}${result.cacheHit ? '已获取保存的识别结果。' : ''}${state.segments.some(s=>s.page===0)?'转写已保存，请在下方确认发言页码。':'转写已按页整理，请先核对识别错字。'}` : '发言已显示，但本机保存失败，请立即导出备份。', !saved);
        return;
      }
      await workspace.saveNow(); updateControls();
      if (['failed','uncertain','expired'].includes(result.status)) throw new Error(result.error || '转写未完成，请检查任务状态。');
      message('语音服务正在转写，录音不需要重复上传…');
      await new Promise((resolve, reject) => {
        const signal = state.asrController.signal;
        if (signal.aborted) return reject(new DOMException('已暂停等待','AbortError'));
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('已暂停等待','AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 3000);
        signal.addEventListener('abort', onAbort, {once:true});
      });
    }
    message('转写仍未完成。稍后点击「继续获取转写结果」，不会重复提交任务。', true);
  } catch (e) {
    if (e.jobId) state.job = e.jobId;
    if (e.status === 404 && state.job) { state.jobStatus = 'missing'; state.jobError = '原服务未找到这条任务。请确认启动的是原项目目录；不会自动重新计费。'; }
    else if(state.jobStatus==='submitting'&&!state.job&&rejectedTranscriptionSubmission(e)){
      state.jobStatus=null;state.jobError=e.status>=500?'转写服务提交失败，录音已保留。请点击“继续转写”重试。':e.message;
    }
    else if (state.jobStatus === 'submitting') {
      state.jobStatus = state.job ? 'pending' : 'uncertain';
      state.jobError = state.job ? '提交连接中断，可继续获取已有任务。' : '提交结果尚未确认。再次点击会先检查相同录音的任务，不会主动创建重复识别。';
    }
    await workspace.saveNow();
    message(state.asrController?.signal.aborted ? '已暂停等待。转写任务仍保留，稍后点击继续获取即可。' : state.jobError ? transcriptionRecoveryMessage() : e.message || '连接中断，请稍后继续获取。', !state.asrController?.signal.aborted);
  } finally { state.asrController = null; setBusy(false); }
}

async function transcribeAudioParts(retry = false) {
  const savedBlob = state.blob, savedJob = { job:state.job, jobStatus:state.jobStatus, jobTerms:state.jobTerms, jobError:state.jobError, jobApplied:state.jobApplied };
  state.transcribingParts = true;
  try {
    for (const part of state.audioParts) {
      if (part.transcribed) continue;
      const blob = await localRecords.getAsset(part.assetId);
      if (!blob) { message('有一段录音附件未能读取，请先恢复本机存储或导入备份。', true); return; }
      state.activeAudioPart = part; state.blob = blob;
      state.job = part.job || null; state.jobStatus = part.jobStatus || null; state.jobTerms = part.jobTerms || null; state.jobError = part.jobError || ''; state.jobApplied = false;
      await transcribe(retry && ['failed','uncertain'].includes(state.jobStatus));
      Object.assign(part, { job:state.job, jobStatus:state.jobStatus, jobTerms:state.jobTerms, jobError:state.jobError, transcribed:Boolean(part.transcribed) });
      await workspace.saveNow();
      if (!part.transcribed) return;
    }
    message('所有录音片段已转写并合并到本次发言。请核对文字后分析。');
  } finally {
    state.activeAudioPart = null; state.transcribingParts = false; state.blob = savedBlob;
    const pendingPart = state.audioParts.find(part => !part.transcribed);
    const statusPart = pendingPart || state.audioParts.at(-1);
    Object.assign(state, statusPart ? { job:statusPart.job||null, jobStatus:statusPart.jobStatus||null, jobTerms:statusPart.jobTerms||null, jobError:statusPart.jobError||'', jobApplied:Boolean(statusPart.transcribed) } : savedJob);
    updateControls();
  }
}

function getSession() {
  return { pages: state.pages.map(p => ({ number: p.number, text: p.text, textSource:p.textSource })), segments: state.segments.filter(s => s.text.trim()), events: state.events,
    durationSeconds: state.duration, targetSeconds: Number($('target-minutes').value) * 60, audience: audienceValue(), takeaways: $('takeaways').value,
    transcriptSource: getTranscriptSource(state.segments, Boolean(state.blob)) };
}

async function analyze() {
  if (state.busy || state.recording) return;
  state.analysis = { status: 'pending', startedAt: Date.now(), detail: '正在保存本次发言…' };
  setBusy(true); message(''); view('review'); window.scrollTo({ top: 0 });
  const timer = setInterval(renderAnalysisState, 1000);
  try {
    if(materialReading){state.analysis.detail='正在结合材料整理本次复盘…';renderAnalysisState();await materialReading.promise;}
    let session = validateSession(getSession());
    if (!await workspace.saveNow()) throw new Error('本次发言尚未保存成功，暂未提交分析。请先保留页面并导出备份。');
    if (!state.demo) {
      state.analysis.detail = '正在检查模型连接…'; renderAnalysisState();
      await health();
      if (!state.health) throw new Error('无法连接本地服务。录音和发言已保留，请恢复服务后重试。');
      if (!state.health.textConfigured) throw new Error('文字模型尚未配置，请先检查模型服务。');
    }
    if(!state.demo && state.pdf && state.health?.materialOcrConfigured && materialCoverage(state.pages).missingPages.length){
      const pages=await extractImageText(state.pdf,state.pages,(n,total)=>{state.analysis.detail=`正在读取图片里的文字 ${n} / ${total}…`;renderAnalysisState();});
      if(pages.some((p,i)=>p.text!==state.pages[i].text)){
        workspace.forkIfReviewed();state.pages=pages;session=validateSession(getSession());
        if(!await workspace.saveNow())throw new Error('材料文字尚未保存，请保留页面并重试。');
      }
    }
    state.analysis.detail = '正在核对用时，并查找需要重点检查的页面。'; renderAnalysisState();
    const report = state.demo ? structuredClone(demo.report) : await automaticCoach('diagnose',session,{api,onProgress:detail=>{state.analysis.detail=detail;renderAnalysisState();}});
    workspace.replaceReport(report);
    const saved = await workspace.saveNow();
    state.analysis = null;
    $('review-dot').hidden = false; message(saved ? '' : '复盘已生成，但本机保存失败，请先导出复盘。', !saved);
    view('review'); window.scrollTo({ top: 0 });
  } catch (e) {
    state.analysis = { status: 'error', detail: e.name === 'TimeoutError' ? '等待分析超时，录音和发言已保留。可以稍后重试；相同内容会先复用已有或正在进行的分析。' : e instanceof TypeError ? '分析连接中断，录音和发言已保留。请检查本地服务和网络后重试。' : e.message || '分析未完成，请稍后重试。' };
    message(''); view('review'); window.scrollTo({ top: 0 });
  } finally { clearInterval(timer); setBusy(false); }
}

function renderAnalysisState() {
  const pending = state.analysis?.status === 'pending';
  $('analysis-progress').hidden = !state.analysis;
  $('analysis-progress').setAttribute('aria-busy', String(pending));
  if (!state.analysis) return;
  $('analysis-title').textContent = pending ? '正在分析本次演练' : '本次分析未完成';
  $('analysis-detail').textContent = state.analysis.detail;
  $('analysis-elapsed').textContent = pending ? `已等待 ${formatTime((Date.now() - state.analysis.startedAt) / 1000)} · 较长发言可能需要 1–3 分钟，请保持页面打开。` : '无需重新录音或重新转写。';
  $('analysis-scope').hidden = true;
  $('retry-analysis').hidden = pending;
}

function renderReport() {
  document.querySelectorAll('.review-audio').forEach(audio => audio.pause());
  $('partial-review-warning').hidden = state.recordingStatus !== 'interrupted';
  renderTimings();
  workspace.renderComparison();
  renderAnalysisState();
  $('review-empty').hidden = Boolean(state.report || state.analysis || state.goalAgent); $('review-content').hidden = !state.report || Boolean(state.analysis);
  if (!state.report || state.analysis) return;
  const report = state.report = contextualReport(state.report,getSession()); const target = Number($('target-minutes').value) * 60;
  $('report-investigation').hidden=!report.investigation?.checkedPages?.length;
  $('report-investigation-detail').textContent=report.investigation?.checkedPages?.length?`重点读取了第 ${report.investigation.checkedPages.join('、')} 页的材料与原话，并结合全场发言核对。${report.investigation.note||''}`:'';
  const coverage = report.materialCoverage || materialCoverage(state.pages);
  $('report-coverage').hidden = !coverage.note; $('report-coverage').textContent = coverage.missingPages.length ? `${coverage.missingPages.length} 页文字未参与分析` : '';
  $('repair-report-material').hidden=!coverage.missingPages.length || !state.pdf;
  $('report-material').textContent = $('deck-name').textContent;
  const durations = pageDurations(state.events, state.duration, state.pages.length);
  const max = hasPageTimeline(state.events,state.pages.length) && !state.segments.some(s=>s.page===0) ? Math.max(...durations, 0) : 0; const longest = max ? `第 ${durations.indexOf(max) + 1} 页` : state.segments.some(s=>s.page===0)?'页码待确认':'未记录翻页';
  const delta = state.duration === null ? '手动文本不推算时长' : state.duration > target ? `超过目标 ${formatTime(state.duration - target)}` : `目标 ${formatTime(target)}`;
  $('metrics').innerHTML = `<div class="metric"><label>本次演练时长</label><strong>${formatTime(state.duration)}</strong><small class="${state.duration>target?'status-pill warning':''}">${delta}</small></div><div class="metric"><label>停留最久的页面</label><strong>${longest}</strong><small>${max ? `${formatTime(max)} · 包含停顿时间` : '需要网页内录音和翻页记录'}</small></div><div class="metric metric-issues"><label>${report.issues.length?'待核对的建议':report.practiceSuggestions?.length?'下一步练习':'修改建议'}</label><strong>${report.issues.length||report.practiceSuggestions?.length||0} <span style="font-size:12px">${report.issues.length?'条':report.practiceSuggestions?.length?'项':'条'}</span></strong></div>`;
  renderTimeCoach();
  $('report-summary').innerHTML = paragraphs(report.issues.length ? `${report.inputCoverage?.scope==='brief'?'本次只分析已讲的片段。':''}${report.issues[0].action==='clarify'?'先确认':'先调整'}${report.issues[0].page>0?`第 ${report.issues[0].page} 页的`:''}${conciseIssueTitle(report.issues[0].title)}。` : report.summary);
  $('strengths-block').hidden = !report.strengths?.length;
  $('report-strengths').innerHTML = (report.strengths || []).map(text => `<li>${escape(text)}</li>`).join('');
  $('report-outdated').hidden = Boolean(report.evidenceRejected) || report.source==='goal_plan' || state.demo || !state.health?.diagnosisPromptVersion || state.report.promptVersion === state.health.diagnosisPromptVersion;
  $('report-next-step').innerHTML = paragraphs(Object.keys(state.scripts).length ? `已更新 ${Object.keys(state.scripts).length} 段讲稿，可以挑一页或完整再练一次。` : report.issues.length ? '先选择一条建议，采用后查看下次讲稿，或直接练这一页。' : '可以再讲一遍，或试着回答听众的追问。');
  $('issues-section').hidden=!report.issues.length && !report.evidenceRejected;
  $('practice-suggestions').hidden=!report.practiceSuggestions?.length;
  $('practice-suggestion-list').innerHTML=(report.practiceSuggestions||[]).map((item,i)=>`<article class="practice-suggestion"><span class="practice-number">${i+1}</span><div><h3>${escape(item.title)}${item.origin==='practice_template'?'<small>练习方法</small>':''}</h3>${paragraphs(item.action)}<details><summary>从这句开始</summary><blockquote>${escape(item.quote)}</blockquote></details></div></article>`).join('');
  // Keep optional detail panels stable while an issue is edited or adopted.
  const openDetails = new Set($('issues').dataset.sessionId === state.id ? [...$('issues').querySelectorAll('details[open][data-detail-key]')].map(el=>el.dataset.detailKey) : []);
  const openPanels = new Set($('issues').dataset.sessionId === state.id ? [...$('issues').querySelectorAll('.issue-extra-panel:not([hidden])')].map(el=>el.dataset.panelKey) : []);
  $('issues').dataset.sessionId = state.id;
  const actions = {clarify:'需要确认',revise:'建议',rehearse:'练习方法'};
  const issueCards = report.issues.map((issue, i) => {
    const result = state.rewrites[i]?.result;
    const hasRewrite = Boolean(result);
    return `<article class="issue-card compact-issue" data-issue-index="${i}"><div class="issue-heading"><span class="issue-index">${String(i+1).padStart(2,'0')}</span><h3>${escape(conciseIssueTitle(issue.title))}</h3><span class="chip">${pageLabel(issue.page)}</span></div><div class="issue-body">${issue.page>0?`<div class="issue-material">${slidePreview(issue.page)}</div>`:''}<div class="issue-edit"><div class="issue-quote-label">原话</div><blockquote>“${escape(issue.quote)}”</blockquote>${!hasRewrite ? `<div class="issue-action"><strong>${actions[issue.action] || actions.clarify}</strong>${paragraphs(issue.suggestion)}${issue.question ? `<p class="followup-question">${escape(issue.question)}</p>` : ''}</div>` : ''}${workspace.issueTools(issue, i)}<div class="issue-footer"><details class="issue-more" data-detail-key="${i}-more"><summary>查看依据</summary><div class="issue-more-body"><p class="issue-reason">${escape(issue.why.replace(/\s+/g,' '))}</p><div class="issue-evidence-actions"><button class="evidence-button" data-evidence="${i}">${state.audioUrl && issue.start !== null ? `${icon('play')}回听 ${formatTime(issue.start)}` : `查看完整发言`}</button></div></div></details>${issue.page > 0 ? `<button type="button" class="text-button" data-train-issue="${i}">练这一页 ↗</button>` : ''}</div></div></div></article>`;
  });
  $('issues').innerHTML = issueCards.slice(0,3).join('') + (issueCards.length>3?`<details class="more-issues" data-detail-key="more-issues" ${openDetails.has('more-issues')?'open':''}><summary>更多建议（${issueCards.length-3} 条）</summary>${issueCards.slice(3).join('')}</details>`:'');
  $('issues').querySelectorAll('.issue-card').forEach(card=>{
    const index=Number(card.dataset.issueIndex);
    const tools=card.querySelector('.issue-tools'), rewrite=tools?.querySelector('.rewrite-panel');
    if(rewrite)tools.before(rewrite);
    const more=card.querySelector('.issue-more-body');
    for(const [selector,label] of [['.feedback-form','评价建议'],['.rewrite-preferences','修改偏好']]){
      const detail=card.querySelector(selector);
      if(!detail)continue;
      const key=`${index}-${selector.slice(1)}`,panel=document.createElement('div');
      panel.className=`issue-extra-panel ${selector.slice(1)}`;panel.id=`issue-extra-${key}`;
      panel.dataset.panelKey=key;panel.hidden=!openPanels.has(key);
      detail.querySelector('summary')?.remove();
      while(detail.firstChild)panel.append(detail.firstChild);
      detail.remove();more.querySelector('.issue-evidence-actions').insertAdjacentElement('afterend',panel);
      const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent=label;
      button.setAttribute('aria-controls',panel.id);button.setAttribute('aria-expanded',String(!panel.hidden));
      button.addEventListener('click',()=>{
        const opening=panel.hidden;
        more.querySelectorAll('.issue-extra-panel').forEach(el=>{el.hidden=true;});
        more.querySelectorAll('[aria-controls]').forEach(el=>el.setAttribute('aria-expanded','false'));
        panel.hidden=!opening;button.setAttribute('aria-expanded',String(opening));
      });
      more.querySelector('.issue-evidence-actions').append(button);
    }
    tools?.remove();
    card.querySelectorAll('details[data-detail-key]').forEach(el=>{el.open=openDetails.has(el.dataset.detailKey);});
  });
  $('issues').querySelector('.more-issues')?.addEventListener('toggle',()=>{if($('issues').querySelector('.more-issues')?.open)slidePreviews.render($('review-content'));});
  training.renderEntry(); training.bindIssues();
  workspace.bindIssues(); updateControls();
  slidePreviews.render($('review-content'));
  if (!report.issues.length && report.evidenceRejected) $('issues').innerHTML = '<div class="issue-card issue-empty"><strong>暂未生成可核对的建议</strong><p>可先查看本次用时，或点击下方按钮重试分析。</p><button class="button secondary" id="retry-evidence">重试分析</button></div>';
  $('retry-evidence')?.addEventListener('click', analyze);
  $('issues').querySelectorAll('[data-evidence]').forEach(button => button.addEventListener('click', () => {
    const issue = report.issues[Number(button.dataset.evidence)];
    if(state.audioUrl){playReviewAudio(button,issue.start ?? state.events.find(event=>event.page===issue.page)?.at ?? 0);return;}
    if(issue.page>0)state.current = issue.page; view('practice'); renderPage();
    const segment = $('segments').querySelector(`[data-page="${issue.page}"]`);
    segment?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    replay(issue.start);
  }));
}

function renderTimeCoach() {
  const budget=timeBudget(getSession()),plan=state.report?.timePlan;
  $('time-coach').hidden=!budget || state.recordingStatus==='interrupted';
  if(!budget)return;
  $('time-coach').innerHTML=`<div class="time-coach-heading" ${plan?.items?.length?'hidden':''}><div><h2>需压缩 ${formatTime(budget.excessSeconds)} · 目标 ${Math.round(budget.targetSeconds/60)} 分钟</h2></div>${!plan?'<button class="button secondary" data-time-plan>看看怎么压缩</button>':''}</div><p id="time-plan-status" role="status"></p>${plan?.items?.length?`<details class="time-plan-details" ${state.timePlanOpen?'open':''}><summary>压缩 ${formatTime(budget.excessSeconds)} · 查看调整方案</summary><div class="time-plan-grid">${plan.items.map(item=>`<article class="time-plan-card"><div class="time-page-heading"><h3>第 ${item.page} 页</h3><span>${formatTime(item.currentSeconds)} → 试讲 ${formatTime(item.targetSeconds)}</span></div><p class="time-action">${escape(item.action)}</p><details><summary>对照原话与 PPT</summary><dl><dt>保留</dt><dd>“${escape(item.keepQuote)}”</dd><dt>合并或缩短</dt><dd>“${escape(item.cutQuote)}”</dd></dl>${slidePreview(item.page)}<button class="text-button" data-time-replay="${item.page}">回听本页</button></details></article>`).join('')}</div><p class="time-plan-note">试讲目标需通过重练验证。${plan.remainingSeconds?` 目前还差约 ${plan.remainingSeconds} 秒需要取舍。`:''}</p></details>`:''}`;
  $('time-coach').querySelector('.time-plan-details')?.addEventListener('toggle',e=>{state.timePlanOpen=e.currentTarget.open;});
  $('time-coach').querySelector('[data-time-plan]')?.addEventListener('click',generateTimePlan);
  $('time-coach').querySelectorAll('[data-time-replay]').forEach(button=>{
    button.hidden=!state.audioUrl;
    button.addEventListener('click',()=>playReviewAudio(button,state.events.find(event=>event.page===Number(button.dataset.timeReplay))?.at ?? 0));
  });
}

function playReviewAudio(button, start) {
  let audio=button.parentElement.querySelector('.review-audio');
  if(!audio){audio=document.createElement('audio');audio.controls=true;audio.className='review-audio';audio.setAttribute('aria-label','回听本次录音');button.insertAdjacentElement('afterend',audio);}
  $('audio-player').pause();document.querySelectorAll('.review-audio').forEach(other=>{if(other!==audio)other.pause();});
  void selectAudioForTime(audio,start);
}

async function generateTimePlan() {
  if(state.busy||!state.report||!timeBudget(getSession()))return;
  setBusy(true);$('time-plan-status').textContent='正在结合每页发言制定压缩计划…';
  try {
    await health();if(!state.health)throw new Error('本地服务连接中断，请稍后重试。');
    const result=await automaticCoach('compress',getSession(),{api,onProgress:detail=>{$('time-plan-status').textContent=detail;}});
    if(!result.items?.length)throw new Error('暂未生成可核对的压缩计划。');
    state.report.timePlan=result;delete state.report.timePlanError;state.timePlanOpen=true;
    const saved=await workspace.saveNow();renderReport();
    if(!saved)message('计划已显示，但本机保存失败，请先导出复盘。',true);
  }catch(error){$('time-plan-status').textContent=error.name==='TimeoutError'?'压缩计划生成超时，可以稍后重试。':error.message;}
  finally{setBusy(false);}
}

async function loadDemo() {
  if ((state.blob || state.segments.length) && !state.demo && !await confirmAction('示例会替换当前材料和发言，请先保存需要的内容。')) return;
  state.renderTask?.cancel(); if (state.pdf) state.pdf.destroy(); state.pdf = null;
  await workspace.saveNow();
  resetSession(); workspace.newRecord(); state.demo = true; state.pages = structuredClone(demo.pages); state.current = 1;
  state.segments = structuredClone(demo.segments); state.events = structuredClone(demo.events); state.duration = demo.durationSeconds;
  setAudience(demo.audience); $('target-minutes').value = demo.targetSeconds / 60; $('takeaways').value = demo.takeaways;
  $('deck-name').textContent = demo.name; $('demo-banner').hidden = false;
  $('timer').textContent = formatTime(state.duration); message(''); renderSegments(); view('practice'); renderPage();
  workspace.replaceReport(structuredClone(demo.report));$('review-dot').hidden=false;
  $('record-label').textContent = '示例演练 · 已结束';
  $('record-hint').textContent = '可以查看示例复盘；导入自己的 PPT 或 PDF 后开始真实演练。';
  workspace.renderReference(); await workspace.saveNow();
}

function exportReport() {
  workspace.exportReadableReport();
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
$('repair-report-material').addEventListener('click',analyze);
$('pdf-input').addEventListener('change', e => loadPdf(e.target.files[0]));
$('import-material').addEventListener('click', () => { loadPdfLibrary().catch(()=>{}); $('pdf-input').click(); });
$('clear-workspace').addEventListener('click', clearWorkspace);
$('cancel-material').addEventListener('click',()=>materialController?.abort());
$('retry-material').addEventListener('click',()=>loadPdf(pendingMaterialFile));
$('upload-prompt').addEventListener('click', () => { loadPdfLibrary().catch(()=>{}); $('pdf-input').click(); });
$('prev-page').addEventListener('click', () => goPage(state.current - 1));
$('next-page').addEventListener('click', () => goPage(state.current + 1));
$('record-button').addEventListener('click', startRecording);
$('transcribe-button').addEventListener('click', () => transcribe());
$('pause-transcription').addEventListener('click', () => state.asrController?.abort());
$('retry-transcription').addEventListener('click', () => transcribe(true));
$('asr-terms').addEventListener('input', () => { state.asrTerms = cleanSpeechTerms($('asr-terms').value.split(/[\n、，,]/)); workspace.saveSoon(); });
function openManualTranscript() {
  if (!state.pages.length || state.busy || state.recording || state.demo) return;
  manualTranscriptPages.add(state.current);
  renderSegments();
  const input = $('segments').querySelector(`[data-page="${state.current}"] textarea`);
  input?.focus({preventScroll:true}); input?.scrollIntoView({behavior:'smooth',block:'center'});
}
$('add-segment').addEventListener('click', openManualTranscript);
$('manual-entry').addEventListener('click', openManualTranscript);
$('manual-after-transcription').addEventListener('click', openManualTranscript);
$('analyze-button').addEventListener('click', analyze);
$('retry-analysis').addEventListener('click', analyze);
$('analysis-back').addEventListener('click', () => view('practice'));
$('demo-button').addEventListener('click', loadDemo);
$('demo-review').addEventListener('click',()=>{if(state.demo){if(!state.report)workspace.replaceReport(structuredClone(demo.report));view('review');}});
$('exit-demo').addEventListener('click', async () => {
  await workspace.saveNow(); resetSession(); workspace.newRecord(); state.demo = false; state.pages = []; state.current = 1;
  $('demo-banner').hidden = true; $('deck-name').textContent = '还没有导入材料';
  setAudience('老师和同学'); $('target-minutes').value = 5; $('takeaways').value = '';
  workspace.renderReference(); renderSegments(); view('practice'); renderPage(); $('pdf-input').click();
});
$('back-to-practice').addEventListener('click', () => view('practice'));
$('review-script').addEventListener('click',()=>view('scripts'));
$('review-back').addEventListener('click', () => view('practice'));
$('scripts-back-review').addEventListener('click', () => view(state.report ? 'review' : 'practice'));
$('refresh-report').addEventListener('click', () => { if (!state.busy) analyze(); });
$('export-report').addEventListener('click', exportReport);
$('connection').addEventListener('click', () => $('connection-dialog').showModal());
$('close-dialog').addEventListener('click', () => $('connection-dialog').close());
['audience','audience-custom','takeaways','target-minutes'].forEach(id => $(id).addEventListener(id === 'audience' ? 'change' : 'input', () => { if(id==='audience') $('audience-custom').hidden=$('audience').value!=='__custom__'; dirty(); updateControls(); }));
document.querySelectorAll('[data-goal]').forEach(button => button.addEventListener('click', () => {
  const current = $('takeaways').value.trim(), goal = button.dataset.goal;
  if (!current.split('\n').includes(goal)) {
    const next = current ? `${current}\n${goal}` : goal;
    if (next.length > 2000) return message('重点描述已达到字数上限，请先精简内容。', true);
    $('takeaways').value = next; dirty(); updateControls();
  }
  $('takeaways').focus();
}));
document.addEventListener('keydown', event => {
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName) || document.querySelector('dialog[open]') || (state.busy&&!state.materialPending) || $('practice-view').hidden) return;
  if (event.key === 'ArrowRight') goPage(state.current + 1);
  if (event.key === 'ArrowLeft') goPage(state.current - 1);
});
window.addEventListener('beforeunload', event => { if (state.recording || state.unsaved) { event.preventDefault(); event.returnValue = ''; } });
const previewSizer = createPreviewSizer({area: $('slide-area'), handle: $('preview-resizer'), fitButton: $('fit-preview'), onResize: () => { if (state.pdf && !$('practice-view').hidden) renderPage(); }});
function jumpToPage() {
  const number = Number($('jump-page').value);
  if (!state.busy && Number.isInteger(number) && number >= 1 && number <= state.pages.length) goPage(number);
  $('jump-page').value = state.current;
}
$('jump-page').addEventListener('change', jumpToPage);
$('jump-page').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); jumpToPage(); } });
$('retry-preview').addEventListener('click',()=>{if(state.pdf)void renderPage();});
$('audio-part-picker').onchange=async()=>{
 const index=Number($('audio-part-picker').value),part=state.audioParts?.[index],version=++replayPartVersion;if(!part)return;
 try{const blob=await localRecords.getAsset(part.assetId);if(version!==replayPartVersion)return;if(!blob)throw new Error('这一段录音暂时无法读取。');
 if(replayPartUrl)URL.revokeObjectURL(replayPartUrl);replayPartUrl=URL.createObjectURL(blob);$('audio-player').src=replayPartUrl;$('download-audio').href=replayPartUrl;$('download-audio').download=`演练录音-第${index+1}段.${blob.type.includes('mp4')?'m4a':'webm'}`;
 }catch(error){message(error.message,true);}
};
$('expand-preview').textContent='演讲者视图';
$('expand-preview').addEventListener('click',()=>presenter.open());
workspace.boot().then(()=>setTimeout(()=>{if(!state.recording)void loadPdfLibrary().catch(()=>{});},1200));
