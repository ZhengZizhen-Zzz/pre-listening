import {validateQuestion} from './training-core.mjs';
// A grounded opening exercise is available locally; model follow-ups retain it.
// This is a template-based practice question, not an instant model response.
export function openingQuestion(session){
 const candidates=[];
 for(const s of session.segments||[])candidates.push({text:s.text,page:s.page,evidence:{source:'speech',segmentId:s.id},speech:true});
 for(const p of session.pages||[])candidates.push({text:p.text,page:p.number,evidence:{source:'slide',page:p.number}});
 const choices=[];
 for(const c of candidates)for(const line of (c.text||'').split(/[。！？\n]/u)){
  const quote=line.trim();if(quote.length<8||quote.length>90||/^(谢谢|感谢|大家好|各位老师好|目录|汇报人|指导老师|指导教师|学校|日期)/.test(quote))continue;
  const score=(c.speech?3:0)+(c.page>1?2:0)+(/方案|研究|方法|选择|问题|结果|结论|目标|计划|发现|建议|提出/.test(quote)?3:0)-(quote.length>50?1:0);
  choices.push({...c,quote,score});
 }
 choices.sort((a,b)=>b.score-a.score);
 const c=choices[0];if(!c)return null;
 const quote=c.quote;
 // Preserve the exact quote; don't label a hypothesis as an achieved result.
 const question=`你提到“${quote}”。其中最希望听众记住的一点是什么，为什么？`;
 try{return validateQuestion({question,evidence:{...c.evidence,quote},rubric:{purpose:'讲清这一部分最重要的信息及其意义',criteria:[{label:'核心信息',description:'明确希望听众记住哪一点，不要求照念材料'},{label:'重要原因',description:'解释这一点为什么重要，保留原有事实与假设的区别'}]}},session);}catch{return null;}
}
