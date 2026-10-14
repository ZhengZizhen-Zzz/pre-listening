// Only wrap reads of an existing task. Never repeat a billable submission here.
export async function retryRead(read,{pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  for(let attempt=0;;attempt++) {
    try{return await read();}
    catch(error){
      const transient=error.retryable||['TimeoutError','TypeError'].includes(error.name)||[408,502,503,504,524].includes(error.status);
      if(attempt>=2||!transient||[401,403,404,410,429].includes(error.status))throw error;
      await pause(500*(attempt+1));
    }
  }
}
