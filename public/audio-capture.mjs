import {checkMicrophone} from './microphone-check.mjs';
export async function getRecordingStream(){
  document.querySelectorAll('audio').forEach(player=>player.pause());
  const stream=await navigator.mediaDevices.getUserMedia({audio:true});
  try{return await checkMicrophone(stream);}catch(error){stream.getTracks().forEach(track=>track.stop());throw error;}
}
