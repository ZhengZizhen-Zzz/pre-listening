import { validateRevisionResult } from './revision-core.mjs';

// Reuse the existing confirmation limit and numeric-fact guard, but only the
// user's answer and explicit confirmations may supply facts for this rewrite.
// Slide text, inferred ideal answers and model feedback are not fact authority.
export function validateAnswerRevisionResult(raw, request) {
  const result = validateRevisionResult(raw, {
    session:{segments:[{id:'s1',text:request.answer}]},
    issue:{segmentId:'s1'}, answers:request.answers
  });
  if (result.status !== 'draft') return result;
  if (result.revisedText.length > 6000) throw Object.assign(new Error('修改后的回答太长，请重试。'),{status:502});
  return {status:'draft',originalText:result.originalText,revisedText:result.revisedText,reason:result.reason};
}

export function practiceFromDraft(attempt, draft, makeAttempt) {
  if (draft?.status !== 'draft' || draft.originalText !== attempt.text || !draft.revisedText?.trim() || draft.revisedText.length > 6000) {
    throw new Error('原回答已变化，请重新整理这段回答。');
  }
  return {...makeAttempt(),text:draft.revisedText,source:'draft',basedOnAttemptId:attempt.id};
}
