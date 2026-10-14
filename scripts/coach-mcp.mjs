// Narrow, stateless MCP stdio server, protocol 2025-11-25. No filesystem/network tools.
import {createInterface} from 'node:readline';
import {coachTools,callCoachTool} from '../lib/coach-tools.mjs';
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
let initialized=false,ready=false;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
for await (const line of lines) {
  let message;
  try {if(Buffer.byteLength(line)>2*1024*1024)throw new Error();message=JSON.parse(line);}
  catch {send({id:null,error:{code:-32700,message:'Parse error'}});continue;}
  const id=message?.id;
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(id!==undefined&&typeof id!=='number'&&typeof id!=='string')) {send({id:null,error:{code:-32600,message:'Invalid Request'}});continue;}
  if(message.method==='notifications/initialized'&&id===undefined){ready=initialized;continue;}
  if(id===undefined)continue;
  if(message.method==='initialize'){
    if(initialized){send({id,error:{code:-32600,message:'Already initialized'}});continue;}
    initialized=true;
    send({id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'pre-listener-evidence',version:'1.0.0'}}});continue;
  }
  if(message.method==='ping'){send({id,result:{}});continue;}
  if(!ready){send({id,error:{code:-32002,message:'Not initialized'}});continue;}
  if(message.method==='tools/list'){send({id,result:{tools:coachTools}});continue;}
  if(message.method==='tools/call'){
    if(!coachTools.some(t=>t.name===message.params?.name)){send({id,error:{code:-32602,message:'Unknown tool'}});continue;}
    try {const result=callCoachTool(message.params.name,message.params.arguments);send({id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false}});}
    catch(error){send({id,result:{content:[{type:'text',text:error.message}],isError:true}});}
    continue;
  }
  send({id,error:{code:-32601,message:'Method not found'}});
}
