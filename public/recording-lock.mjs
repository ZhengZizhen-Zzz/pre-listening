// Browser-owned locks disappear when a tab closes. An active recording must not
// be recovered or overwritten by a second tab on the same origin.
export async function acquireRecordingLock() {
  if (!navigator.locks) throw new Error('当前浏览器不支持安全录音恢复，请使用新版 Chrome。');
  return new Promise((resolve, reject) => {
    navigator.locks.request('rehearsal-active-recording', { ifAvailable: true }, async lock => {
      if (!lock) { resolve(null); return; }
      await new Promise(release => resolve(release));
    }).catch(reject);
  });
}
