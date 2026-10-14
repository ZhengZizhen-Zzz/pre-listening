export function transcriptionRecoveryText(state) {
  const detail=state.jobError||state.health?.asrError||'';
  if(/ASR_RESPONSE_HAVE_NO_WORDS|没有识别到|未识别到.*语音/.test(detail))return '这段录音未识别出发言。可回听确认，或直接填写。';
  if(state.jobStatus==='uncertain')return '转写提交暂未确认，录音已保留。点击“继续转写”检查原任务，无需重新录音。';
  if(state.jobStatus==='pending'&&detail)return '获取结果时连接中断，录音已保留。点击“继续转写”获取原任务。';
  if(detail&&detail.length<180&&!/ReferenceError|TypeError|DOCTYPE|\bat \w+\(/.test(detail))return detail.replace(/本地服务/g,'转写服务');
  return '转写暂时未完成，录音已保留。可以重试转写，无需重新录音。';
}

export function rejectedTranscriptionSubmission(error) {
  return error.submissionStarted===false||!error.jobId&&[400,401,403,409,413,429].includes(error.status);
}
