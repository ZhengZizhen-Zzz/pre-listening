import {GoalAgentRuns,GOAL_AGENT_VERSION} from './lib/goal-agent.mjs';
import http from 'node:http';
import {PaidTasks} from './lib/paid-tasks.mjs';
import {QuestionJobs} from './lib/question-jobs.mjs';
import {CoachRuns} from './lib/coach-runs.mjs';
import {REACT_VERSION} from './lib/coach-react.mjs';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { getConfig, analyze, startTranscription, pollTranscription, DIAGNOSIS_PROMPT_VERSION } from './lib/providers.mjs';
import { AnalysisCache, analysisKey } from './lib/analysis-cache.mjs';
import { validateSession, validateReport } from './public/core.mjs';
import { validateRevisionInput, initialClarification } from './public/revision-core.mjs';
import { revise, REVISION_PROMPT_VERSION } from './lib/rewriter.mjs';
import { findOfficeConverter, convertOfficeToPdf, convertOfficeFileToPdf, MAX_DECK_BYTES } from './lib/office-import.mjs';
import { createSpeechVocabulary, removeSpeechVocabulary, recoverSpeechVocabularies } from './lib/speech-vocabulary.mjs';
import { cleanSpeechTerms } from './public/speech-terms.mjs';
import { makeTimePlan, TIME_PLAN_VERSION } from './lib/time-coach.mjs';
import { TranscriptionJobs } from './lib/transcription-jobs.mjs';
import { ocrAvailable, recognizePage } from './lib/material-ocr.mjs';
import { TrialAccess, loginPage, TRIAL_OWNER_LIMIT, TRIAL_TOTAL_LIMIT } from './lib/trial-access.mjs';
import { buildClientAssets, prepareAsset, sendAsset } from './lib/client-assets.mjs';
import { validateTrainingInput, validateQuestions } from './public/training-core.mjs';
import { train, TRAINING_VERSION } from './lib/training.mjs';
import { rewriteAnswer, ANSWER_REVISION_VERSION } from './lib/answer-rewriter.mjs';
import { FeedbackStore } from './lib/feedback-store.mjs';
import { FEEDBACK_MAX_BYTES } from './public/feedback-core.mjs';
import { MaterialImports } from './lib/material-imports.mjs';
import { MAX_UPLOAD_CHUNK_BYTES, INLINE_UPLOAD_BYTES } from './public/material-limits.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const config = getConfig();
const trial = process.env.TRIAL_DIR ? new TrialAccess(path.resolve(process.env.TRIAL_DIR)) : null;
if (trial) await trial.init();
const feedbackStore = new FeedbackStore(process.env.REHEARSAL_FEEDBACK_DIR || path.join(trial?.directory || path.join(root,'.local/trial'),'feedback'));
const client = await buildClientAssets(root);
const clientHtml = await prepareAsset(client.html,'text/html; charset=utf-8','private, no-cache');
const staticAssets = new Map();
const officeConverter = await findOfficeConverter();
const materialOcrConfigured = await ocrAvailable();
let convertingDeck = false;
const materialImports = new MaterialImports({directory:path.join(trial?.directory || process.env.REHEARSAL_DATA_DIR || path.join(root,'.local'),'material-imports'),convert:(file,format,output)=>convertOfficeFileToPdf(file,format,officeConverter,output)});
let materialsReady;
const diagnosticRate = new Map();
const csrf = randomBytes(24).toString('hex');
const analysisCache = new AnalysisCache();
const revisionCache = new AnalysisCache();
const timePlanCache = new AnalysisCache();
const trainingCache = new AnalysisCache();
const questionJobs = new QuestionJobs({produce:(request,onQuestionsReady,prepared,owner,options)=>paidTask(()=>train('questions',request,config,fetch,{onQuestionsReady,prepared}),owner,options)});
let paidRequests = 0;
const paidTasks=new PaidTasks(async owner=>{
  if(paidRequests>=config.maxPaid)throw error('本次启动的调用次数已达到上限，请先检查用量。',429);
  if(trial)await trial.consume(owner);paidRequests++;
},{maxForeground:3});
const coachRuns = new CoachRuns({config,paidTask});
const goalAgentRuns = new GoalAgentRuns({config,paidTask});
const jobs = new TranscriptionJobs({
  file: path.join(trial?.directory || process.env.REHEARSAL_DATA_DIR || path.join(root, '.local'), 'transcription-jobs.json'), config,
  start: (bytes, mime, settings, onSubmitting) => startTranscription(bytes, mime, settings, fetch, onSubmitting),
  poll: pollTranscription,
  createVocabulary: terms => createSpeechVocabulary(terms, config),
  removeVocabulary: id => removeSpeechVocabulary(id, config),
  beforeSubmit: owner => paidTasks.acquire(owner)
});
let jobsReady, jobRecoveryError = '';
const error = (message, status) => Object.assign(new Error(message), { status });
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream' };

async function body(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw error('文件或请求过大。', 413);
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > limit) throw error('文件或请求过大。', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function paidTask(task, owner = 'local', {background=false} = {}) {
  if(background&&trial&&trial.usage.total>=TRIAL_TOTAL_LIMIT-2)throw error('当前试用额度优先保留给主动练习。',429);
  return paidTasks.run(task,owner,{background});
}

async function jsonBody(req, limit = 1024 * 1024) {
  try { return JSON.parse((await body(req, limit)).toString()); }
  catch (e) { if (e.status) throw e; throw error('请求不是有效 JSON。', 400); }
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    await jobsReady;
    const expected = `127.0.0.1:${server.address().port}`;
    const pathname = new URL(req.url, `http://${expected}`).pathname;
    // A trial login never grants access to the local feedback inbox.
    if (trial && (pathname.startsWith('/api/feedback-admin') || pathname.startsWith('/feedback-admin'))) throw error('文件不存在。',404);
    let owner = 'local', requestCsrf = csrf;
    let allowedOrigins = [`http://${expected}`, `http://localhost:${server.address().port}`];
    if (trial) {
      const publicUrl = await trial.origin();
      if (req.headers.host !== publicUrl.host) throw error('试用地址不匹配，请使用邀请链接。', 403);
      allowedOrigins = [publicUrl.origin];
      if (pathname === '/trial-login' || pathname === '/api/health') res.on('finish', () => console.info(`Trial ${req.method} ${pathname} ${res.statusCode}`));
      if (req.method === 'GET' && pathname === '/trial-login.mjs') {
        res.writeHead(200, {'Content-Type':'text/javascript','Cache-Control':'no-store'});
        return res.end(await readFile(path.join(root,'public','trial-login.mjs')));
      }
      const html = (status, message = '') => { res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(loginPage(message)); };
      const session = trial.session(req);
      if (req.method === 'POST' && pathname === '/trial-login') {
        if (req.headers.origin !== publicUrl.origin) throw error('不允许跨站登录。', 403);
        const form = new URLSearchParams((await body(req, 1024)).toString());
        let cookie;
        try { cookie = trial.login(form.get('password') || '', session); }
        catch (e) { if ([401,429].includes(e.status)) return req.headers.accept === 'application/json' ? json(e.status,{error:e.message}) : html(e.status, e.message); throw e; }
        if (req.headers.accept === 'application/json') { res.setHeader('Set-Cookie',cookie); return json(200,{ok:true}); }
        res.writeHead(303, {'Set-Cookie':cookie,Location:'/', 'Cache-Control':'no-store'}); return res.end();
      }
      if (!session) {
        if (req.method === 'GET' && ['/','/trial-login'].includes(pathname)) return html(200);
        throw error('请先打开邀请链接，输入试用密码。', 401);
      }
      owner = session.owner; requestCsrf = trial.csrf(owner);
    } else if (req.headers.host !== expected && req.headers.host !== `localhost:${server.address().port}`) throw error('仅允许本机访问。', 403);
    if (req.method === 'GET' && pathname === '/api/health') return json(200, { textConfigured: Boolean(config.key), asrConfigured: Boolean(config.asrKey), asrReady: !jobRecoveryError, asrError: jobRecoveryError, officeImportConfigured: Boolean(officeConverter), materialOcrConfigured, provider: config.provider, model: config.model, diagnosisPromptVersion: DIAGNOSIS_PROMPT_VERSION, coachReactVersion: REACT_VERSION, goalAgentVersion:GOAL_AGENT_VERSION, trainingPromptVersion: TRAINING_VERSION, answerRevisionVersion: ANSWER_REVISION_VERSION, csrf:requestCsrf, paidRequests:trial ? (trial.usage.owners[owner] || 0) : paidRequests, maxPaidRequests:trial ? TRIAL_OWNER_LIMIT : config.maxPaid, trialMode:Boolean(trial) });
    if (pathname.startsWith('/api/')) {
      if (req.headers['x-local-token'] !== requestCsrf) throw error('请求已过期，请刷新网页。', 403);
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) throw error('不允许跨站请求。', 403);
    }
    if (req.method === 'POST' && pathname === '/api/goal-agent') {
      if(!config.key)throw error('文字模型尚未连接，请稍后重试。',503);
      return json(202,goalAgentRuns.create(await jsonBody(req),owner));
    }
    const goalRoute=pathname.match(/^\/api\/goal-agent\/([a-f0-9-]{36})(?:\/(retry|cancel))?$/);
    if(goalRoute){
      const [,id,action]=goalRoute;
      if(req.method==='GET'&&!action)return json(200,goalAgentRuns.get(id,owner));
      if(req.method==='POST'&&action==='retry')return json(202,goalAgentRuns.start(id,owner,{retry:true}));
      if(req.method==='POST'&&action==='cancel')return json(200,goalAgentRuns.cancel(id,owner));
      throw error('请求方式不正确。',405);
    }
    if (req.method === 'POST' && pathname === '/api/coach/automatic') {
      if (!config.key) throw error('文字模型尚未连接，请稍后重试。',503);
      return json(202,coachRuns.createAutomatic(await jsonBody(req),owner));
    }
    if (req.method === 'POST' && pathname === '/api/coach') {
      if (!config.key) throw error('文字模型尚未连接，请稍后重试。',503);
      return json(202,coachRuns.create(await jsonBody(req),owner));
    }
    const coachRoute=pathname.match(/^\/api\/coach\/([a-f0-9-]{36})(?:\/(start|retry|cancel))?$/);
    if(coachRoute){
      const [,id,action]=coachRoute;
      if(req.method==='GET'&&!action)return json(200,coachRuns.get(id,owner));
      if(req.method==='POST'&&action==='cancel')return json(200,coachRuns.cancel(id,owner));
      if(req.method==='POST'&&['start','retry'].includes(action))return json(202,coachRuns.start(id,owner,{retry:action==='retry'}));
      throw error('请求方式不正确。',405);
    }
    if (req.method === 'POST' && pathname === '/api/feedback') {
      return json(200,await feedbackStore.submit(owner,await jsonBody(req,FEEDBACK_MAX_BYTES)));
    }
    if (!trial && req.method === 'GET' && pathname === '/api/feedback-admin') {
      return json(200,{items:await feedbackStore.list()});
    }
    if (!trial && req.method === 'GET' && pathname.startsWith('/api/feedback-admin/')) {
      const {fingerprint,clientId,...submission}=await feedbackStore.get(pathname.slice('/api/feedback-admin/'.length));
      return json(200,submission);
    }
    if (pathname.startsWith('/api/materials/')) await materialsReady;
    if (req.method === 'POST' && pathname === '/api/materials/failures') {
      const now=Date.now(),previous=diagnosticRate.get(owner)||[];
      const recent=previous.filter(at=>now-at<60000);
      if(recent.length>=10)throw error('错误记录已收到。',429);
      recent.push(now);if(diagnosticRate.size>1000)diagnosticRate.clear();diagnosticRate.set(owner,recent);
      return json(200,await materialImports.record(await jsonBody(req,2048)));
    }
    const sendReadyMaterial=async id=>{
      const controller=new AbortController(),closed=()=>controller.abort();res.on('close',closed);
      let job;
      try{job=await materialImports.wait(id,owner,{signal:controller.signal});}
      catch(e){if(controller.signal.aborted)return;throw e;}
      finally{res.removeListener('close',closed);}
      if(res.destroyed)return;
      if(job.state==='failed')throw Object.assign(new Error(job.error),{status:422,code:job.code});
      if(job.state!=='complete')return json(202,job);
      const preview=materialImports.preview(id,owner);
      res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':preview.size,'Cache-Control':'no-store','X-Material-Import':id});
      const stream=createReadStream(preview.file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
    };
    if(req.method==='POST'&&pathname==='/api/materials/imports/inline'){
      if(!officeConverter)throw error('材料转换服务暂时不可用，请稍后重试或先导出为 PDF。',503);
      const job=await materialImports.receive(owner,{format:String(req.headers['x-deck-format']||''),requestId:String(req.headers['x-upload-request-id']||'')},await body(req,INLINE_UPLOAD_BYTES));
      return await sendReadyMaterial(job.id);
    }
    const cancelImport=pathname.match(/^\/api\/materials\/imports\/requests\/([a-f0-9-]{36})$/);
    if(req.method==='DELETE'&&cancelImport)return json(200,await materialImports.cancelRequest(cancelImport[1],owner));
    if (req.method === 'POST' && pathname === '/api/materials/imports') {
      if(!officeConverter)throw error('材料转换服务暂时不可用，请稍后重试或先导出为 PDF。',503);
      return json(201,await materialImports.create(owner,await jsonBody(req,2048)));
    }
    const materialRoute = pathname.match(/^\/api\/materials\/imports\/([a-f0-9-]{36})(?:\/(complete|preview|ready|notes|chunks\/(\d+)))?$/);
    if(materialRoute){
      const [,id,action,index]=materialRoute;
      if(req.method==='GET'&&!action)return json(200,materialImports.get(id,owner));
      if(req.method==='PUT'&&index!==undefined){const job=materialImports.lookup(id,owner);return json(200,await materialImports.put(id,owner,Number(index),await body(req,Math.min(job.chunkBytes,MAX_UPLOAD_CHUNK_BYTES))));}
      if(req.method==='POST'&&action==='complete')return json(202,await materialImports.finish(id,owner));
      if(req.method==='DELETE'&&!action)return json(200,await materialImports.cancel(id,owner));
      if(req.method==='GET'&&action==='ready')return await sendReadyMaterial(id);
      if(req.method==='GET'&&action==='notes')return json(200,await materialImports.notes(id,owner));
      if(req.method==='GET'&&action==='preview'){
        const preview=materialImports.preview(id,owner);
        res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':preview.size,'Cache-Control':'no-store'});
        const stream=createReadStream(preview.file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
      }
      throw error('不支持这种导入操作。',405);
    }
    if (req.method === 'POST' && pathname === '/api/materials/ocr') {
      if(!materialOcrConfigured)throw error('本机文字识别尚未配置。',503);
      return json(200,await recognizePage(await body(req,8*1024*1024)));
    }
    if (req.method === 'POST' && pathname === '/api/materials/convert') {
      if (convertingDeck) throw error('已有材料正在转换，请稍后再试。', 409);
      convertingDeck = true;
      try {
        const bytes = await body(req, MAX_DECK_BYTES);
        const pdf = await convertOfficeToPdf(bytes, String(req.headers['x-deck-format'] || '').toLowerCase(), officeConverter);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store' });
        return res.end(pdf);
      } finally { convertingDeck = false; }
    }
    if(req.method==='POST'&&pathname==='/api/training/question-jobs'){
      if(!config.key)throw error('文字模型尚未连接，请稍后重试。',503);
      const input=await jsonBody(req),request=validateTrainingInput('questions',input);
      if(input.seedQuestions!==undefined){
        if(!Array.isArray(input.seedQuestions)||input.seedQuestions.length>request.count)throw error('已有问题数量不合法。',400);
        if(input.seedQuestions.length)request.seedQuestions=validateQuestions({questions:input.seedQuestions},request.session,input.seedQuestions.length,false).questions;
      }
      const prepared=input.prepared?validateQuestions(input.prepared,request.session,request.count,false):undefined;
      const job=questionJobs.create(request,owner,{retry:input.retry===true,prepared,background:input.background===true});
      return json(202,await questionJobs.first(job.id,owner));
    }
    if(req.method==='GET'&&pathname.startsWith('/api/training/question-jobs/'))return json(200,questionJobs.get(pathname.split('/').at(-1),owner));
    if (req.method === 'POST' && /^\/api\/training\/(questions|answer|drill|rewrite)$/.test(pathname)) {
      if (!config.key) throw error('文字模型尚未连接，请稍后重试。', 503);
      const kind = pathname.split('/').at(-1);
      const request = validateTrainingInput(kind, await jsonBody(req));
      const version = kind === 'rewrite' ? ANSWER_REVISION_VERSION : TRAINING_VERSION;
      const key = createHash('sha256').update(JSON.stringify({kind,request,provider:config.provider,model:config.model,version})).digest('hex');
      const result = await trainingCache.getOrCreate(`${owner}:${key}`, () => paidTask(() => kind === 'rewrite' ? rewriteAnswer(request,config) : train(kind, request, config), owner));
      return json(200, {...result.report, cacheHit:result.cacheHit});
    }
    if (req.method === 'POST' && pathname === '/api/time-plan') {
      const session = validateSession(await jsonBody(req));
      const result = await timePlanCache.getOrCreate(`${owner}:${analysisKey(session,config,TIME_PLAN_VERSION)}`,()=>paidTask(()=>makeTimePlan(session,config),owner));
      return json(200,{...result.report,cacheHit:result.cacheHit});
    }
    if (req.method === 'POST' && pathname === '/api/revise') {
      if (!config.key) throw error('尚未配置文字模型，请查看连接说明。', 503);
      const request = validateRevisionInput(await jsonBody(req), validateSession, validateReport);
      const question = initialClarification(request);
      if (question) return json(200, { ...question, source: 'workflow', promptVersion: REVISION_PROMPT_VERSION });
      const key = createHash('sha256').update(JSON.stringify({ request, provider: config.provider, model: config.model, version: REVISION_PROMPT_VERSION })).digest('hex');
      const result = await revisionCache.getOrCreate(`${owner}:${key}`, () => paidTask(() => revise(request, config),owner));
      return json(200, { ...result.report, cacheHit: result.cacheHit });
    }
    if (req.method === 'POST' && ['/api/analyze', '/api/transcriptions'].includes(pathname)) {
      if (pathname === '/api/analyze') {
        if (!config.key) throw error('尚未配置文字模型，请查看连接说明。', 503);
        const input = await jsonBody(req);
        const session = validateSession(input);
        const result = await analysisCache.getOrCreate(`${owner}:${analysisKey(session, config, DIAGNOSIS_PROMPT_VERSION)}`, () => paidTask(async () => ({ ...await analyze(session, config), generatedAt: new Date().toISOString() }),owner), { cacheable: report => !report.evidenceRejected });
        return json(200, { ...result.report, cacheHit: result.cacheHit });
      }
      if (jobRecoveryError) throw error(jobRecoveryError, 503);
      if (!config.asrKey) throw error('尚未配置语音转写，可先手动录入发言并使用 DeepSeek 分析。', 503);
      const contentType = String(req.headers['content-type'] || '');
      let mime = contentType.split(';')[0], bytes, terms = [], retryId;
      if (mime === 'multipart/form-data') {
        const raw = await body(req, 25 * 1024 * 1024 + 65536);
        let form;
        try { form = await new Response(raw, {headers:{'Content-Type':contentType}}).formData(); } catch { throw error('录音上传格式不正确。',400); }
        const audio = form.get('audio');
        if (!audio || typeof audio.arrayBuffer !== 'function' || audio.size > 25 * 1024 * 1024) throw error('录音为空或超过25MB。',400);
        bytes = Buffer.from(await audio.arrayBuffer()); mime = audio.type.split(';')[0];
        retryId = String(form.get('retryId') || '') || undefined;
        try { terms = cleanSpeechTerms(JSON.parse(String(form.get('terms') || '[]'))); } catch { throw error('识别词表格式不正确。',400); }
      } else bytes = await body(req, 25 * 1024 * 1024);
      if (!['audio/webm','video/webm','audio/ogg','audio/wav','audio/x-wav','audio/mpeg','audio/mp4','video/mp4','audio/x-m4a'].includes(mime)) throw error('暂不支持这种录音格式。', 400);
      if (!bytes.length) throw error('录音文件为空。', 400);
      const result = await jobs.submit(bytes, mime, terms, { retryId, owner });
      return json(result.status === 'complete' ? 200 : 202, result);
    }
    if (req.method === 'GET' && pathname.startsWith('/api/transcriptions/')) {
      if (jobRecoveryError) throw error(jobRecoveryError, 503);
      return json(200, await jobs.get(pathname.split('/').at(-1),owner));
    }
    if (pathname.startsWith('/api/')) throw error('接口不存在。', 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw error('请求方法不支持。', 405);
    const publicDir = path.join(root, 'public');
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    if (trial && relative.startsWith('feedback-admin')) throw error('文件不存在。',404);
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(publicDir + path.sep) || relative.split('/').some(p => p.startsWith('.'))) throw error('文件不存在。', 404);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw error('文件不存在。', 404);
    if (relative === 'index.html') return sendAsset(req,res,clientHtml);
    const stamp=`${info.mtimeMs}:${info.size}`;
    let asset=staticAssets.get(file);
    if (!asset || asset.stamp!==stamp) {
      const policy=/^assets\/[\w-]+-[A-Z0-9]{8}\.(js|css)$/.test(relative) ? 'private, max-age=31536000, immutable' : relative.startsWith('vendor/') ? 'private, max-age=86400' : 'private, no-cache';
      asset={stamp,...await prepareAsset(await readFile(file),types[path.extname(file)]||'application/octet-stream',policy)};
      if (staticAssets.size>=80) staticAssets.delete(staticAssets.keys().next().value);
      staticAssets.set(file,asset);
    }
    return sendAsset(req,res,asset);
  } catch (e) { if(req.url?.startsWith('/api/transcriptions'))console.error(JSON.stringify({event:'asr_request_error',at:new Date().toISOString(),status:e.status||500,code:e.code||'request_failed',errorType:e.name||'Error',submissionStarted:e.submissionStarted})); if(req.url?.startsWith('/api/materials/'))console.error(JSON.stringify({event:'material_error',at:new Date().toISOString(),status:e.status||500,code:typeof e.code==='string'&&/^[a-z_]+$/.test(e.code)?e.code:'request_failed'})); if (!res.headersSent) json(e.status || 500, { ...(e.code?{code:e.code}:{}), error: e.status ? e.message : '本地服务遇到错误，请查看终端并重试。', ...(e.jobId ? { jobId: e.jobId } : {}), ...(e.submissionStarted===false?{submissionStarted:false}:{}) }); else res.end(); }
});

// Acquire the listening port before touching recovery files. A second launch on
// an occupied port must not alter a running server's in-flight task journal.
server.on('listening', () => {
  materialsReady = materialImports.init();
  materialsReady.catch(()=>{});
  jobsReady = jobs.init().then(() => recoverSpeechVocabularies(config, jobs.protectedVocabularyIds())).catch(error => {
    jobRecoveryError = error.status ? error.message : '本机任务记录暂时不可用，转写已暂停。已有材料和录音仍可查看与下载。';
    console.error(jobRecoveryError);
  });
});

server.on('close',()=>materialImports.close());

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。若演练页面能打开，无需重复启动；否则请关闭旧启动窗口后再试。` : `本地服务启动失败：${error.code || '未知错误'}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Rehearsal prototype: http://127.0.0.1:${port} | text: ${config.key ? 'configured' : 'not configured'} | speech: ${config.asrKey ? 'configured' : 'not configured'}`));
}
