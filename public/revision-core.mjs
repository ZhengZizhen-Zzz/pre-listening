import {numericFacts} from './numeric-facts.mjs';
export const REWRITE_STATES = ['needs_input', 'draft', 'no_change'];
const failure = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function validateRevisionInput(input, validateSession, validateReport) {
  const session = validateSession(input?.session);
  const issue = validateReport({ summary: '', issues: [input?.issue || {}] }, session).issues[0];
  if (!issue) failure('请选择一条能核对原文的建议。');
  if (input.judgment === 'incorrect' || input.adoption === 'no') failure('这条建议已被你否定或标记为不采用，不会据此改稿。');
  const answers = input.answers ?? [];
  if (!Array.isArray(answers) || answers.length > 2) failure('一次改稿最多确认两个问题。');
  for (const answer of answers) {
    if (typeof answer?.question !== 'string' || !answer.question.trim() || answer.question.length > 500 || typeof answer.answer !== 'string' || !answer.answer.trim() || answer.answer.length > 2000) failure('请提供有效的确认问题和回答。');
  }
  const instruction = input.instruction ?? '';
  if (typeof instruction !== 'string' || instruction.length > 1000) failure('修改要求请控制在1000字以内。');
  return { session, issue, answers: answers.map(a => ({ question: a.question.trim(), answer: a.answer.trim() })), instruction: instruction.trim() };
}

export function initialClarification(request) {
  if (!request.answers.length && request.issue.action === 'clarify') {
    return { status: 'needs_input', question: request.issue.question || '针对这条建议，哪些事实或表达意图需要先确认？如果你不认可建议，也可以直接说明。', reason: '先确认你的实际情况，再修改讲稿。' };
  }
  return null;
}

export function validateRevisionResult(raw, request) {
  if (!raw || !REWRITE_STATES.includes(raw.status)) failure('改稿结果格式不正确，请重试。', 502);
  const short = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const reason = short(raw.reason, 500);
  if (raw.status === 'needs_input') {
    const question = short(raw.question, 500);
    if (!question) failure('改稿需要确认信息，但没有返回具体问题。', 502);
    if (request.answers.length >= 2) return { status: 'no_change', reason: '现有信息仍不足以可靠修改，已保留原发言。可以补全事实后再试。' };
    return { status: raw.status, question, reason };
  }
  if (raw.status === 'no_change') return { status: raw.status, reason: reason || '当前表达可以保留，无需修改。' };
  const revisedText = typeof raw.revisedText === 'string' ? raw.revisedText.trim() : '';
  if (!revisedText || revisedText.length > 12000 || !reason) failure('修改稿为空、过长或缺少修改说明，请重试。', 502);
  const originalText = request.session.segments.find(s => s.id === request.issue.segmentId).text;
  if (originalText === revisedText) return { status: 'no_change', reason: '修改稿与原文相同，已保留原有表达。' };
  // A small factual guard, not a claim to fully validate semantics. Slide values
  // are intentionally not authoritative when speech and slides disagree.
  const facts = request.session.segments.map(s => s.text).join('\n') + '\n' + request.answers.map(a => a.answer).join('\n');
  const known = new Set(numericFacts(facts));
  if (numericFacts(revisedText).some(number => !known.has(number))) {
    if (request.answers.length >= 2) return { status: 'no_change', reason: '草稿中出现了尚未确认的数字，已停止修改并保留原文。' };
    return { status: 'needs_input', question: '这段需要使用具体数字吗？请提供已经确认的数据；没有的话可回答“保留原有事实，不添加数字”。', reason: '草稿中出现了原发言和你的补充中没有的数字，尚未展示或采用。' };
  }
  return { status: 'draft', originalText, revisedText, reason,
    checks: ['请核对事实和专业词；此稿尚未采用。'], segmentId: request.issue.segmentId };
}

export function acceptDraft(scripts, draft, sourceText, issueTitle, now = new Date().toISOString()) {
  if (draft?.status !== 'draft' || draft.originalText !== sourceText) failure('原发言已变化，请重新生成修改稿。');
  if (!/^s\d+$/.test(draft.segmentId) || typeof draft.revisedText !== 'string' || !draft.revisedText.trim() || draft.revisedText.length > 12000) failure('修改稿不能为空或超过12000字。');
  const next = structuredClone(scripts || {});
  const previous = next[draft.segmentId];
  next[draft.segmentId] = { text: draft.revisedText, sourceText, issueTitle, acceptedAt: now,
    versions: [...(previous?.versions || []), { text: draft.revisedText, reason: draft.reason, acceptedAt: now }] };
  return next;
}
