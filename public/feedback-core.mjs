import { validateSession } from './core.mjs';

export const FEEDBACK_CONSENT = 'feedback-2026-10-11.1';
export const FEEDBACK_MAX_BYTES = 2 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), {status:400}); };
const text = (value, max = 2000) => {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) fail('反馈文字过长或格式不正确。');
  return value.trim();
};
const list = (value, max) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) fail('记录过多，请取消附带练习记录后重试。');
  return value;
};
const choice = (value, options) => options.includes(value) ? value : '';
const seconds = value => Number.isFinite(value) && value >= 0 && value <= 1200 ? value : null;
const strings = (value, max, length) => list(value,max).map(v => text(v,length));
const checks = value => list(value,10).map(c => ({label:text(c.label,200),assessment:text(c.assessment,50),quote:text(c.quote,12000),reason:text(c.reason,3000)}));

// Keep submitted criticism verbatim, including a model's incorrect quote. This
// inbox collects failures; re-validating model evidence here would erase them.
export function normalizeFeedback(input) {
  try { return normalize(input); }
  catch (error) { if(error.status)throw error;fail('反馈格式不正确，请重新打开提交窗口。'); }
}
function normalize(input) {
  if (!input || input.consent !== true || input.consentVersion !== FEEDBACK_CONSENT) fail('反馈提交确认无效，请重新打开表单。');
  const clientId = text(input.clientId,100);
  if (!/^[\w-]{1,100}$/.test(clientId)) fail('反馈记录编号不正确，请重新打开提交窗口。');
  const result = {clientId,consent:true,consentVersion:FEEDBACK_CONSENT,nickname:text(input.nickname,60),
    helpful:choice(input.helpful,['yes','partly','no','unsure']),comment:text(input.comment,4000),record:null,training:[]};
  if (input.record) {
    const r = input.record;
    if (r.demo) fail('示例不作为真实试用反馈，请使用自己的演练。');
    const session = validateSession({pages:r.pages,segments:r.segments,events:r.events,durationSeconds:r.durationSeconds,
      targetSeconds:Number(r.goals?.targetMinutes)*60,audience:r.goals?.audience,takeaways:r.goals?.takeaways});
    const raw = r.report;
    if (!raw || !Array.isArray(raw.issues)) fail('请先完成一次复盘，或只提交使用感受。');
    const issues = list(raw.issues,20).map((i,index) => {
      const f = r.feedback?.[index] || {}, flow = r.rewrites?.[index] || {};
      return {title:text(i.title,200),page:Number.isInteger(i.page)&&i.page>0&&i.page<=session.pages.length?i.page:null,
        segmentId:text(i.segmentId,100),quote:text(i.quote,12000),why:text(i.why,3000),suggestion:text(i.suggestion,4000),question:text(i.question,1000),
        feedback:{judgment:choice(f.judgment,['correct','partial','incorrect','unsure']),adoption:choice(f.adoption,['yes','no','later']),reason:text(f.reason,2000)},
        rewrite:{status:choice(flow.result?.status,['draft','needs_input','no_change']),revisedText:text(flow.result?.revisedText,12000),reason:text(flow.result?.reason,3000),
          question:text(flow.result?.question,1000),acceptedAt:text(flow.acceptedAt,100),answers:list(flow.answers,10).map(a=>({question:text(a.question,1000),answer:text(a.answer,3000)}))}};
    });
    result.record = {title:text(r.title,300),...session,report:{summary:text(raw.summary,3000),strengths:strings(raw.strengths,10,1000),nextStep:text(raw.nextStep,3000),
      practiceSuggestions:list(raw.practiceSuggestions,3).map(p=>({title:text(p.title,100),action:text(p.action,1000),segmentId:text(p.segmentId,100),quote:text(p.quote,12000),origin:choice(p.origin,['model','practice_template'])})),
      source:text(raw.source,100),model:text(raw.model,100),promptVersion:text(raw.promptVersion,100),generatedAt:text(raw.generatedAt,100),issues,
      timePlan:raw.timePlan?{note:text(raw.timePlan.note,2000),excessSeconds:seconds(raw.timePlan.excessSeconds),items:list(raw.timePlan.items,40).map(i=>({page:i.page,currentSeconds:seconds(i.currentSeconds),targetSeconds:seconds(i.targetSeconds),action:text(i.action,3000),keepQuote:text(i.keepQuote,12000),cutQuote:text(i.cutQuote,12000)}))}:null},
      scripts:Object.entries(r.scripts||{}).slice(0,1200).map(([id,s])=>({segmentId:text(id,100),text:text(s.text,12000)}))};
    result.training = list(input.training,30).map(run=>({kind:choice(run.kind,['answer','drill']),createdAt:text(run.createdAt,100),
      turns:list(run.turns,10).map(t=>({question:text(t.question?.question || run.issue?.suggestion,3000),page:t.question?.page||run.issue?.page||null,
        purpose:text(t.question?.rubric?.purpose,2000),evidence:text(t.question?.evidence?.quote,12000),
        criteria:list(t.question?.rubric?.criteria,10).map(c=>({label:text(c.label,200),description:text(c.description,1000)})),
        attempts:list(t.attempts,30).map(a=>({text:text(a.text,12000),source:choice(a.source,['draft','asr','manual','edited']),durationSeconds:seconds(a.durationSeconds),
          feedback:a.feedback?{summary:text(a.feedback.summary,3000),checks:checks(a.feedback.checks),nextStep:text(a.feedback.nextStep,3000),
            comparison:a.feedback.comparison?{summary:text(a.feedback.comparison.summary,3000),checks:list(a.feedback.comparison.checks,10).map(c=>({label:text(c.label,200),beforeQuote:text(c.beforeQuote,12000),afterQuote:text(c.afterQuote,12000),reason:text(c.reason,3000),change:text(c.change,100)}))}:null}:null,
          revision:a.revision?{status:text(a.revision.result?.status,100),revisedText:text(a.revision.result?.revisedText,12000),reason:text(a.revision.result?.reason,3000),question:text(a.revision.result?.question,2000),answers:list(a.revision.answers,10).map(a=>({question:text(a.question,2000),answer:text(a.answer,6000)}))}:null}))}))}));
  }
  if (!result.record && !result.comment) fail('请写下遇到的问题或使用感受。');
  return result;
}
