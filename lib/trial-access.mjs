import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const fault = (message, status) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const COOKIE = '__Host-rehearsal-trial';
const DAY = 86400000;
// Full rehearsal + 10 voice answers; keep the shared trial budget bounded.
export const TRIAL_OWNER_LIMIT = 24;
export const TRIAL_TOTAL_LIMIT = 400;

export class TrialAccess {
  constructor(directory, { now = Date.now } = {}) { this.directory = directory; this.now = now; this.attempts = []; this.usage = { total: 0, owners: {} }; }
  async init() {
    this.settings = JSON.parse(await readFile(path.join(this.directory, 'access.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(this.settings.passwordHash) || !/^[a-f0-9]{64}$/.test(this.settings.secret)) throw new Error('试用访问配置不完整');
    try { this.usage = JSON.parse(await readFile(path.join(this.directory, 'usage.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!Number.isInteger(this.usage.total) || this.usage.total < 0 || !this.usage.owners || Object.values(this.usage.owners).some(n => !Number.isInteger(n) || n < 0)) throw new Error('试用额度记录异常');
  }
  async origin() {
    let value;
    try { value = (await readFile(path.join(this.directory, 'origin.txt'), 'utf8')).trim(); } catch { throw fault('试用链接正在准备，请稍后刷新。', 503); }
    let url; try { url = new URL(value); } catch { throw fault('试用链接尚未配置。', 503); }
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw fault('试用链接配置异常。', 503);
    return url;
  }
  sign(text) { return createHmac('sha256', this.settings.secret).update(text).digest('base64url'); }
  session(req) {
    const token = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 512) return null;
    const [payload, signature, extra] = token.split('.');
    if (extra || !same(this.sign(payload), signature)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return /^[a-f0-9-]{36}$/.test(data.owner) && Number.isFinite(data.expires) && data.expires > this.now() ? data : null;
    } catch { return null; }
  }
  csrf(owner) { return this.sign(`csrf:${owner}`); }
  login(password, previous) {
    this.attempts = this.attempts.filter(time => this.now() - time < 60000);
    if (this.attempts.length >= 20) throw fault('尝试过于频繁，请一分钟后再试。', 429);
    this.attempts.push(this.now());
    if (!same(digest(password), this.settings.passwordHash)) throw fault('试用密码不正确，请重新输入。', 401);
    const session = { owner: previous?.owner || randomUUID(), expires: this.now() + DAY };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    return `${COOKIE}=${payload}.${this.sign(payload)}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`;
  }
  async consume(owner) {
    // Called under the server's submission lock. Persist before a billable call.
    if (this.usage.total >= TRIAL_TOTAL_LIMIT) throw fault('本轮试用额度已用完，请联系邀请你的朋友。', 429);
    if ((this.usage.owners[owner] || 0) >= TRIAL_OWNER_LIMIT) throw fault('你本轮的试用次数已用完，请联系邀请你的朋友。', 429);
    this.usage.total++; this.usage.owners[owner] = (this.usage.owners[owner] || 0) + 1;
    const file = path.join(this.directory, 'usage.json');
    await writeFile(`${file}.tmp`, JSON.stringify(this.usage), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}

export function loginPage(message = '') {
  const safe = message.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pre聆听大师 · 朋友试用</title><style>body{margin:0;background:#f7f6f2;color:#222;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center}main{box-sizing:border-box;width:min(440px,90vw);padding:36px;background:white;border:1px solid #deded7;border-radius:18px}h1{font-size:28px;margin:0 0 12px}p{color:#65665f}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;font:inherit;border-radius:8px;padding:12px}input{border:1px solid #bbb}button{margin-top:16px;background:#315d4d;color:white;border:0;cursor:pointer}.note{font-size:13px;margin-bottom:0}.error{color:#a32d21}</style><main><h1>Pre聆听大师</h1><p>上传汇报材料，试讲一次，看看哪里能讲得更清楚。</p><form method="post" action="/trial-login"><label for="password">朋友发给你的试用密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="100"><button type="submit">进入试用</button><p id="login-message" role="alert" class="error">${safe}</p></form><p class="note">材料与录音保存在你的浏览器中。转换、识别或分析时，所需内容会发送到开发者的服务及对应的 AI 服务。请使用可用于试用的材料。复盘可由你主动提交给开发者，用于改进产品。</p></main><script type="module" src="/trial-login.mjs"></script></html>`;
}
