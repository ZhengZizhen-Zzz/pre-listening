export function soundLevel(samples){let sum=0;for(const x of samples)sum+=x*x;return samples.length?Math.sqrt(sum/samples.length):0;}
export function createSoundCheck(){let heard=0;return {sample(level){heard=level>=0.006?Math.min(heard+1,8):Math.max(0,heard-1);return heard>=4;}};}

// The short sound check stays in the browser. Its stream is reused for recording.
export async function checkMicrophone(stream,{Audio=globalThis.AudioContext||globalThis.webkitAudioContext}={}){
 const dialog=document.createElement('dialog');dialog.className='microphone-check';dialog.id='microphone-check';dialog.setAttribute('aria-labelledby','microphone-title');
 dialog.innerHTML='<button type="button" class="text-button microphone-close" aria-label="取消麦克风检测">×</button><h2 id="microphone-title">先试一下麦克风</h2><p id="microphone-status" role="status">请说一句话，看看音量条是否跳动。</p><meter id="microphone-meter" min="0" max="1" value="0" aria-label="麦克风音量"></meter><p class="microphone-note">检测声音仅在本机处理，不上传。</p><div class="microphone-buttons"><button type="button" id="microphone-cancel" class="button secondary">取消</button><button type="button" id="microphone-start" class="button primary" disabled>开始录音</button></div>';
 document.body.append(dialog);dialog.showModal();
 const status=dialog.querySelector('#microphone-status'),button=dialog.querySelector('#microphone-start'),meter=dialog.querySelector('meter');
 let context,source,analyser,timer,reminder,settled=false,seen=false,needsActivation=false;
 let gate=createSoundCheck();
 const usable=()=>stream.getAudioTracks().some(t=>t.readyState==='live'&&!t.muted);
 return new Promise((resolve,reject)=>{
   const cleanup=()=>{clearInterval(timer);clearTimeout(reminder);document.removeEventListener('visibilitychange',hidden);for(const track of stream.getTracks()){track.removeEventListener('ended',ended);track.removeEventListener('mute',availability);track.removeEventListener('unmute',availability);}source?.disconnect();analyser?.disconnect();context?.close().catch(()=>{});dialog.close();dialog.remove();};
   const finish=ok=>{if(settled)return;settled=true;cleanup();if(ok)resolve(stream);else{stream.getTracks().forEach(track=>track.stop());reject(new DOMException('已取消麦克风检测','AbortError'));}};
   const ended=()=>{seen=false;button.disabled=true;status.textContent='麦克风已断开，请取消后重新连接。';};
   const availability=()=>{seen=false;gate=createSoundCheck();meter.value=0;button.disabled=!needsActivation;status.textContent=usable()?'请再说一句话，确认麦克风已恢复。':'麦克风暂时没有输入，请解除静音或重新连接。';};
   const hidden=()=>{if(document.visibilityState==='hidden')finish(false);};
   dialog.querySelector('.microphone-close').onclick=()=>finish(false);dialog.querySelector('#microphone-cancel').onclick=()=>finish(false);
   dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
   button.onclick=async()=>{if(needsActivation){button.disabled=true;try{await context.resume();if(context.state!=='running')throw new Error('suspended');needsActivation=false;button.textContent='开始录音';status.textContent='请说一句话，看看音量条是否跳动。';}catch{button.disabled=false;status.textContent='声音检测未能启动，请点击重试或检查浏览器权限。';}return;}if(!button.disabled){if(usable())finish(true);else availability();}};
   document.addEventListener('visibilitychange',hidden);for(const track of stream.getTracks()){track.addEventListener('ended',ended);track.addEventListener('mute',availability);track.addEventListener('unmute',availability);}
   (async()=>{
    try{
      if(!Audio)throw new Error('unsupported');context=new Audio();
      // Mobile Safari may require a fresh tap after microphone permission.
      if(context.state!=='running'){needsActivation=true;button.disabled=false;button.textContent='启用声音检测';status.textContent='点一下启用检测，再说一句话。';}
      source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=1024;source.connect(analyser);const data=new Float32Array(analyser.fftSize);
      timer=setInterval(()=>{if(settled||needsActivation||!usable())return;analyser.getFloatTimeDomainData(data);const rms=soundLevel(data);meter.value=Math.min(1,rms*8);if(gate.sample(rms)&&!seen){seen=true;button.disabled=false;status.textContent='检测到声音，准备好后开始录音。';}},80);
      reminder=setTimeout(()=>{if(!seen&&!needsActivation)status.textContent='暂未检测到声音。请靠近麦克风说话，检查是否静音或选错设备。';},5000);
    }catch{status.textContent='暂时无法检测麦克风。请取消后检查浏览器权限，再试一次。';}
   })();
 });
}
