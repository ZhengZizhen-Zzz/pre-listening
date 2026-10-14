// These checks screen observable constraints; they do not replace semantic review.
export function normalizeSpeech(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '');
}
export function characterErrors(reference, hypothesis) {
  const a=Array.from(normalizeSpeech(reference)), b=Array.from(normalizeSpeech(hypothesis));
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++) {
    const next=[i];
    for(let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));
    row=next;
  }
  return {edits:row[b.length],referenceCharacters:a.length,cer:a.length?row[b.length]/a.length:null};
}
export function scoreAsrWindows(windows, variants) {
  const confirmed=windows.filter(w=>w.status==='confirmed'&&typeof w.reference==='string'&&w.reference.trim());
  const scores=Object.fromEntries(Object.entries(variants).map(([name,segments])=>{
    const details=confirmed.map(w=>{
      // Review windows cover whole provider sentences. Both runs are aligned by time,
      // not sentence number, because ASR may split S-O-R into multiple segments.
      const hypothesis=segments.filter(s=>s.start>=w.start-.05&&s.end<=w.end+.05).map(s=>s.text).join('');
      return {id:w.id,reference:w.reference,hypothesis,...characterErrors(w.reference,hypothesis)};
    });
    const edits=details.reduce((n,d)=>n+d.edits,0), chars=details.reduce((n,d)=>n+d.referenceCharacters,0);
    return [name,{confirmedWindows:details.length,edits,referenceCharacters:chars,cer:chars?edits/chars:null,details}];
  }));
  return {reviewedWindows:confirmed.length,pendingWindows:windows.length-confirmed.length,scores,
    limitation:'仅对人工回听确认的完整片段计算；标点空格忽略，数字保留，英文按字符。不是全文准确率，CER可能超过100%。'};
}
export function screenCase(item, result) {
  const failures=[],check=(ok,reason)=>{if(!ok)failures.push(reason);};
  // Internal audit rationale may say "不能证明口误" when rejecting a bad issue.
  // Only screen fields shown as advice to the user, not that rejection log.
  const text=JSON.stringify(item.kind==='diagnosis'?{summary:result.summary,strengths:result.strengths,nextStep:result.nextStep,issues:result.issues}:result);
  if(item.kind==='diagnosis') {
    check(Array.isArray(result.issues),'缺少建议列表');
    const issues=result.issues||[];
    if(item.expected==='no_issue')check(issues.length===0,'正常表达或识别噪声被提出修改建议');
    if(['conflict','expression'].includes(item.expected))check(issues.length>0,'未检出目标问题');
    for(const issue of issues){
      const source=item.session.segments.find(s=>s.id===issue.segmentId);
      check(Boolean(source&&issue.quote?.length>=4&&source.text.includes(issue.quote)),'引用不在对应发言中');
      if(item.expected==='conflict')check(issue.action==='clarify'&&Boolean(issue.question?.trim()),'冲突未先确认');
    }
    if(item.expected==='conflict')check(!/(说反了?|讲错了?|读错了?|口误|应当?改(?:回|为)|纠正为|正确(?:的)?(?:说法|方向|数值)是)/.test(text),'未确认就判定一方正确或让用户改口');
    if(item.expected==='no_issue')check(!/(建议.{0,8}(?:改回|照念|逐字)|口误|发音不准)/.test(text),'摘要或下一步仍包含被排除的问题');
  } else {
    check(item.allowedStatuses.includes(result.status),'改稿状态不符合预期');
    if(result.status==='draft'){
      check(result.originalText===item.request.session.segments.find(s=>s.id===item.request.issue.segmentId).text,'改稿原文范围不符');
      for(const pattern of item.forbidden||[])check(!new RegExp(pattern).test(result.revisedText),'草稿含未确认事实或状态变化：'+pattern);
      for(const group of item.mustIncludeAny||[])check(group.some(term=>result.revisedText.includes(term)),'草稿丢失必要事实：'+group.join('/'));
    }
  }
  return {screenPassed:failures.length===0,failures,semanticReview:'pending',rubric:item.rubric};
}
