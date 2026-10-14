import {localRecords} from './storage.mjs';
import {FEEDBACK_CONSENT,FEEDBACK_MAX_BYTES,normalizeFeedback} from './feedback-core.mjs';

export function createFeedback({state,$,workspace,api,health,setBusy,message,escape:esc,renderReport}) {
  const dialog=$('feedback-dialog'),form=$('feedback-form');
  let record,runs=[],sending=false,clientId;
  const options=(values,current)=>values.map(([value,label])=>`<option value="${value}" ${value===current?'selected':''}>${label}</option>`).join('');
  const note=(value,error=false)=>{$('feedback-status').textContent=value;$('feedback-status').classList.toggle('error',error);};
  async function open() {
    if(state.busy||state.recording||dialog.open)return;
    if(state.demo)return message('请使用自己的演练提交反馈；示例不计入试用结果。',true);
    setBusy(true);
    try {
      await workspace.saveNow();record=workspace.snapshot();clientId=record.id;
      runs=record.report?await localRecords.listTraining(record.id):[];
      const draft=await localRecords.getMeta(`feedback-draft:${clientId}`)||{};
      form.reset();$('feedback-helpful').value=draft.helpful||'';$('feedback-comment').value=draft.comment||'';
      $('feedback-issue-fields').innerHTML=(record.report?.issues||[]).map((issue,index)=>{
        const f=record.feedback?.[index]||{};
        return `<section class="feedback-issue"><strong>${esc(issue.title)}</strong><div class="feedback-field-row"><label>判断对不对<select data-judgment="${index}">${options([['','未填写'],['correct','判断正确'],['partial','部分正确'],['incorrect','判断不对'],['unsure','暂不确定']],f.judgment)}</select></label><label>愿不愿意采用<select data-adoption="${index}">${options([['','未填写'],['yes','愿意采用'],['no','不采用'],['later','还要考虑']],f.adoption)}</select></label></div><label>为什么（选填）<textarea data-reason="${index}" rows="2" maxlength="2000">${esc(f.reason||'')}</textarea></label></section>`;
      }).join('');
      $('feedback-issue-details').hidden=!record.report;
      const receipt=await localRecords.getMeta(`feedback-receipt:${clientId}`);
      note(receipt?`上次已提交：${new Date(receipt.submittedAt).toLocaleString('zh-CN')}。可以修改后更新。`:'');
      dialog.showModal();
    } catch(e) {setBusy(false);message(e.message||'暂时无法读取本次记录。',true);}
  }
  function draft() {return {helpful:$('feedback-helpful').value,comment:$('feedback-comment').value};}
  let draftTimer;
  form.addEventListener('input',()=>{clearTimeout(draftTimer);draftTimer=setTimeout(()=>localRecords.setMeta(`feedback-draft:${clientId}`,draft()).catch(()=>{}),300);});
  $('feedback-close').onclick=()=>{if(!sending)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(sending)event.preventDefault();});
  dialog.addEventListener('close',()=>{clearTimeout(draftTimer);localRecords.setMeta(`feedback-draft:${clientId}`,draft()).catch(()=>{});setBusy(false);});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(sending)return;
    const answers=Object.fromEntries((record.report?.issues||[]).map((_,i)=>[i,{...record.feedback?.[i],judgment:form.querySelector(`[data-judgment="${i}"]`).value,adoption:form.querySelector(`[data-adoption="${i}"]`).value,reason:form.querySelector(`[data-reason="${i}"]`).value}]));
    const payload={clientId,...draft(),nickname:'',consent:true,consentVersion:FEEDBACK_CONSENT,record:null,training:[]};
    if(record.report){
      const {title,pages,segments,events,durationSeconds,goals,demo,report,rewrites,scripts}=record;
      payload.record={title,pages,segments,events,durationSeconds,goals,demo,report,feedback:answers,rewrites,scripts};
      payload.training=runs.map(r=>({kind:r.kind,createdAt:r.createdAt,issue:r.issue?{suggestion:r.issue.suggestion,page:r.issue.page}:null,
        turns:r.turns.map(t=>({question:t.question,attempts:t.attempts.map(a=>({text:a.text,source:a.source,durationSeconds:a.durationSeconds,feedback:a.feedback,revision:a.revision?{answers:a.revision.answers,result:{status:a.revision.result?.status,revisedText:a.revision.result?.revisedText,reason:a.revision.result?.reason,question:a.revision.result?.question}}:null}))}))}));
    }
    try {
      normalizeFeedback(payload);
      const body=JSON.stringify(payload);if(new Blob([body]).size>FEEDBACK_MAX_BYTES)throw new Error('记录较多，请取消附带练习记录后重试。');
      sending=true;$('feedback-send').disabled=true;$('feedback-close').disabled=true;note('正在提交…');
      await health();
      const receipt=await api('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(20000)});
      let localWarning=false;
      try{await localRecords.setMeta(`feedback-receipt:${clientId}`,receipt);await localRecords.setMeta(`feedback-draft:${clientId}`,draft());}catch{localWarning=true;}
      if(payload.record&&state.id===record.id){state.feedback=answers;await workspace.saveNow();renderReport();}
      note(`已提交，开发者可以查看本次反馈。${localWarning?'本机提交标记未保存；重复提交不会产生重复记录。':'之后有补充，可以再次提交更新。'}`);
    } catch(e) {note(e.message||'暂未收到提交确认，请重试；不会重复生成记录。',true);}
    finally {sending=false;$('feedback-send').disabled=false;$('feedback-close').disabled=false;}
  });
  $('submit-feedback-nav').onclick=open;
}
