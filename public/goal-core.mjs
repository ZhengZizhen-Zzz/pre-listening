import {hasPageTimeline, pageDurations, validateReport} from './core.mjs';
import {validateTimePlan} from './coaching-core.mjs';

// Shared by the browser and server. Cached advice must still cite this recording.
export function goalTiming(session) {
  const reliable=Number.isFinite(session.durationSeconds)&&session.durationSeconds>0&&session.events?.[0]?.at===0&&hasPageTimeline(session.events,session.pages.length)&&!session.segments.some(s=>s.page===0);
  return {reliable,excessSeconds:reliable?Math.max(0,session.durationSeconds-session.targetSeconds):null};
}
export function protectedCandidate(item,session,protectedSpeech=[]){
  const source=session.segments.find(s=>s.id===item.segmentId);
  return protectedSpeech.some(p=>p.page===item.page && (source?.text.includes(p.quote)||p.quote.includes(item.quote)||item.quote.includes(p.quote)));
}
export function goalCandidates(report,session,protectedSpeech=[],scripts={},feedback={}) {
  if(!report)return [];
  let items=[];
  try{items=validateTimePlan(report.timePlan,session)?.items||[];}catch{}
  const durations=pageDurations(session.events,session.durationSeconds,session.pages.length);
  const candidates=items.flatMap(item=>{
    const s=session.segments.find(s=>s.page===item.page&&s.text.includes(item.cutQuote));
    if(!s)return [];
    const issue={title:`先精简第 ${item.page} 页`,page:item.page,segmentId:s.id,quote:item.cutQuote,
      why:'已有复盘中的压缩建议；是否保留这段内容由你决定。',suggestion:item.action,action:'revise'};
    const index=report.issues?.findIndex(i=>i.segmentId===s.id&&(i.quote===item.cutQuote||s.text.includes(i.quote)));
    if(index>=0&&(feedback[index]?.judgment==='incorrect'||feedback[index]?.adoption==='no'))return [];
    return [{...issue,keepQuote:item.keepQuote,seconds:durations[item.page-1],reportIndex:index}];
  });
  // Diagnosis results selected by the goal agent may also contain relevant edits.
  if((report.source==='goal_plan'||report.goalScoped)&&!items.length){
    try{candidates.push(...validateReport(report,session).issues.filter(i=>{const index=report.issues.findIndex(raw=>raw.segmentId===i.segmentId&&raw.quote===i.quote);return i.action==='revise'&&feedback[index]?.judgment!=='incorrect'&&feedback[index]?.adoption!=='no';}));}catch{}
  }
  return candidates.filter(i=>!scripts[i.segmentId]&&!protectedCandidate(i,session,protectedSpeech))
    .sort((a,b)=>(b.seconds||0)-(a.seconds||0));
}
export function goalReport(results){
  return results?.diagnose?{...results.diagnose,goalScoped:true,...(results.compress?{timePlan:results.compress}:{})}:results?.editableReview|| (results?.compress?{summary:'',issues:[],timePlan:results.compress}:null);
}
export function nextGoalBaseline(record,current){
  if(record?.current?.roundId!==current.roundId&&record?.current?.complete)return structuredClone(record.current);
  return record?.baseline||null;
}
export function sameGoalMaterial(a,b){return JSON.stringify(a?.pages.map(p=>[p.number,p.text]))===JSON.stringify(b?.pages.map(p=>[p.number,p.text]));}
export function firstGoalConfirmation(current){
  return current.complete&&Boolean(current.audioId)&&goalTiming(current.session).reliable&&current.session.durationSeconds<=current.session.targetSeconds;
}
