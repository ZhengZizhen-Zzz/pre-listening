// Stop at the interruption boundary, before a suspended page can count silent time.
export function watchRecording({stream,recorder,onInterrupt,doc=globalThis.document,win=globalThis.window}){
 let ended=false;const subscriptions=[];
 const listen=(target,event,handler)=>{if(!target?.addEventListener)return;target.addEventListener(event,handler);subscriptions.push(()=>target.removeEventListener?.(event,handler));};
 const interrupt=reason=>{if(ended)return;ended=true;onInterrupt(reason);};
 listen(doc,'visibilitychange',()=>{if(doc.visibilityState==='hidden')interrupt('页面已切到后台');});
 listen(win,'pagehide',()=>interrupt('页面已离开'));
 listen(doc,'freeze',()=>interrupt('页面被系统暂停'));
 for(const track of stream.getTracks()){
   listen(track,'ended',()=>interrupt('麦克风已断开'));
   listen(track,'mute',()=>interrupt('麦克风暂时不可用'));
 }
 listen(recorder,'pause',()=>interrupt('录音被系统暂停'));
 return ()=>{ended=true;subscriptions.splice(0).forEach(remove=>remove());};
}
