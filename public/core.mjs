import { validateMaterialPages } from './material-limits.mjs';

export function pageAt(events, time) {
  let page = events[0]?.page ?? 1;
  for (const event of events) { if (event.at > time) break; page = event.page; }
  return page;
}

export function pageLabel(page) { return page > 0 ? `第 ${page} 页` : '页码待确认'; }
export function hasPageTimeline(events, pageCount) { return events.length > 0 && (pageCount === 1 || new Set(events.map(e => e.page)).size > 1); }

export function alignSegments(segments, events, pageCount = 1) {
  const unassigned = pageCount > 1 && new Set(events.map(e => e.page)).size < 2;
  return segments.map((s, i) => {
    const timed = Number.isFinite(s.start) && Number.isFinite(s.end);
    const {pageStatus, ...source} = s;
    return {
      ...source, id: s.id || `s${i + 1}`,
      page: unassigned ? 0 : timed && events.length ? pageAt(events, (s.start + s.end) / 2) : (s.page || 1),
      ...(unassigned ? {pageStatus:'unassigned'} : {}),
      crossesPage: timed && events.some(e => e.at > s.start && e.at < s.end)
    };
  });
}

export function pageDurations(events, duration, count) {
  const result = Array(count).fill(0);
  if (!Number.isFinite(duration) || duration < 0) return result;
  events.forEach((e, i) => {
    const stop = Math.min(events[i + 1]?.at ?? duration, duration);
    if (e.page >= 1 && e.page <= count) result[e.page - 1] += Math.max(0, stop - e.at);
  });
  return result;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '未计时';
  const n = Math.max(0, Math.round(seconds));
  return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
}

export function materialCoverage(pages = []) {
  const missingPages = pages.flatMap((p, i) => p.text?.trim() ? [] : [p.number ?? i + 1]);
  const mode = missingPages.length === pages.length ? 'speech_only' : missingPages.length ? 'partial' : 'slides_and_speech';
  const note = mode === 'speech_only' ? 'PPT 未提取到文字，本次仅分析发言和用时，暂不核对幻灯片内容。'
    : mode === 'partial' ? `第 ${missingPages.join('、')} 页未提取到文字；这些页仅分析发言，不核对幻灯片内容。` : '';
  return { mode, missingPages, note, ocrPages: pages.filter(p=>p.textSource==='ocr').map(p=>p.number) };
}

export function validateSession(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  validateMaterialPages(Array.isArray(input?.pages) ? input.pages.length : 0);
  const pages = input.pages.map((p, i) => ({ number: i + 1, text: typeof p.text === 'string' ? p.text.trim() : '', ...(p.textSource==='ocr'?{textSource:'ocr'}:{}) }));
  if (pages.some(p => p.text.length > 12000) || pages.reduce((n, p) => n + p.text.length, 0) > 80000) fail('材料文字过多，请缩小文件范围。');
  if (!Array.isArray(input.segments) || !input.segments.length || input.segments.length > 1200) fail('请先转写或录入真实发言。');
  const ids = new Set();
  let total = 0;
  const segments = input.segments.map((s, i) => {
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    if (!text || text.length > 12000) fail('发言文本为空或过长。');
    total += text.length;
    const timed = s.start != null || s.end != null;
    if (timed && (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end < s.start || s.end > 1200)) fail('发言时间戳不合法。');
    const id = String(s.id || `s${i + 1}`);
    if (!/^s\d+$/.test(id) || ids.has(id)) fail('发言编号不合法。');
    ids.add(id);
    const page = s.page ?? 1;
    if (!Number.isInteger(page) || page < 0 || page > pages.length || page === 0 && s.pageStatus !== 'unassigned') fail('发言页码不合法。');
    return { id, text, page, ...(page===0?{pageStatus:'unassigned'}:{}), start: timed ? s.start : null, end: timed ? s.end : null,
      source: ['asr', 'edited', 'manual'].includes(s.source) ? s.source : 'unknown' };
  });
  if (total > 80000) fail('发言过长，请缩小演练范围。');
  const duration = input.durationSeconds ?? null;
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 1200)) fail('演练时长不合法。');
  const events = Array.isArray(input.events) ? input.events : [];
  if (events.length > 2000) fail('翻页事件过多。');
  let previous = -1;
  for (const event of events) {
    if (!Number.isInteger(event.page) || event.page < 1 || event.page > pages.length || !Number.isFinite(event.at) || event.at < previous || event.at < 0 || (duration !== null && event.at > duration)) fail('翻页时间线不合法。');
    previous = event.at;
  }
  const target = Number(input.targetSeconds || 300);
  if (!Number.isFinite(target) || target < 60 || target > 600) fail('目标时长须为 1–10 分钟。');
  if (String(input.audience || '').length > 200 || String(input.takeaways || '').length > 2000) fail('目标描述过长。');
  return { pages, segments, events, durationSeconds: duration, targetSeconds: target,
    audience: String(input.audience || '一般听众'), takeaways: String(input.takeaways || ''),
    transcriptSource: ['asr', 'edited', 'manual'].includes(input.transcriptSource) ? input.transcriptSource : 'unknown' };
}

export function conciseIssueTitle(title) {
  // Strip leading location labels, never references inside the actual finding.
  const clean = title.trim().replace(/^第\s*[0-9一二三四五六七八九十百零〇两]+\s*页(?:\s*[·：:、，,—–\-]\s*|\s+|(?=封面))(?:封面(?:信息)?\s*[·：:、，,—–\-]?\s*)?/, '').replace(/^封面信息\s*[·：:、，,—–\-]\s*/, '');
  return clean || title.trim();
}

export function validateReport(raw, session, {requireSpeechEvidence = false} = {}) {
  if (!raw || !Array.isArray(raw.issues) || typeof raw.summary !== 'string') throw Object.assign(new Error('模型返回格式不正确，请重试。'), { status: 502 });
  const issues = [];
  let rejected = 0;
  for (const issue of raw.issues.slice(0, 6)) {
    const source = session.segments.find(s => s.id === issue.segmentId);
    if (!source || typeof issue.quote !== 'string' || issue.quote.trim().length < 4 || !source.text.includes(issue.quote.trim()) || typeof issue.title !== 'string' || typeof issue.why !== 'string' || typeof issue.suggestion !== 'string') { rejected++; continue; }
    issues.push({ title: conciseIssueTitle(issue.title).slice(0, 100), why: issue.why.slice(0, 1000), suggestion: issue.suggestion.slice(0, 1500),
      quote: issue.quote.trim(), segmentId: source.id, page: source.page, start: source.start, end: source.end,
      action: ['clarify', 'revise', 'rehearse'].includes(issue.action) ? issue.action : 'clarify', question: String(issue.question || '').slice(0, 500) });
  }
  if (rejected && !issues.length) throw Object.assign(new Error('模型给出的证据无法在原文中核对，本次诊断未展示。请重试或检查转写。'), { status: 502 });
  const evidenceFor = item => {
    const source=session.segments.find(s=>s.id===item?.segmentId);
    return source && typeof item.quote==='string' && item.quote.trim().length>=(item.origin==='practice_template'&&!requireSpeechEvidence?1:4) && source.text.includes(item.quote.trim());
  };
  const strengthEvidence=(Array.isArray(raw.strengths)?raw.strengths:[]).filter(item=>item && typeof item==='object' && typeof item.text==='string' && item.text.trim() && evidenceFor(item)).slice(0,2).map(item=>({text:item.text.trim().slice(0,160),segmentId:item.segmentId,quote:item.quote.trim().slice(0,1000)}));
  const practiceSuggestions=(Array.isArray(raw.practiceSuggestions)?raw.practiceSuggestions:[]).filter(item=>typeof item?.title==='string' && item.title.trim() && typeof item.action==='string' && item.action.trim() && evidenceFor(item)).slice(0,3).map(item=>({title:item.title.trim().slice(0,80),action:item.action.trim().slice(0,500),segmentId:item.segmentId,quote:item.quote.trim().slice(0,1000),origin:item.origin==='practice_template'&&!requireSpeechEvidence?'practice_template':'model'}));
  return { summary: rejected ? '部分建议的引用未通过核对，以下仅展示有原文依据的建议。' : raw.summary.slice(0, 1200), issues, rejected,
    strengths: rejected ? [] : requireSpeechEvidence || strengthEvidence.length ? strengthEvidence.map(s=>s.text) : (Array.isArray(raw.strengths)?raw.strengths:[]).filter(s=>typeof s==='string'&&s.trim()).slice(0,2).map(s=>s.trim().slice(0,160)),
    strengthEvidence: rejected ? [] : strengthEvidence, practiceSuggestions,
    nextStep: !rejected && typeof raw.nextStep === 'string' && raw.nextStep.trim() ? raw.nextStep.trim().slice(0, 240) : issues[0]?.suggestion || '保留当前表达，结合听众反馈再决定是否调整。',
    materialCoverage: materialCoverage(session.pages),
    limits: [materialCoverage(session.pages).note, '引用可核对不等于判断正确；请结合汇报目标确认。', ...(rejected ? [`已过滤 ${rejected} 条引用不匹配的建议。`] : [])].filter(Boolean) };
}
