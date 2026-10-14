import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cleanSpeechTerms } from '../public/speech-terms.mjs';

const fault = (message, status = 503, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const DAY = 86400000;
export function transcriptionKey(bytes, mime, terms, model) {
  return createHash('sha256').update(bytes).update(JSON.stringify([mime, model, [...cleanSpeechTerms(terms)].sort()])).digest('hex');
}

// The journal is outside public/. It holds provider task IDs and results, never
// credentials or raw audio. Persist intent BEFORE a potentially billable POST.
export class TranscriptionJobs {
  constructor({ file, config, start, poll, createVocabulary, removeVocabulary, now = Date.now, beforeSubmit = async () => {}, afterSubmit = () => {}, maxEntries = 1000 }) {
    Object.assign(this, { file, config, start, poll, createVocabulary, removeVocabulary, now, beforeSubmit, afterSubmit, maxEntries });
    this.jobs = new Map(); this.submitting = new Map(); this.polling = new Map(); this.writes = Promise.resolve();
  }
  async init() {
    let data;
    try { data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return; throw fault('转写任务记录无法读取。为避免重复计费，已停止提交，请保留记录文件后检查。'); }
    if (data.version !== 1 || !Array.isArray(data.jobs)) throw fault('转写任务记录格式异常，已停止提交。');
    for (const job of data.jobs) {
      if (typeof job?.id !== 'string' || !job.id || typeof job.key !== 'string' || !job.key || !Number.isFinite(job.created) || !['submitting','pending','complete','failed','uncertain','expired'].includes(job.status) || job.status === 'pending' && (typeof job.taskId !== 'string' || !job.taskId) || job.status === 'complete' && (!Array.isArray(job.result?.segments) || job.result.status !== 'complete')) throw fault('转写任务记录损坏，已停止提交。');
      if (job.status === 'submitting') {
        job.status = job.providerSubmissionStarted ? 'uncertain' : 'failed';
        job.error = job.providerSubmissionStarted ? '上次提交被中断，无法确认服务商是否已接收。不会自动重新计费。' : '上次上传被中断，尚未提交识别，可重试。';
      }
      this.jobs.set(job.id, job);
    }
    await this.save();
  }
  async save() {
    const data = JSON.stringify({ version: 1, jobs: [...this.jobs.values()] });
    const operation = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.writes = operation;
    return operation;
  }
  protectedVocabularyIds() {
    return new Set([...this.jobs.values()].filter(j => ['pending', 'submitting', 'uncertain'].includes(j.status)).map(j => j.vocabularyId).filter(Boolean));
  }
  public(job, cacheHit = false) {
    return { id: job.id, status: job.status, cacheHit, createdAt: new Date(job.created).toISOString(),
      vocabularyApplied: Boolean(job.vocabularyApplied), vocabularyWarning: job.vocabularyWarning || '',
      ...(job.error ? { error: job.error } : {}), ...(job.result || {}) };
  }
  async submit(bytes, mime, values, { retryId, owner = 'local' } = {}) {
    const terms = cleanSpeechTerms(values), fingerprint = transcriptionKey(bytes, mime, terms, this.config.asrModel);
    const key = owner === 'local' ? fingerprint : createHash('sha256').update(JSON.stringify([owner,fingerprint])).digest('hex');
    if (this.submitting.has(key)) return this.public(await this.submitting.get(key), true);
    const existing = [...this.jobs.values()].reverse().find(j => j.key === key && (j.owner || 'local') === owner);
    if (existing && (!retryId || retryId !== existing.id || !['failed', 'uncertain', 'expired'].includes(existing.status))) {
      await this.save(); // also retries a journal write that failed after provider acceptance
      return this.public(existing, true);
    }
    if (retryId && (!existing || existing.id !== retryId)) throw fault('录音或术语已变化，请先检查本次转写设置。', 409);
    const task = this.startJob(bytes, mime, terms, key, owner);
    this.submitting.set(key, task);
    try { return this.public(await task); } finally { this.submitting.delete(key); }
  }
  async startJob(bytes, mime, terms, key, owner) {
    // Only old completed/failed records are retired; never silently forget an
    // outstanding provider submission and then submit it again.
    for (const [id, job] of this.jobs) if (['complete', 'failed'].includes(job.status) && this.now() - job.created > 7 * DAY) this.jobs.delete(id);
    if (this.jobs.size >= this.maxEntries) throw fault('本机转写任务记录已达到上限，请先检查历史任务。', 429);
    let release;
    try{release=await this.beforeSubmit(owner);}
    catch(e){throw Object.assign(e,{submissionStarted:false,code:'asr_admission_failed'});}
    const job = { id: randomUUID(), key, owner, created: this.now(), model: this.config.asrModel, status: 'submitting', providerSubmissionStarted: false };
    this.jobs.set(job.id, job);
    try {
      await this.save();
      try { job.vocabularyId = await this.createVocabulary(terms); job.vocabularyApplied = Boolean(job.vocabularyId); }
      catch { job.vocabularyWarning = '本次人名与术语提示未能启用，已使用基础识别。'; }
      await this.save();
      job.taskId = await this.start(bytes, mime, { ...this.config, vocabularyId: job.vocabularyId }, async () => {
        job.providerSubmissionStarted = true;
        try { await this.save(); } catch (e) { job.providerSubmissionStarted = false; throw e; }
      });
      job.status = 'pending';
      await this.save();
      return job;
    } catch (e) {
      if (job.taskId) { // Keep the accepted ID in memory; retry saving before any resubmission.
        job.status = 'pending';
        throw fault('服务商已接收任务，但本机保存失败。请勿重新录制；修复存储后继续获取结果。', 503, { jobId: job.id });
      }
      job.status = job.providerSubmissionStarted && !e.providerRejected ? 'uncertain' : 'failed';
      job.error = job.status === 'uncertain' ? '提交结果未确认，服务商可能已接收。不会自动重新提交；原录音仍保留。' : (e.status ? e.message : '任务未能提交，请检查网络或本机存储后重试。');
      await this.save();
      if (job.status === 'failed') await this.cleanup(job);
      return job;
    } finally { if(typeof release==='function')release();this.afterSubmit(); }
  }
  async cleanup(job) {
    if (job.vocabularyId && await this.removeVocabulary(job.vocabularyId).catch(() => false)) { job.vocabularyId = null; await this.save(); }
  }
  async get(id, owner = 'local') {
    const job = this.jobs.get(id);
    if (!job || (job.owner || 'local') !== owner) throw fault('未找到这条转写任务，录音仍保留。请检查是否使用了原来的浏览器和试用链接。', 404);
    if (job.status !== 'pending') {
      await this.save(); // Retry a failed result write before claiming completion.
      if (['complete', 'failed'].includes(job.status)) await this.cleanup(job);
      return this.public(job, job.status === 'complete');
    }
    if (this.polling.has(id)) return this.polling.get(id);
    const pending = this.pollJob(job);
    this.polling.set(id, pending);
    try { return await pending; } finally { this.polling.delete(id); }
  }
  async pollJob(job) {
    try {
      const result = await this.poll(job.taskId, { ...this.config, asrModel: job.model });
      if (result.status === 'complete') { job.result = result; job.status = 'complete'; job.finished = this.now(); await this.save(); await this.cleanup(job); }
      return this.public(job);
    } catch (e) {
      if (e.terminal) { job.status = 'failed'; job.error = e.message; await this.save(); await this.cleanup(job); return this.public(job); }
      // A network timeout while polling doesn't imply the task failed.
      throw e;
    }
  }
}
