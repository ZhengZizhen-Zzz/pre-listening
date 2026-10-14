import { pageDurations, hasPageTimeline } from './core.mjs';
import { groupTranscript } from './transcript-core.mjs';

export function speechUnits(text) {
  return (String(text).match(/\p{Script=Han}|[\p{Script=Latin}\p{N}]+/gu) || []).length;
}
export function speechMetrics(record) {
  const original = record.originalSegments?.length ? record.originalSegments : record.segments || [];
  const eligible = original.length > 0 && original.every(s => s.source === 'asr' && Number.isFinite(s.start) && Number.isFinite(s.end));
  const timed = Number.isFinite(record.durationSeconds) && record.durationSeconds > 0;
  const units = eligible ? speechUnits(original.map(s => s.text).join(' ')) : null;
  return { estimatedRate: eligible && timed && record.recordingStatus === 'complete' ? Math.round(units / (record.durationSeconds / 60)) : null,
    units, durationSeconds: timed ? record.durationSeconds : null };
}

export function nextRoundBaseline(record) {
  return record.durationSeconds > 0 || record.segments?.some(s => s.text.trim()) ? record.id : record.previousRoundId || null;
}

const normalize = text => String(text || '').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
export function compareRounds(previous, current) {
  const unavailable = reason => ({ available: false, reason });
  if (!previous || current.previousRoundId !== previous.id) return unavailable('还没有可关联的上一轮，请从练习讲稿进入下一轮演练。');
  if (previous.demo || current.demo) return unavailable('示例记录不参与真实演练比较。');
  if ((previous.roundId || previous.id) === (current.roundId || current.id) || previous.audioAssetId && previous.audioAssetId === current.audioAssetId) return unavailable('这是同一轮的文字修订，不是两次独立演练。');
  const material = r => JSON.stringify(r.pages.map(p => [p.number, p.text]));
  if (material(previous) !== material(current) || previous.pdfAssetId && current.pdfAssetId && previous.pdfAssetId !== current.pdfAssetId) return unavailable('两次使用的材料不同，暂不按同一页自动比较。');
  const completeTiming = r => !r.segments?.some(s=>s.page===0) && hasPageTimeline(r.events||[],r.pages.length) && r.recordingStatus === 'complete' && r.durationSeconds > 0 && r.events?.length > 0 && r.events[0].at === 0 && r.events.every((e, i) => Number.isFinite(e.at) && e.at >= 0 && e.at <= r.durationSeconds && e.page >= 1 && e.page <= r.pages.length && (!i || e.at >= r.events[i - 1].at));
  const timingAvailable = completeTiming(previous) && completeTiming(current);
  const before = timingAvailable ? pageDurations(previous.events, previous.durationSeconds, previous.pages.length) : null;
  const after = timingAvailable ? pageDurations(current.events, current.durationSeconds, current.pages.length) : null;
  const priorGroups = groupTranscript(previous.segments || [], previous.pages), currentGroups = groupTranscript(current.segments || [], current.pages);
  const goalKey = r => [r.goals?.audience || '', r.goals?.takeaways || '', Number(r.goals?.targetMinutes)];
  const goalsChanged = JSON.stringify(goalKey(previous)) !== JSON.stringify(goalKey(current));
  return { available: true, previousId: previous.id, goalsChanged, timingAvailable,
    previousMetrics: speechMetrics(previous), currentMetrics: speechMetrics(current),
    totalDelta: timingAvailable ? current.durationSeconds - previous.durationSeconds : null,
    pages: [...(priorGroups.some(g=>g.page===0)||currentGroups.some(g=>g.page===0)?[{number:0}]:[]),...current.pages].map(page => ({ page: page.number, beforeSeconds: before?.[page.number-1] ?? null, afterSeconds: after?.[page.number-1] ?? null,
      previousText: priorGroups.find(g=>g.page===page.number)?.text||'', currentText: currentGroups.find(g=>g.page===page.number)?.text||'' })),
    issues: (previous.report?.issues || []).flatMap((issue, index) => {
      const feedback = previous.feedback?.[index] || {};
      if (feedback.judgment === 'incorrect' || feedback.adoption === 'no') return [];
      const currentText = currentGroups.find(g => g.page === issue.page)?.text || '';
      return [{ key: `${previous.id}:${index}`, title: issue.title, page: issue.page, quote: issue.quote, currentText,
        confirmed: feedback.judgment === 'correct' || feedback.adoption === 'yes' || Boolean(previous.rewrites?.[index]?.acceptedAt),
        quoteRepeated: Boolean(normalize(issue.quote)) && normalize(currentText).includes(normalize(issue.quote)) }];
    }) };
}
