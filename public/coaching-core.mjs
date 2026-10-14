import { pageDurations, hasPageTimeline } from './core.mjs';

// Only user-specified goals establish a recruitment context; mentioning skills
// or projects in a speech is not enough to infer one.
export function hasJobContext(session) {
  const goals = `${session.audience || ''} ${session.takeaways || ''}`;
  if (/(?:不是|并非|不涉及|不以|非).{0,6}(?:求职|应聘|招聘|岗位|竞聘|面试)/.test(goals)) return false;
  return /求职|应聘|招聘|竞聘|面试官|岗位匹配|目标岗位/.test(goals);
}
export function contextualAdvice(text, session) {
  if (hasJobContext(session) || typeof text !== 'string') return text;
  return text.replace(/与目标岗位最相关的/g, '最希望听众记住的')
    .replace(/(?:目标|应聘|竞聘)岗位(?:的)?(?:要求|需求)/g, '本次汇报的重点')
    .replace(/(?:目标|应聘|竞聘)岗位/g, '本次汇报主题')
    .replace(/岗位匹配度/g, '与汇报目标的关联').replace(/更贴切这个岗位/g, '更贴合本次汇报目标');
}
export function contextualReport(report, session) {
  if (!report) return report;
  const fix = item => Object.fromEntries(Object.entries(item).map(([key, value]) => [key,
    ['title','why','suggestion','question','summary','nextStep'].includes(key) ? contextualAdvice(value, session) : value]));
  return { ...fix(report), issues: report.issues.map(fix), practiceSuggestions:(report.practiceSuggestions||[]).map(item=>({...item,title:contextualAdvice(item.title,session),action:contextualAdvice(item.action,session)})) };
}
export function timeBudget(session) {
  if(session.segments?.some(s=>s.page===0)||!hasPageTimeline(session.events||[],session.pages?.length||0))return null;
  const duration = session.durationSeconds, target = session.targetSeconds;
  if (!Number.isFinite(duration) || !Number.isFinite(target) || duration <= target || !session.events?.length || session.events[0].at !== 0) return null;
  return { durationSeconds: duration, targetSeconds: target, excessSeconds: Math.max(1, Math.round(duration - target)),
    pages: pageDurations(session.events, duration, session.pages.length).map((seconds,i) => ({page:i+1,seconds,
      text: session.segments.filter(s => s.page === i+1).map(s => s.text).join('\n')})) };
}
export function validateTimePlan(raw, session) {
  const budget = timeBudget(session);
  if (!budget) return null;
  const fail = () => { throw Object.assign(new Error('压缩计划未能对应到原发言，暂未展示，请重试。'),{status:502}); };
  if (!Array.isArray(raw?.items) || !raw.items.length || raw.items.length > 4) fail();
  const seen = new Set();
  const items = raw.items.map(item => {
    const source = budget.pages.find(p => p.page === item.page);
    if (!source || seen.has(item.page) || source.seconds < 10 || !source.text.trim()) fail();
    seen.add(item.page);
    for (const key of ['keepQuote','cutQuote']) if (typeof item[key] !== 'string' || item[key].trim().length < 4 || item[key].length > 500 || !source.text.includes(item[key].trim())) fail();
    if (typeof item.action !== 'string' || !item.action.trim() || item.action.length > 500) fail();
    return {page:item.page,currentSeconds:Math.round(source.seconds),keepQuote:item.keepQuote.trim(),cutQuote:item.cutQuote.trim(),action:contextualAdvice(item.action.trim(),session),saveSeconds:0,
      capacity:Math.max(0,Math.min(Math.floor(source.seconds*.6),Math.round(source.seconds)-8))};
  });
  const capacity = items.reduce((n,item)=>n+item.capacity,0);
  const allocated = Math.min(budget.excessSeconds,capacity);
  if (!allocated) fail();
  // Allocate a practice budget, never claim predicted or achieved time savings.
  items.forEach(item => item.saveSeconds=Math.floor(allocated*item.capacity/capacity));
  let remaining=allocated-items.reduce((n,item)=>n+item.saveSeconds,0);
  while(remaining) for(const item of items) if(remaining && item.saveSeconds<item.capacity){item.saveSeconds++;remaining--;}
  return {status:'ready',excessSeconds:budget.excessSeconds,allocatedSeconds:allocated,remainingSeconds:budget.excessSeconds-allocated,
    items:items.map(({capacity,...item})=>({...item,targetSeconds:item.currentSeconds-item.saveSeconds})),
    note:'下列时长是下一轮试讲目标，不是预计节省时间；先核对删减是否符合你的重点，再通过重练验证。'};
}
