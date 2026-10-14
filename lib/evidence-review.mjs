const invalid=message=>{throw Object.assign(new Error(message),{status:502});};
function verifyEvidence(evidence,session){
  if(!evidence||typeof evidence.quote!=='string'||evidence.quote.trim().length<2)invalid('冲突复核缺少可核对的两处原文，本次结果未展示。');
  const quote=evidence.quote.trim();
  if(evidence.source==='slide'){
    const page=session.pages.find(p=>p.number===evidence.page);
    if(!page||!page.text.includes(quote))invalid('冲突复核引用未在幻灯片中找到，本次结果未展示。');
    return {source:'slide',page:page.number,quote};
  }
  if(evidence.source==='speech'){
    const segment=session.segments.find(s=>s.id===evidence.segmentId);
    if(!segment||!segment.text.includes(quote))invalid('冲突复核引用未在发言中找到，本次结果未展示。');
    return {source:'speech',segmentId:segment.id,page:segment.page,quote};
  }
  invalid('冲突复核引用来源无效。');
}
export function neutralConflict(issue,decision,session){
  if(!Array.isArray(decision.evidence)||decision.evidence.length!==2)invalid('冲突复核缺少两处原文，本次结果未展示。');
  const evidence=decision.evidence.map(e=>verifyEvidence(e,session));
  if(JSON.stringify(evidence[0])===JSON.stringify(evidence[1])||!evidence.some(e=>e.source==='speech'&&e.segmentId===issue.segmentId&&(e.quote.includes(issue.quote)||issue.quote.includes(e.quote))))invalid('冲突复核没有关联到本条发言，本次结果未展示。');
  const label=e=>e.source==='slide'?`第${e.page}页材料`:e.page?`第${e.page}页发言`:'发言（页码待确认）';
  const excerpt=e=>e.quote.length>150?e.quote.slice(0,150)+'…':e.quote;
  return {...issue,title:'两处表述需要确认',why:`${label(evidence[0])}：“${excerpt(evidence[0])}”；${label(evidence[1])}：“${excerpt(evidence[1])}”。两种说法的关系需要确认，听众目前难以判断采用哪种口径。`,suggestion:'请先说明两处表述各自对应的事实、范围或方向；确认后再决定是否修改材料或讲稿。',action:'clarify',question:'这两处表述分别指什么？哪种情况符合本次汇报，还是两者的范围不同？',conflictEvidence:evidence};
}
export function alignAdviceWithIssues(report,{removed=false,neutralized=false}={}){
  if(report.evidenceRejected && !report.issues.length)return {...report,strengths:[],summary:'本次建议的证据未通过完整核对，暂未生成可展示的建议，不能据此判断表达没有问题。',nextStep:'可先结合各页用时回听发言；如需重新诊断，请重试分析。'};
  if(!report.issues.length)return {...report,summary:'本次尚未形成有充分依据的修改建议，不代表整场汇报没有问题。',nextStep:'保留现有发言，选一个重点再讲一段，核对听众能否理解。'};
  if(removed||neutralized)return {...report,summary:`优先调整：${report.issues.slice(0,2).map(issue=>issue.title).join('；')}。`,nextStep:report.issues[0].suggestion};
  return report;
}
