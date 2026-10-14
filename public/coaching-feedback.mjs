import { speechUnits } from './comparison-core.mjs';

// This is a coverage cue, not a score of presentation quality. A short answer
// can be excellent; it still cannot establish the quality of a whole talk.
export function speechSufficiency(session) {
  const units = speechUnits((session.segments||[]).map(s => s.text).join(' '));
  const brief = units < 120 || (session.durationSeconds > 0 && session.durationSeconds < 30 && units < 220);
  return { scope: brief ? 'brief' : 'provided_speech', units,
    unassignedPages: (session.segments||[]).some(s => s.page === 0) };
}

export function completeCoachingReport(report, session) {
  const inputCoverage = speechSufficiency(session);
  let summary = report.summary;
  if (!report.issues.length) summary = inputCoverage.scope === 'brief'
    ? '这次发言较短，还不足以判断整场汇报。以下练习只针对已讲的片段。'
    : '本次没有形成有充分依据的修改建议。可以通过下面的练习继续检验表达效果。';
  else if (inputCoverage.scope === 'brief' && !summary.startsWith('以下只针对这次短片段：')) summary = `以下只针对这次短片段：${summary}`;
  const practiceSuggestions = [...(report.practiceSuggestions || [])];
  const source = session.segments.find(s => s.text.trim().length >= 4) || session.segments[0];
  const anchor = { segmentId: source.id, quote: source.text.trim().slice(0, 100), origin: 'practice_template' };
  const overtime = session.durationSeconds > session.targetSeconds;
  // Audited, individualized exercises take priority. A clearly labelled
  // practice template supplies a useful next action when the model finds none.
  if (!practiceSuggestions.length && report.issues.length < 2) {
    practiceSuggestions.push({ ...anchor, title: '先讲清一个重点', action: overtime
      ? '从这段话里选出最希望听众记住的一点，用一句话重讲，再删去不服务于这个重点的展开。'
      : '从这段话里选出最希望听众记住的一点，先用一句话讲清，再用一个真实理由或例子说明；没有依据的部分直接说明还不确定。' });
    practiceSuggestions.push({ ...anchor, title: inputCoverage.scope === 'brief' ? '完成一段，再检验理解' : '让听众复述一次', action: inputCoverage.scope === 'brief'
      ? '按“我想讲什么 → 为什么 → 希望听众记住什么”试讲 30–60 秒，再次录音分析。这里是练习方向，不代表你已经存在这些问题。'
      : '把这一段讲给一位朋友，请对方用一句话复述重点。比较与自己的目标是否一致，再决定哪里需要改。' });
  }
  if (practiceSuggestions.length === 1 && report.issues.length < 2) practiceSuggestions.push({ ...anchor, title: '回听后做一次自查', action: '再讲一次这一段，回听时只检查一件事：不看 PPT，能否用一句话说出自己刚才的重点。把不清楚的位置记下来，再决定是否调整。' });
  return { ...report, summary, inputCoverage, practiceSuggestions,
    nextStep: report.issues.length ? report.nextStep : practiceSuggestions[0]?.action || report.nextStep };
}
