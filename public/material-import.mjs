import { UPLOAD_CHUNK_BYTES, MAX_UPLOAD_CHUNK_BYTES, INLINE_UPLOAD_BYTES } from './material-limits.mjs';

const fault=(message,status=0,code='network_error')=>Object.assign(new Error(message),{status,code});
const elapsedLabel=ms=>{const seconds=Math.max(0,Math.floor(ms/1000));return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${String(seconds%60).padStart(2,'0')} 秒`;};
export function importError(status,detail={}) {
  if(detail.error)return fault(detail.error,status,detail.code||'upload_failed');
  if(status===401||status===403)return fault('登录或页面连接已过期，请刷新页面后重新导入。',status,'expired');
  if(status===413)return fault('上传被网络入口拒绝，请刷新页面后重新选择文件。',status,'upload_failed');
  if(status===429)return fault('当前上传人数较多，请稍后再试。',status,'upload_failed');
  if([502,503,504,520,522,524].includes(status))return fault('导入服务暂时连接不上，请稍后重试。你的原文件不受影响。',status,'network_error');
  return fault('上传没有完成，请检查网络后重试。',status,'upload_failed');
}

export function materialRequest(url,{method='GET',body,token,blob=false,mixed=false,headers={},onUploaded,progress,timeout=90000,signal}={}) {
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const xhr=new XMLHttpRequest();
    const abort=()=>xhr.abort();signal?.addEventListener('abort',abort,{once:true});
    xhr.onloadend=()=>signal?.removeEventListener('abort',abort);
    xhr.onabort=()=>reject(signal?.reason||new DOMException('Cancelled','AbortError'));
    xhr.open(method,url);xhr.responseType='blob';xhr.timeout=timeout;
    xhr.setRequestHeader('X-Local-Token',token||'');
    for(const [name,value]of Object.entries(headers))xhr.setRequestHeader(name,value);
    if(body!==undefined)xhr.setRequestHeader('Content-Type',typeof body==='string'?'application/json':'application/octet-stream');
    if(progress){if(method==='PUT'||method==='POST'&&body instanceof Blob)xhr.upload.onprogress=progress;else xhr.onprogress=progress;}
    if(onUploaded)xhr.upload.onload=onUploaded;
    xhr.onload=async()=>{
      if(xhr.status>=200&&xhr.status<300){
        if(mixed&&/^application\/pdf\b/i.test(xhr.getResponseHeader('Content-Type')||''))return resolve({id:xhr.getResponseHeader('X-Material-Import'),state:'complete',preview:xhr.response});
        if(blob)return resolve(xhr.response);
        try{return resolve(JSON.parse(await xhr.response.text()));}catch{return reject(fault('服务返回的内容无法读取，请刷新后重试。',502,'server_error'));}
      }
      let detail={};try{detail=JSON.parse(await xhr.response.text());}catch{}
      reject(importError(xhr.status,detail));
    };
    xhr.onerror=()=>reject(fault('上传连接中断，请检查网络后重试。'));
    xhr.ontimeout=()=>reject(fault('网络传输超时，请检查网络后重试。',408));
    xhr.send(body);
  });
}

// Every upload request is small and repeatable. Conversion is a separate job,
// so a slow deck does not hold an external HTTP request open for minutes.
export async function importPresentation(file,format,{token,message=()=>{},request=materialRequest,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,requestId=crypto.randomUUID(),signal,fast=false,inline=false,onUploaded=()=>{},onNotes=()=>{}}={}) {
  let job,receivedPreview=false,notified=false;
  const uploaded=()=>{if(!notified){notified=true;onUploaded();}};
  const complete=async preview=>{
    if(format==='ppt'&&job?.id){
      try{onNotes(await retry(`/api/materials/imports/${job.id}/notes`));}
      catch{signal?.throwIfAborted();onNotes({notes:[],status:'unavailable'});}
    }
    receivedPreview=true;return preview;
  };
  const retry=async(url,options={})=>{
    for(let attempt=0;;attempt++)try{signal?.throwIfAborted();return await request(url,{token,signal,...options});}catch(e){
      signal?.throwIfAborted();if(e.name==='AbortError')throw e;
      if(attempt>=2||![0,408,425,502,503,504,520,522,524].includes(e.status??0))throw e;
      message('连接有波动，正在重试…');await sleep(750*(attempt+1));
    }
  };
  try{
    if(inline&&file.size<=INLINE_UPLOAD_BYTES){
      message('正在打开 PPT…');
      job=await retry('/api/materials/imports/inline',{method:'POST',body:file,mixed:true,headers:{'X-Deck-Format':format,'X-Upload-Request-Id':requestId},onUploaded:uploaded});
      uploaded();
    }else{
    job=await retry('/api/materials/imports',{method:'POST',body:JSON.stringify({size:file.size,format,requestId,...(inline?{chunkBytes:MAX_UPLOAD_CHUNK_BYTES}:{})})});
    const chunkBytes=job.chunkBytes||UPLOAD_CHUNK_BYTES;
    if(!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>MAX_UPLOAD_CHUNK_BYTES)throw fault('上传配置异常，请刷新后重试。',400,'server_error');
    // Two requests overlap network round trips without buffering the whole deck.
    // Re-sending any already received index is safe, including after a retry.
    const count=Math.ceil(file.size/chunkBytes),loaded=new Map();
    let next=0,uploadError,percent=0;
    const progress=(index,bytes)=>{
      loaded.set(index,bytes);
      percent=Math.max(percent,Math.min(100,Math.floor([...loaded.values()].reduce((a,b)=>a+b,0)/file.size*100)));
      message(`正在上传 PPT · ${percent}%`);
    };
    const upload=async()=>{
      while(next<count&&!uploadError){
        const index=next++,offset=index*chunkBytes,part=file.slice(offset,Math.min(file.size,offset+chunkBytes));
        try{
          progress(index,0);
          await retry(`/api/materials/imports/${job.id}/chunks/${index}`,{method:'PUT',body:part,progress:event=>progress(index,Math.min(part.size,event.loaded))});
          progress(index,part.size);
        }catch(error){uploadError ||= error;}
      }
    };
    await Promise.all(Array.from({length:Math.min(2,count)},()=>upload()));
    if(uploadError)throw uploadError;
    job=await retry(`/api/materials/imports/${job.id}/complete`,{method:'POST'});
    uploaded();
    }
    if(job.preview){return await complete(job.preview);}
    const started=now();
    while(!['complete','failed'].includes(job.state)){
      signal?.throwIfAborted();
      if(now()-started>45*60*1000)throw fault('等待处理的时间过长，请稍后重新导入。',408,'conversion_timeout');
      const elapsed=elapsedLabel(now()-started);
      message(job.state==='queued'
        ? `材料已上传，正在排队${job.position>0?` · 前方 ${job.position} 份`:''} · 已等待 ${elapsed}`
        : `材料已上传，正在转换并生成页面预览 · 已等待 ${elapsed}`);
      if(inline){
        job=await retry(`/api/materials/imports/${job.id}/ready`,{mixed:true});
        if(job.preview){return await complete(job.preview);}
      }else{await sleep(fast&&now()-started<10000?350:1500);job=await retry(`/api/materials/imports/${job.id}`);}
    }
    if(job.state==='failed')throw fault(job.error||'PPT 转换失败，请重新另存为 PPTX 或 PDF。',422,job.code||'conversion_failed');
    message('正在打开页面预览…');
    const preview=await retry(`/api/materials/imports/${job.id}/preview`,{blob:true,timeout:10*60*1000,progress:event=>message(event.lengthComputable?`正在接收页面预览 · ${Math.round(event.loaded/event.total*100)}%`:'正在接收页面预览…')});
    return await complete(preview);
  }catch(e){if(job?.id)e.reference=job.id.slice(0,8);throw e;}
  finally{if(job?.id||inline){const url=job?.id?`/api/materials/imports/${job.id}`:`/api/materials/imports/requests/${requestId}`;const cleanup=request(url,{method:'DELETE',token,timeout:10000}).catch(()=>{});if(!receivedPreview)await cleanup;}}
}

export function describeMaterialError(error) {
  if(error.name==='PasswordException')return {code:'pdf_password',message:'这份 PDF 设置了打开密码，请取消密码保护后再导入。'};
  if(error.name==='InvalidPDFException')return {code:'pdf_invalid',message:'PDF 无法解析，请确认文件能正常打开，或从 WPS / PowerPoint 重新导出 PDF。'};
  if(/withResolvers|is not a function|not supported/i.test(error.message||''))return {code:'browser_unsupported',message:'当前浏览器暂不支持这个预览功能，请使用新版 Chrome、Edge 或 Safari 打开。'};
  if(error.name==='TimeoutError')return {code:'network_error',message:'材料读取超时，请检查网络后重试。'};
  return {code:error.code||(/1–60 页/.test(error.message)?'page_limit':'preview_failed'),message:error.message||'材料无法读取，请重新选择文件。'};
}
