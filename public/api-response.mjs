export async function readApiResponse(response) {
  const text = await response.text();
  let result;
  try { result = JSON.parse(text);if(!result||typeof result!=='object')throw new Error('invalid'); }
  catch {
    const timeout = [408, 502, 503, 504, 524].includes(response.status);
    throw Object.assign(new Error(timeout
      ? '服务暂时未响应，内容已保留，请稍后重试。'
      : '连接暂时中断，内容已保留，请稍后重试。'), {status:response.status, retryable:true});
  }
  if (!response.ok) throw Object.assign(new Error(
    response.status === 401 ? '试用登录已过期，请刷新后重新输入密码。' : result.error || '请求未完成，请重试。'
  ), {status:response.status, jobId:result.jobId,code:result.code,...(result.submissionStarted===false?{submissionStarted:false}:{})});
  return result;
}
