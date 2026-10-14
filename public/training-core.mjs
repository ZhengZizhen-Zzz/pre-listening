import { validateSession, validateReport, pageDurations } from './core.mjs';
import { validateRevisionInput, initialClarification } from './revision-core.mjs';

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 10;
export const questionKey = q => q.question.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
// Count readable content, not blank/image pages or repeated headers.
export function questionCountFor(session) {
  const sections = session.pages.map(p => [p.text, ...session.segments.filter(s => s.page === p.number).map(s => s.text)].join('\n').trim());
  const unique = [...new Set(sections.filter(t => t.replace(/\s/g, '').length >= 40))];
  const characters = unique.reduce((n,t) => n + t.replace(/\s/g, '').length, 0);
  return Math.min(MAX_QUESTIONS, MIN_QUESTIONS + Math.floor(Math.max(0, unique.length - 1) / 4) + Math.floor(characters / 2400));
}
export const TRAINING_CHECKS = {
  answer: { directness: '有没有回答问题', support: '依据是否充分', clarity: '表达是否清楚' },
  drill: { goal: '这次重点有没有改善', meaning: '关键意思是否保留', clarity: '表达是否清楚' }
};
export const ASSESSMENTS = ['met', 'partly', 'not_yet', 'uncertain'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function text(value, limit, label, status = 400) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(`${label}为空或过长。`, status);
  return value.trim();
}
const readableFeedback = value => value.replace(/\b(not_yet|uncertain|partly|met)\b/g, word => ({met:'已做到',partly:'还可完善',not_yet:'还没做到',uncertain:'需要确认'}[word]));
export function validateRubric(raw, status = 400) {
  if (!raw || !Array.isArray(raw.criteria) || raw.criteria.length < 2 || raw.criteria.length > 3) fail('每题需要2至3个具体评价要点。', status);
  const seen = new Set();
  const criteria = raw.criteria.map((c, i) => {
    const label = text(c?.label, 80, '评价要点', status);
    const key = questionKey({question:label});
    if (seen.has(key)) fail('评价要点不能重复。', status);
    seen.add(key);
    // Stable IDs are assigned here, never accepted from model-controlled input.
    return {id:`point_${i + 1}`, label, description:text(c.description, 400, '评价说明', status)};
  });
  return {purpose:text(raw.purpose, 300, '提问目的', status), criteria};
}
export function feedbackCriteria(kind, question) {
  return kind === 'answer' && question?.rubric ? question.rubric.criteria
    : Object.entries(TRAINING_CHECKS[kind] || {}).map(([id,label]) => ({id,label}));
}
export function validateQuestion(raw, session, status = 400) {
  const question = text(raw?.question, 500, '问题', status);
  const e = raw?.evidence;
  const source = e?.source === 'speech' ? session.segments.find(s => s.id === e.segmentId)
    : e?.source === 'slide' ? session.pages.find(p => p.number === e.page) : null;
  const quote = text(e?.quote, 1000, '提问依据', status);
  if (quote.length < 4 || !source?.text.includes(quote)) fail('提问依据无法在原文中核对，请重试。', status);
  const page = e.source === 'speech' ? source.page : source.number;
  const result = { question, page, evidence: { source: e.source, quote, ...(e.source === 'speech' ? {segmentId: source.id} : {page}) } };
  if (raw.rubric !== undefined) result.rubric = validateRubric(raw.rubric, status);
  if (raw.previousAnswer) {
    const answer = text(raw.previousAnswer.answer, 6000, '上一条回答', status);
    const answerQuote = text(raw.previousAnswer.quote, 1000, '追问依据', status);
    if (answerQuote.length < 4 || !answer.includes(answerQuote)) fail('追问依据无法在回答中核对。', status);
    result.previousAnswer = { answer, quote: answerQuote, question: text(raw.previousAnswer.question, 500, '上一题', status) };
  }
  return result;
}
export function validateTrainingInput(kind, input) {
  if (!['questions', 'answer', 'drill', 'rewrite'].includes(kind)) fail('练习类型不正确。');
  const session = validateSession(input?.session);
  if (kind === 'questions') {
    const count = input.count ?? questionCountFor(session);
    if (!Number.isInteger(count) || count < MIN_QUESTIONS || count > MAX_QUESTIONS) fail('每组请选择3至10题。');
    return { session, count };
  }
  const answer = text(input?.answer, 6000, '本次发言');
  const durationSeconds = input.durationSeconds ?? null;
  if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300.5)) fail('单次练习最长5分钟。');
  if (kind === 'answer' || kind === 'rewrite') {
    const request = { session, answer, durationSeconds, question:validateQuestion(input.question, session) };
    if (kind === 'answer' && input.previousAttempt != null) {
      const previousAnswer = text(input.previousAttempt.answer, 6000, '上次回答');
      if (previousAnswer.length < 4) fail('上次回答太短，无法对照。');
      const feedback = validateTrainingFeedback(input.previousAttempt.feedback,{session,answer:previousAnswer,question:request.question},'answer');
      request.previousAttempt = {answer:previousAnswer,feedback};
    }
    if (kind === 'rewrite') {
      request.feedback = validateTrainingFeedback(input.feedback, request, 'answer');
      const answers = input.answers ?? [];
      if (!Array.isArray(answers) || answers.length > 2) fail('一次修改最多补充两个问题。');
      request.answers = answers.map(a => ({question:text(a?.question,500,'补充问题'), answer:text(a?.answer,2000,'补充回答')}));
    }
    return request;
  }
  const revision = validateRevisionInput(input, validateSession, validateReport);
  if (initialClarification(revision)) fail('请先在这条建议中确认事实，再针对它重练。');
  return { session, answer, durationSeconds, issue: revision.issue, answers: revision.answers };
}
export function validateQuestions(raw, session, count = MIN_QUESTIONS, requireRubric = false) {
  if (!Array.isArray(raw?.questions)) fail('未生成有效的问题，请重试。', 502);
  const questions = [], seen = new Set();
  for (const item of raw.questions.slice(0, MAX_QUESTIONS * 2)) {
    try {
      // Initial questions cannot carry a fabricated earlier answer.
      if (requireRubric && !item.rubric) continue;
      const q = validateQuestion({question:item.question, evidence:item.evidence, rubric:item.rubric}, session, 502);
      if (!seen.has(questionKey(q))) { questions.push(q); seen.add(questionKey(q)); }
    } catch { /* Never expose a question supported by a fabricated quotation. */ }
  }
  if (questions.length < count) fail(`暂未准备好${count}道有原文依据的不同问题，请重试。`, 502);
  return { questions: questions.slice(0, count) };
}
export function validateTrainingFeedback(raw, request, kind) {
  const criteria = feedbackCriteria(kind, request.question), labels = Object.fromEntries(criteria.map(c => [c.id,c.label]));
  if (!criteria.length || !Array.isArray(raw?.checks) || raw.checks.length !== criteria.length) fail('反馈不完整，请重试。', 502);
  const seen = new Set();
  const checks = raw.checks.map(c => {
    if (!labels[c?.id] || seen.has(c.id) || !ASSESSMENTS.includes(c.assessment)) fail('反馈项目不正确，请重试。', 502);
    seen.add(c.id);
    const quote = text(c.quote, 1000, '反馈依据', 502);
    if (quote.length < 4 || !request.answer.includes(quote)) fail('反馈引用未通过核对，请检查发言后重试。', 502);
    return { id:c.id, label:labels[c.id], assessment:c.assessment, quote, reason:readableFeedback(text(c.reason, 600, '反馈说明', 502)) };
  });
  checks.sort((a,b) => criteria.findIndex(c=>c.id===a.id) - criteria.findIndex(c=>c.id===b.id));
  const result = { checks, summary:readableFeedback(text(raw.summary, 500, '反馈小结', 502)), nextStep:readableFeedback(text(raw.nextStep, 600, '下一步建议', 502)) };
  if (kind === 'answer' && request.previousAttempt) result.comparison = validateAnswerComparison(raw.comparison, request, checks);
  if (kind === 'answer' && !request.question.previousAnswer && raw.followup?.question && raw.followup?.quote) {
    try {
      if (request.question.rubric && !raw.followup.rubric) fail('追问缺少自己的评价要点。',502);
      result.followup = validateQuestion({ question:raw.followup.question, evidence:request.question.evidence,
        rubric:raw.followup.rubric,
        previousAnswer:{answer:request.answer,quote:raw.followup.quote,question:request.question.question} }, request.session, 502);
    } catch { /* An invalid optional follow-up must not hide otherwise usable feedback. */ }
  }
  return result;
}
export function validateAnswerComparison(raw, request, checks) {
  // Missing prose is recoverable without inventing a comparison: both sets of
  // assessments and quotations already exist in validated feedback. This uses
  // the current check's explanation, not a new model claim about the past.
  if (raw == null) raw = {checks:checks.map(after => ({id:after.id,
    beforeQuote:request.previousAttempt.feedback.checks.find(c=>c.id===after.id)?.quote,
    reason:after.reason}))};
  if (!Array.isArray(raw?.checks) || raw.checks.length !== checks.length) fail('前后对照不完整，请重试。',502);
  const seen = new Set(), rank = {not_yet:0, partly:1, met:2};
  const rows = raw.checks.map(c => {
    const after = checks.find(item=>item.id===c?.id);
    const before = request.previousAttempt.feedback.checks.find(item=>item.id===c?.id);
    if (!after || !before || seen.has(c.id)) fail('前后对照的评价要点不一致。',502);
    seen.add(c.id);
    const beforeQuote = text(c.beforeQuote,1000,'上次回答依据',502);
    if (beforeQuote.length < 4 || !request.previousAttempt.answer.includes(beforeQuote)) fail('上次回答引用未通过核对。',502);
    // Preserve the earlier feedback the user actually saw. Re-grading the old
    // answer can manufacture progress by silently lowering the old assessment.
    const delta = rank[after.assessment] - rank[before.assessment];
    return {id:c.id,label:after.label,beforeAssessment:before.assessment,afterAssessment:after.assessment,
      beforeQuote,afterQuote:after.quote,reason:readableFeedback(text(c.reason,600,'对照说明',502)),
      change:Number.isNaN(delta)?'uncertain':delta>0?'improved':delta<0?'regressed':'steady'};
  });
  return {checks:checks.map(c=>rows.find(r=>r.id===c.id))};
}
export function previousAnsweredAttempt(turn, index) {
  return turn.attempts.slice(0,index).findLast(a=>a.feedback && a.text?.trim().length >= 4) || null;
}
export function drillBaseline(session, issue) {
  const seconds = pageDurations(session.events, session.durationSeconds, session.pages.length)[issue.page - 1];
  return { page:issue.page, text:session.segments.filter(s => s.page === issue.page).map(s => s.text).join('\n'), seconds:seconds > 0 ? seconds : null };
}
export function newAttempt() { return {id:crypto.randomUUID(),text:'',durationSeconds:null,createdAt:new Date().toISOString()}; }
export function newTrainingRun(parentId, kind, session, extra = {}) {
  return structuredClone({id:crypto.randomUUID(),parentId,kind,session,...extra,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),turns:kind === 'drill' ? [{attempts:[newAttempt()]}] : []});
}
export function appendTrainingQuestion(run, question) {
  if (run.kind !== 'answer' || run.turns.length >= MAX_QUESTIONS) fail('每组最多10题，可以回看或重新开始一组。');
  if (run.turns.some(t => questionKey(t.question) === questionKey(question))) fail('这道题已经在本组中。');
  return {...run,turns:[...run.turns,{question:validateQuestion(question,run.session),attempts:[newAttempt()]}]};
}
export function prepareQuestionTurns(run) {
  if (run.kind !== 'answer') return run;
  for (const q of run.questions || []) {
    if (run.turns.length >= MAX_QUESTIONS) break;
    if (!run.turns.some(t => questionKey(t.question) === questionKey(q))) run = appendTrainingQuestion(run, q);
  }
  return run;
}
export function trainingProgress(run) {
  const done = t => t.attempts.some(a => Boolean(a.feedback));
  return { total:run.turns.length, completed:run.turns.filter(done).length, next:run.turns.findIndex(t => !done(t)), complete:run.turns.length > 0 && run.turns.every(done) };
}
