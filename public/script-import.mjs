import {splitScript,associateScript,cleanImportedScript} from './script-import-core.mjs';
import {readScriptFile} from './script-reader.mjs';
export function createScriptImport({state,workspace,openPdf,onChanged,escape}){
 const entry=document.getElementById('import-script');
 const dialog=document.createElement('dialog');dialog.id='script-import-dialog';dialog.className='script-import-dialog';
 dialog.setAttribute('aria-labelledby','script-import-title');
 dialog.innerHTML=`<header><h2 id="script-import-title">准备讲稿</h2><button id="script-close" class="dialog-close" aria-label="关闭讲稿窗口">×</button></header>
 <div class="script-file-row"><button id="script-file-button" class="button secondary">选择文件</button><button id="script-paste-button" class="text-button">粘贴讲稿</button><span id="script-filename">DOCX / PDF / TXT，也可直接粘贴</span><input id="script-file-input" type="file" accept=".docx,.pdf,.txt" hidden></div>
 <p id="script-import-status" role="status" hidden></p>
 <textarea id="script-paste" rows="10" maxlength="120000" aria-label="粘贴完整讲稿" placeholder="把整篇讲稿粘贴在这里…"></textarea>
 <div id="script-editing" hidden><div class="script-edit-toolbar"><span id="script-count"></span><div><button id="script-rematch" class="text-button">重新匹配待分配段落</button><button id="script-show-original" class="text-button">查看原稿</button></div></div><p class="script-assignment-hint">建议页码可调整；讲稿不会当作实际发言。</p><div id="script-parts"></div><div id="script-pagination"><button id="script-parts-prev" class="text-button">上一组</button><span id="script-parts-position"></span><button id="script-parts-next" class="text-button">下一组</button></div></div>
 <div id="script-original-panel" hidden><div class="script-edit-toolbar"><span>导入原稿 · 始终保留</span><button id="script-original-back" class="text-button">返回分段</button><button id="script-original-download" class="text-button">下载原稿</button></div><pre id="script-original-text"></pre></div>
 <footer><button id="script-cancel" class="button secondary">取消</button><button id="script-apply" class="button primary">分段并关联 PPT</button></footer>`;
 document.body.append(dialog);const $=id=>dialog.querySelector('#'+id);
 let draft=null,offset=0,controller=null,reading=false,saving=false,dirty=false;
 const status=(text,error=false)=>{$('script-import-status').textContent=text;$('script-import-status').hidden=!text;$('script-import-status').classList.toggle('error',error);};
 function sync(){entry.disabled=state.busy||state.recording||!state.pages.length||!!state.materialPending||state.demo;entry.textContent=state.importedScript?'查看 / 更换讲稿':'已有讲稿？导入或粘贴';}
 function render(){
  $('script-paste').hidden=!!draft;$('script-editing').hidden=!draft;$('script-original-panel').hidden=true;
  $('script-apply').textContent=draft?'用于演练':'分段并关联 PPT';$('script-apply').disabled=reading||saving;
  if(!draft)return;
  const pending=draft.parts.filter(p=>!p.page).length,suggested=draft.parts.filter(p=>p.link==='suggested').length;
  $('script-count').textContent=`${draft.parts.length} 段${pending?` · ${pending} 段待分配`:''}${suggested?` · ${suggested} 段建议页码`:''}`;
  const shown=draft.parts.slice(offset,offset+20);
  $('script-parts').innerHTML=shown.map((p,i)=>`<article class="import-script-part"><div><span>第 ${offset+i+1} 段${p.markedPage>state.pages.length?' · 原稿页码超出 PPT':p.link==='suggested'?' · 建议页码':''}</span><select data-script-page="${p.id}" aria-label="第 ${offset+i+1} 段对应 PPT 页码"><option value="0">待分配</option>${state.pages.map(page=>`<option value="${page.number}" ${p.page===page.number?'selected':''}>第 ${page.number} 页</option>`).join('')}</select></div><textarea data-script-text="${p.id}" aria-label="第 ${offset+i+1} 段讲稿" rows="${Math.min(6,Math.max(2,Math.ceil(p.text.length/45)))}">${escape(p.text)}</textarea></article>`).join('');
  $('script-pagination').hidden=draft.parts.length<=20;$('script-parts-position').textContent=`${Math.floor(offset/20)+1} / ${Math.ceil(draft.parts.length/20)}`;$('script-parts-prev').disabled=!offset;$('script-parts-next').disabled=offset+20>=draft.parts.length;
  $('script-parts').querySelectorAll('[data-script-page]').forEach(el=>el.onchange=()=>{const p=draft.parts.find(p=>p.id===el.dataset.scriptPage);p.page=Number(el.value);p.link=p.page?'manual':'unassigned';delete p.markedPage;dirty=true;});
  $('script-parts').querySelectorAll('[data-script-text]').forEach(el=>el.oninput=()=>{draft.parts.find(p=>p.id===el.dataset.scriptText).text=el.value;dirty=true;});
 }
 const setDraft=(text,name)=>{draft={name,originalText:text,parts:associateScript(splitScript(text,state.pages.length),state.pages)};offset=0;dirty=true;render();};
 function open(){if(entry.disabled||reading||saving)return;draft=state.importedScript?structuredClone(state.importedScript):null;offset=0;dirty=false;status('');$('script-filename').textContent=draft?.name||'DOCX / PDF / TXT，也可直接粘贴';$('script-paste').value='';render();dialog.showModal();}
 function close(){if(saving)return;if(dirty&&!confirm('放弃这次尚未保存的讲稿修改？原有讲稿不受影响。'))return;controller?.abort();dialog.close();}
 entry.onclick=open;$('script-close').onclick=close;$('script-cancel').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 $('script-file-button').onclick=()=>{if(!reading&&!saving)$('script-file-input').click();};
 $('script-paste-button').onclick=()=>{if(reading||saving)return;if(dirty&&!confirm('放弃尚未保存的修改，改为粘贴讲稿？'))return;draft=null;dirty=false;$('script-paste').value='';$('script-filename').textContent='粘贴整篇讲稿';status('');render();$('script-paste').focus();};
 $('script-paste').oninput=()=>{dirty=!!$('script-paste').value;};
 $('script-file-input').onchange=async()=>{
  const file=$('script-file-input').files[0];if(!file)return;
  const prior=draft,priorPaste=$('script-paste').value;controller?.abort();const task=new AbortController();controller=task;reading=true;$('script-apply').disabled=true;$('script-file-button').disabled=true;status('正在读取讲稿…');
  try{
   const text=await readScriptFile(file,{openPdf,signal:task.signal,onProgress:(text,n,total)=>{
    if(!dialog.open||task.signal.aborted)return;
    if(!prior){$('script-paste').value=text;$('script-paste').readOnly=true;}
    status(total>1?`正在读取 ${n} / ${total} 页`:'正在整理讲稿…');
   }});
   task.signal.throwIfAborted();setDraft(text,file.name);$('script-filename').textContent=file.name;status('');
  }catch(error){if(!task.signal.aborted){draft=prior;render();status(/ZIP|XML|checksum|package|entry|directory|signature/i.test(error.message||'')?'这份 Word 文件无法读取，请另存为 DOCX 后再试。':error.name==='PasswordException'?'这份 PDF 有打开密码，请解除密码后再导入。':error.message||'讲稿未能读取，请重新选择文件。',true);if(!prior)$('script-paste').value=priorPaste;}}
  finally{if(controller===task){controller=null;reading=false;$('script-paste').readOnly=false;$('script-file-button').disabled=false;$('script-apply').disabled=false;$('script-file-input').value='';}}
 };
 $('script-parts-prev').onclick=()=>{offset=Math.max(0,offset-20);render();$('script-parts').scrollTop=0;};
 $('script-parts-next').onclick=()=>{offset+=20;render();$('script-parts').scrollTop=0;};
 $('script-rematch').onclick=()=>{draft.parts=associateScript(draft.parts,state.pages,{onlyUnassigned:true});dirty=true;render();};
 $('script-show-original').onclick=()=>{$('script-editing').hidden=true;$('script-original-panel').hidden=false;$('script-original-text').textContent=draft.originalText;};
 $('script-original-back').onclick=render;
 $('script-original-download').onclick=()=>{const url=URL.createObjectURL(new Blob(['\ufeff'+draft.originalText],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=draft.name.replace(/\.[^.]+$/,'')+'-原稿.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 $('script-apply').onclick=async()=>{
  if(reading||saving)return;
  if(!draft){try{setDraft($('script-paste').value,'粘贴的讲稿');status('');}catch(e){status(e.message,true);}return;}
  const cleaned=cleanImportedScript(draft,state.pages.length);if(!cleaned){status('有空白段落或文字过长，请补全后再保存。',true);return;}
  saving=true;$('script-apply').disabled=true;const previous=state.importedScript,identity={id:state.id,parentId:state.parentId,createdAt:state.createdAt};
  try{
   if(!await workspace.saveNow())throw Error('本机保存失败，请重试。');
   if(previous&&previous.originalText!==cleaned.originalText)Object.assign(state,{id:crypto.randomUUID(),parentId:identity.id,createdAt:new Date().toISOString()});
   state.importedScript=cleaned;
   if(!await workspace.saveNow()){state.importedScript=previous;Object.assign(state,identity);throw Error('讲稿未能保存，请重试。');}
   dirty=false;dialog.close();sync();onChanged();
  }catch(e){status(e.message,true);}finally{saving=false;$('script-apply').disabled=false;}
 };
 return {sync};
}
