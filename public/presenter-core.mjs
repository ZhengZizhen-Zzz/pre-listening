import {importedScriptSources} from './script-import-core.mjs';
import {compileScriptPages} from './transcript-core.mjs';
import {pageDurations} from './core.mjs';

export function presenterNoteSources(state,page) {
  const current=compileScriptPages(state.segments||[],state.pages||[],state.scripts||{}).find(item=>item.page===page);
  const reference=(state.referenceScript||[]).find(item=>item.page===page);
  const original=(state.originalNotes||[]).find(item=>item.page===page);
  const sources=[];
  if(current?.changed)sources.push({id:'practice',label:'修改后讲稿',text:current.text});
  sources.push(...importedScriptSources(state.importedScript,page));
  if(!current?.changed&&reference?.text)sources.push({id:'practice',label:'上一轮讲稿',text:reference.text});
  if(original?.text)sources.push({id:'original',label:'PPT 原备注',text:original.text});
  if(current?.text&&!current.changed)sources.push({id:'speech',label:'本次发言',text:current.text});
  return sources;
}
export function presenterNotes(state,page) {
  return presenterNoteSources(state,page)[0]?.text||'';
}
export function presenterTiming(state,targetSeconds,now=performance.now()) {
  const elapsed=state.recording?Math.max(0,(state.recordingOffset||0)+((state.recordingStoppedAt??now)-state.started)/1000):Math.max(0,state.duration||0);
  const pageSeconds=pageDurations(state.events||[],elapsed,state.pages?.length||0)[state.current-1]||0;
  return {elapsed,pageSeconds,remaining:Math.max(0,targetSeconds-elapsed),over:Math.max(0,elapsed-targetSeconds)};
}
