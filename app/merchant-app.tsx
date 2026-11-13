'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ArrowRight,ArrowUpRight,Bell,BookOpen,Bot,CheckCircle2,ChevronDown,ChevronRight,CircleHelp,LayoutDashboard,Loader2,Menu,MessageCircle,Package,Search,Settings2,ShieldCheck,Upload,Users,X} from 'lucide-react';
import type {AIResult,AiAction,AppState,ExportRecord,PageId,SharedProps} from '../lib/types';
import {today} from '../lib/domain';
import {day} from '../页面模块/09-公共工具与样式/ui';
import Customers from '../页面模块/02-客户档案/customers';
import Settings from '../页面模块/07-AI与设置/settings';
import Overview from '../页面模块/01-总览/overview';
import Marketing from '../页面模块/03-客户跟进/marketing';
import Inbox from '../页面模块/04-微信数据/inbox';
import AutoReply from '../页面模块/05-自动回复/auto-reply';
import Products from '../页面模块/06-商品与服务/products';
import DataExport from '../页面模块/08-数据导出/data-export';
import KnowledgeBase from '../页面模块/10-知识库/knowledge-base';
import Campaign from '../页面模块/11-新活动/campaign';
import {assertWorkspaceCurrent,captureWorkspace,getWorkspaceInvalidation,registerWorkspaceController,setWorkspaceToken,subscribeWorkspaceInvalidation,workspaceFetch,type WorkspaceSnapshot} from '../lib/client-workspace';
import {mergeRuntimeEdit,mergeRuntimeRefresh} from '../lib/runtime-state-refresh';

async function json(r:Response){return await r.json() as AIResult & {state:AppState;revision:number;hasApiKey:boolean;error?:string;workspaceToken?:string;code?:string};}
const nav=[{id:'overview',text:'总览',icon:LayoutDashboard},{id:'customers',text:'客户档案',icon:Users},{id:'marketing',text:'客户跟进',icon:MessageCircle},{id:'inbox',text:'微信数据',icon:Upload},{id:'auto-reply',text:'自动回复',icon:Bot},{id:'products',text:'商品与服务',icon:Package},{id:'knowledge',text:'知识库',icon:BookOpen},{id:'settings',text:'AI 与设置',icon:Settings2}] as const;
export default function MerchantApp({displayName}:{displayName:string}){
  const [state,setState]=useState<AppState|null>(null),[page,setPage]=useState<PageId>('overview'),[selectedId,setSelectedId]=useState<string|null>(null),[hasApiKey,setHasApiKey]=useState(false),[saveStatus,setSaveStatus]=useState('正在加载'),[loadError,setLoadError]=useState(''),[toast,setToast]=useState<{text:string;error:boolean}|null>(null),[mobileNav,setMobileNav]=useState(false),[exportOpen,setExportOpen]=useState(false);
  const [workspace,setWorkspace]=useState<WorkspaceSnapshot|null>(null),[workspaceError,setWorkspaceError]=useState('');
  const revision=useRef(0),saved=useRef<AppState|null>(null),queue=useRef(Promise.resolve()),blocked=useRef(false),edits=useRef(0);
  const loadController=useRef<AbortController|null>(null);
  const pendingSaves=useRef(0),enrolledCustomers=useRef(new Map<string,AppState['customers'][number]>());
  function notify(text:string,error=false){setToast({text,error})}
  useEffect(()=>{if(!toast)return;const id=setTimeout(()=>setToast(null),4500);return()=>clearTimeout(id)},[toast]);
  async function load(){setLoadError('');loadController.current?.abort();const controller=new AbortController();loadController.current=controller;const unregister=registerWorkspaceController(controller);try{const r=await fetch('/api/state',{signal:controller.signal,cache:'no-store'});const d=await json(r);if(controller.signal.aborted||getWorkspaceInvalidation())return;if(!r.ok)throw Error(d.error||'数据加载失败');setWorkspaceToken(d.workspaceToken||'legacy@1');setWorkspace(captureWorkspace());revision.current=d.revision;saved.current=d.state;blocked.current=false;setState(d.state);setHasApiKey(d.hasApiKey);setSaveStatus('已保存')}catch(e){if(!controller.signal.aborted)setLoadError((e as Error).message)}finally{unregister()}}
  useEffect(()=>{const unsubscribe=subscribeWorkspaceInvalidation(message=>{blocked.current=true;loadController.current?.abort();setWorkspaceError(message);setSaveStatus('账号已切换');setExportOpen(false)});void load();return()=>{unsubscribe();loadController.current?.abort()}},[]);
  useEffect(()=>{
    if(!workspace||window.location.protocol!=='http:'||!['127.0.0.1','localhost'].includes(window.location.hostname))return;
    const controller=new AbortController();let refreshing=false;
    const refresh=()=>{if(refreshing||pendingSaves.current||blocked.current||!saved.current)return;refreshing=true;const base=saved.current,edit=edits.current;void (async()=>{try{
      const response=await workspaceFetch('/api/state',{signal:controller.signal,cache:'no-store'},workspace);const remote=await json(response);assertWorkspaceCurrent(workspace);
      if(!response.ok||controller.signal.aborted||pendingSaves.current||edits.current!==edit||saved.current!==base||remote.revision<=revision.current)return;
      // 仅刷新自动建档或已确认恢复的接管标记，其他业务修改继续保持冲突提示。
      const merged=mergeRuntimeRefresh(base,remote.state);if(!merged)return;
      for(const customer of merged.customers)if(!base.customers.some(old=>old.id===customer.id))enrolledCustomers.current.set(customer.id,customer);
      saved.current=remote.state;revision.current=remote.revision;setState(remote.state);
    }catch{/* 后台刷新失败不影响已保存的客户和当前表单。 */}finally{refreshing=false}})()};
    const timer=setInterval(refresh,5000);window.addEventListener('kexu-runtime-state-updated',refresh);
    return()=>{clearInterval(timer);window.removeEventListener('kexu-runtime-state-updated',refresh);controller.abort()};
  },[workspace]);
  function currentWorkspace(){if(!workspace)throw Error('工作空间尚未加载');assertWorkspaceCurrent(workspace);return workspace}
  function onChange(next:AppState,options?:{clearBusinessData?:boolean}){
    let expected:WorkspaceSnapshot;try{expected=currentWorkspace()}catch(e){notify((e as Error).message,true);return Promise.resolve(false)}
    if(new TextEncoder().encode(JSON.stringify(next)).length>1450000){notify('当前数据已接近体验版容量，请减少聊天条数后重试',true);return Promise.resolve(false)}
    if(blocked.current){notify('保存存在冲突，请刷新后重新操作',true);return Promise.resolve(false)}
    // 使用发起编辑那次渲染的基线，异步暂停期间后台新建的客户不能被当作用户主动删除。
    const baseAtEdit=state||saved.current;setState(next);setSaveStatus('保存中');const edit=++edits.current;pendingSaves.current++;
    queue.current=queue.current.then(async()=>{
      assertWorkspaceCurrent(expected);if(blocked.current)return;let candidate=next;
      // 已排队的旧编辑也必须保留在它之后才被后台发现的新客户；明确删除已有客户仍照常生效。
      const additions=[...enrolledCustomers.current.values()].filter(customer=>!baseAtEdit?.customers.some(old=>old.id===customer.id)&&!candidate.customers.some(old=>old.id===customer.id||old.wechatId===customer.wechatId));
      if(!options?.clearBusinessData&&additions.length&&candidate.replySettings)candidate={...candidate,demo:false,customers:[...candidate.customers,...additions],replySettings:{...candidate.replySettings,selectedCustomerIds:[...new Set([...candidate.replySettings.selectedCustomerIds,...additions.map(customer=>customer.id)])]}};
      let base=saved.current;
      for(let attempt=0;attempt<3;attempt++){
        const r=await workspaceFetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:candidate,revision:revision.current})},expected);const d=await json(r);assertWorkspaceCurrent(expected);
        if(r.ok){revision.current=d.revision;saved.current=candidate;if(options?.clearBusinessData)enrolledCustomers.current.clear();else for(const id of enrolledCustomers.current.keys())if(baseAtEdit?.customers.some(customer=>customer.id===id)&&!candidate.customers.some(customer=>customer.id===id))enrolledCustomers.current.delete(id);if(edit===edits.current){setState(candidate);setSaveStatus('已保存')}return}
        if(r.status!==409||!base||attempt===2)throw Error(d.error||'保存失败');
        const latestResponse=await workspaceFetch('/api/state',{cache:'no-store'},expected),latest=await json(latestResponse);assertWorkspaceCurrent(expected);
        const merged=latestResponse.ok?mergeRuntimeEdit(base,candidate,latest.state):null;if(!merged)throw Error(d.error||'保存冲突');
        for(const customer of latest.state.customers)if(!base.customers.some(old=>old.id===customer.id))enrolledCustomers.current.set(customer.id,customer);
        candidate=options?.clearBusinessData?{...merged,customers:[],orders:[],tasks:[],imports:[],exports:[],replySettings:merged.replySettings?{...merged.replySettings,enabled:false,selectedCustomerIds:[]}:undefined}:merged;base=latest.state;revision.current=latest.revision;
      }
    }).catch(e=>{blocked.current=true;setSaveStatus(getWorkspaceInvalidation()?'账号已切换':'保存失败');if(saved.current)setState(saved.current);if(!getWorkspaceInvalidation())notify(e.message+'，请刷新后重试',true)}).finally(()=>{pendingSaves.current--});
    return queue.current.then(()=>!blocked.current);
  }
  async function onAI(action:AiAction,customerId?:string):Promise<AIResult>{const expected=currentWorkspace();await queue.current;assertWorkspaceCurrent(expected);if(blocked.current)throw Error('请先解决保存冲突');const r=await workspaceFetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,customerId})},expected);const d=await json(r);assertWorkspaceCurrent(expected);if(!r.ok)throw Error(d.error||'AI 请求失败');return d}
  async function onSaveKey(apiKey:string,remove?:boolean){const expected=currentWorkspace();const r=await workspaceFetch('/api/secret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey,remove})},expected);const d=await json(r);assertWorkspaceCurrent(expected);if(!r.ok)throw Error(d.error||'密钥保存失败');setHasApiKey(!remove)}
  async function prepareExportState():Promise<AppState>{
    const expected=currentWorkspace();
    // 等待保存队列完成，避免把保存失败或尚未持久化的乐观状态当成已保存数据。
    await queue.current;
    assertWorkspaceCurrent(expected);
    if(blocked.current||!saved.current)throw Error('请先解决数据保存问题，再导出工作空间数据');
    return structuredClone(saved.current);
  }
  async function recordExport(record:ExportRecord):Promise<boolean>{await queue.current;if(blocked.current||!saved.current)return false;return onChange({...saved.current,exports:[record,...(saved.current.exports||[])].slice(0,500)})}
  function go(id:PageId,customer?:string){setPage(id);setMobileNav(false);if(customer)setSelectedId(customer);window.scrollTo({top:0,behavior:'auto'})}
  if(!state)return <div className="loading-screen"><div className="brand-mark"><MessageCircle size={25}/></div>{loadError?<><h2>暂时无法加载工作台</h2><p>{loadError}</p><button className="btn primary" onClick={load}>重新加载</button></>:<><Loader2 className="spin" size={24}/><p>正在准备你的经营工作台…</p></>}</div>;
  const props:SharedProps={state,onChange,notify,onAI};const dueCount=state.tasks.filter(t=>t.status==='todo'&&day(t.date)<=today()).length;
  return <div className="app-shell">{mobileNav&&<div className="mobile-scrim" onClick={()=>setMobileNav(false)}/>}<aside className={'sidebar '+(mobileNav?'open':'')}>
    <a className="brand" href="#" onClick={e=>{e.preventDefault();go('overview')}}><span className="brand-mark"><MessageCircle size={22}/></span><span>客序<span className="brand-en">KEXU</span></span></a>
    <nav>{nav.map(n=><button key={n.id} className={'nav-item '+(page===n.id?'active':'')} onClick={()=>go(n.id)}><n.icon size={19}/><span>{n.text}</span>{n.id==='marketing'&&dueCount>0&&<span className="nav-count">{dueCount}</span>}</button>)}</nav>
    </aside>
    <div className="workspace">
    <main className="main-content"><div className="page-heading"><div><h1>{page==='overview'?'总览':page==='campaign'?'新活动':nav.find(n=>n.id===page)?.text}</h1></div><div className="heading-actions"><button className="icon-button mobile-menu" onClick={()=>setMobileNav(true)} aria-label="展开菜单"><Menu size={20}/></button>{saveStatus==='保存失败'&&<span className="save-label error" role="alert">保存失败</span>}</div></div>
    {workspaceError&&<div className="workspace-changed-banner" role="alert"><div><strong>请重新加载微信数据工作空间</strong><p>{workspaceError}</p></div><button className="btn primary" onClick={()=>window.location.reload()}>刷新工作空间</button></div>}
    <div inert={!!workspaceError}>{page==='overview'&&<Overview {...props} go={go}/>} {page==='customers'&&<Customers {...props} selectedId={selectedId} onSelect={setSelectedId}/>} {page==='marketing'&&<Marketing {...props} go={go}/>} {page==='inbox'&&<Inbox {...props} go={go} onExport={()=>setExportOpen(true)}/>} {page==='auto-reply'&&<AutoReply {...props}/>} {page==='products'&&<Products {...props}/>} {page==='knowledge'&&<KnowledgeBase {...props}/>} {page==='campaign'&&<Campaign {...props} go={go}/>} {page==='settings'&&<Settings {...props} hasApiKey={hasApiKey} onSaveKey={onSaveKey} onExport={()=>setExportOpen(true)}/>}</div>
    </main></div><DataExport state={state} open={exportOpen} onClose={()=>setExportOpen(false)} notify={notify} prepareState={prepareExportState} onExported={recordExport}/>{toast&&<div className={'toast '+(toast.error?'error':'')} role="status">{toast.error?<CircleHelp size={18}/>:<CheckCircle2 size={18}/>}<span>{toast.text}</span><button onClick={()=>setToast(null)} aria-label="关闭通知"><X size={15}/></button></div>}</div>;
}
