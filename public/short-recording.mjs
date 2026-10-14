import {watchRecording} from './recording-guard.mjs';
import { getRecordingStream } from './audio-capture.mjs';
import { acquireRecordingLock } from './recording-lock.mjs';

// Own capture lifecycle: it cannot reset a full rehearsal, its clock or transcript.
export async function startShortRecording({onChunk, onTick = () => {}, onError = () => {},
  getStream = getRecordingStream, acquire = acquireRecordingLock, Recorder = globalThis.MediaRecorder,
  now = () => performance.now(), maxSeconds = 300}) {
  const release = await acquire();
  if (!release) throw new Error('另一个页面正在录音，请先结束那次录音。');
  let stream, recorder, timer, began, stopping = false, chain = Promise.resolve(), chunkIndex = 0, failure, stoppedAt, disposeGuard=()=>{};
  const chunks = [];
  const cleanup = () => { clearInterval(timer); disposeGuard(); stream?.getTracks().forEach(track => track.stop()); release(); };
  try {
    stream = await getStream();
    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(mime => Recorder.isTypeSupported(mime));
    if (!mimeType) throw new Error('当前浏览器不支持录音，请使用新版 Chrome 或输入发言。');
    recorder = new Recorder(stream,{mimeType});
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const stop = () => { if (!stopping) { stopping = true; stoppedAt=now(); if (recorder.state !== 'inactive') recorder.stop(); } return done; };
    const fail = error => { if (!failure) { failure = error; onError(error); } stop(); };
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      chunks.push(event.data);
      const index = chunkIndex++, seconds = Math.min(maxSeconds,((stoppedAt??now())-began)/1000);
      chain = chain.then(() => onChunk(event.data,index,seconds)).catch(fail);
    };
    recorder.onerror = () => fail(new Error('录音中断，已保留收到的片段。'));
    recorder.onstop = async () => {
      if(!stopping&&!failure)failure=new Error('录音被系统中断，片段已保留。');
      const seconds = Math.min(maxSeconds,((stoppedAt??now())-began)/1000);
      await chain; cleanup();
      resolveDone({blob:new Blob(chunks,{type:mimeType}),durationSeconds:seconds,error:failure});
    };
    began = now(); recorder.start(500);
    disposeGuard=watchRecording({stream,recorder,onInterrupt:reason=>fail(new Error(reason+'，录音已保存，可继续回答。'))});
    timer = setInterval(() => { const seconds = ((stoppedAt??now())-began)/1000; onTick(seconds); if (seconds >= maxSeconds) stop(); },250);
    return {stop,done};
  } catch (error) { cleanup(); throw error; }
}
