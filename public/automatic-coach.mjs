import {retryRead} from './retry-read.mjs';
// Small asynchronous requests keep evidence investigation alive across proxy timeouts.
export async function automaticCoach(kind,session,{api,onProgress=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}) {
  const request=(url,body)=>{const call=()=>api(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});return body?call():retryRead(call);};
  let run=await request('/api/coach/automatic',{kind,session});
  const needsRetry=!run.results?.[kind]||(kind==='diagnose'&&run.results.diagnose.evidenceRejected);
  if(['failed','partial'].includes(run.status)&&needsRetry&&run.retries<1)run=await request(`/api/coach/${run.id}/retry`,{});
  const started=now();
  while(['planning','running'].includes(run.status)){
    const step=[...(run.trace||[])].reverse().find(item=>item.status==='running');
    onProgress(step?.label||'正在结合材料与实际发言查证…');
    if(now()-started>270000)throw new Error('任务仍在处理，原始发言已保留；稍后重试会继续查看同一任务。');
    await sleep(1500);run=await request(`/api/coach/${run.id}`);
  }
  const result=run.results?.[kind];
  if(result)return {...result,generatedAt:run.createdAt};
  throw new Error(run.failures?.[kind]||run.message||'本次任务未完成，已有内容保留，请稍后重试。');
}
