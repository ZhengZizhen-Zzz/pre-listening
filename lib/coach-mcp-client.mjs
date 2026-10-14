import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

export async function connectCoachTools({timeoutMs=10000}={}) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/coach-mcp.mjs',import.meta.url))],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH||''}});
  const pending=new Map();let nextId=0,closed=false;
  const failAll=()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('演练证据工具连接中断。'));}pending.clear();};
  child.on('error',failAll);child.on('exit',failAll);child.stdin.on('error',failAll);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    try {
      if(Buffer.byteLength(line)>2*1024*1024)throw new Error();
      const msg=JSON.parse(line),p=pending.get(msg.id);if(!p)return;
      clearTimeout(p.timer);pending.delete(msg.id);
      if(msg.error)p.reject(new Error('演练证据工具请求失败。'));else p.resolve(msg.result);
    }catch{failAll();child.kill();}
  });
  const request=(method,params)=>new Promise((resolve,reject)=>{
    if(closed)return reject(new Error('演练证据工具已关闭。'));
    const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error('演练证据读取超时。'));child.kill();},timeoutMs);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  const close=()=>{lines.close();child.stdin.end();child.kill();failAll();};
  try {
    const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'pre-listener-coach',version:'1.0.0'}});
    if(init.protocolVersion!=='2025-11-25'||!init.capabilities?.tools)throw new Error('证据工具版本不兼容。');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const {tools}=await request('tools/list',{});
    return {tools,close,async call(name,args){
      if(!tools.some(t=>t.name===name))throw new Error('未找到对应演练工具。');
      const result=await request('tools/call',{name,arguments:args});
      if(result.isError)throw new Error(result.content?.[0]?.text||'证据读取失败。');
      if(!result.structuredContent)throw new Error('证据工具返回格式不正确。');
      return result.structuredContent;
    }};
  }catch(error){close();throw error;}
}
