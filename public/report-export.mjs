import { pageDurations, formatTime, pageLabel, hasPageTimeline } from './core.mjs';

export function readableReport(record) {
  const report = record.report;
  if (!report) throw new Error('请先完成一次演练分析。');
  const judgment = { correct: '判断正确', partial: '部分正确', incorrect: '判断不对', unsure: '暂不确定' };
  const adoption = { yes: '愿意采用', no: '不采用', later: '还要考虑' };
  const lines = ['Pre聆听大师 · 演练复盘', `材料：${record.title}`, `汇报对象：${record.goals.audience || '未填写'}`, `目标时长：${record.goals.targetMinutes} 分钟`,
    `报告来源：${record.demo ? '预设示例，非真实分析' : report.source === 'imported' ? '导入的历史报告' : 'AI 诊断，请结合实际情况核对'}`, '', '整体判断', report.summary || ''];
  if (report.strengths?.length) lines.push('', '值得保留', ...report.strengths.map(s => `• ${s}`));
  if(report.timePlan?.items?.length){
    lines.push('',`超时压缩计划：本次需压缩约 ${report.timePlan.excessSeconds} 秒`,report.timePlan.note);
    for(const item of report.timePlan.items)lines.push(`第${item.page}页：本次${formatTime(item.currentSeconds)} → 试讲目标${formatTime(item.targetSeconds)}`,`保留：${item.keepQuote}`,`合并或缩短：${item.cutQuote}`,`具体动作：${item.action}`);
    if(report.timePlan.remainingSeconds)lines.push(`当前计划仍差约${report.timePlan.remainingSeconds}秒，需继续取舍或调整目标。`);
  }
  if (Number.isFinite(record.durationSeconds)) {
    lines.push('', `本次用时：${formatTime(record.durationSeconds)}`, record.recordingStatus === 'interrupted' ? '中断前的暂存时长，可能缺失末尾' : hasPageTimeline(record.events||[],record.pages.length)&&!record.segments.some(s=>s.page===0)?'每页用时（包含停顿与回翻）':'缺少可靠翻页记录，暂不计算每页用时');
    if(hasPageTimeline(record.events||[],record.pages.length)&&!record.segments.some(s=>s.page===0))pageDurations(record.events,record.durationSeconds,record.pages.length).forEach((duration,index)=>lines.push(`第${index+1}页：${formatTime(duration)}`));
  }
  lines.push('', '建议与我的判断');
  if (!report.issues.length) lines.push('本次没有给出需要修改的建议。');
  report.issues.forEach((issue, i) => {
    const feedback = record.feedback?.[i] || {}, flow = record.rewrites?.[i];
    lines.push('', `${i + 1}. ${issue.title}（${pageLabel(issue.page)}）`, `原话：${issue.quote}`, `原因：${issue.why}`, `建议：${issue.suggestion}`);
    if (issue.question) lines.push(`待确认：${issue.question}`);
    for (const answer of flow?.answers || []) lines.push(`确认问题：${answer.question}`, `我的回答：${answer.answer}`);
    lines.push(`我的判断：${judgment[feedback.judgment] || '未填写'}`, `采纳意愿：${adoption[feedback.adoption] || '未填写'}`);
    if (feedback.reason) lines.push(`理由：${feedback.reason}`);
  });
  if(report.practiceSuggestions?.length){
    lines.push('', '接下来可以这样练（练习方向，不等于已确认的问题）');
    for(const item of report.practiceSuggestions)lines.push(`• ${item.title}`,`从这句开始：${item.quote}`,item.action);
  }
  lines.push('', '下一步', report.nextStep || '选择认可的建议，确认后修改讲稿并再次演练。');
  const scripts = Object.entries(record.scripts || {});
  if (scripts.length) {
    lines.push('', '已采用的下次讲稿');
    for (const [id, script] of scripts) {
      const segment = record.segments.find(s => s.id === id);
      lines.push('', pageLabel(segment?.page), `原发言：${segment?.text || ''}`, `修改后：${script.text}`);
    }
  }
  lines.push('', '本文件供阅读和分享。如需恢复到工具中，请使用“历史记录 → 备份与恢复”中的 JSON 文件。');
  return lines.join('\n');
}
