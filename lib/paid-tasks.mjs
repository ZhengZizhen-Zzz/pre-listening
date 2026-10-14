// Quota journal writes remain serial. Independent visitors can work in parallel,
// while duplicate foreground requests from one visitor are rejected before billing.
export class PaidTasks {
  constructor(admit,{maxForeground=1}={}){this.admit=admit;this.maxForeground=maxForeground;this.admissions=Promise.resolve();this.owners=new Set();this.background=false;}
  get foreground(){return this.owners.size>0;}
  async acquire(owner,{background=false}={}){
    if(background?(this.background||this.owners.size>=this.maxForeground):(this.owners.has(owner)||this.owners.size>=this.maxForeground))throw Object.assign(new Error(this.owners.has(owner)?'你上一个任务仍在处理，请稍后继续。':'当前同时使用的人较多，请稍后重试；已有内容已保留。'),{status:409});
    if(background)this.background=true;else this.owners.add(owner);
    const clear=()=>{if(background)this.background=false;else this.owners.delete(owner);};
    const admission=this.admissions.catch(()=>{}).then(()=>this.admit(owner));this.admissions=admission;
    try{await admission;}catch(error){clear();throw error;}
    let released=false;
    return ()=>{if(!released){released=true;clear();}};
  }
  async run(task,owner,options){const release=await this.acquire(owner,options);try{return await task();}finally{release();}}
}
