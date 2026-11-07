'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ArrowRight,ArrowUpRight,Bell,Bot,CheckCircle2,ChevronDown,ChevronRight,CircleHelp,LayoutDashboard,Loader2,Menu,MessageCircle,Package,Plus,Search,Settings2,ShieldCheck,Sparkles,Upload,Users,X} from 'lucide-react';
import type {AIResult,AiAction,AppState,PageId,SharedProps} from '../lib/types';
import {today} from '../lib/domain';
import {day} from './ui';
import Customers from './components/customers';
import Settings from './components/settings';
import Overview from './overview';
import Marketing from './marketing';
import Inbox from './inbox';
import AutoReply from './components/auto-reply';
import Products from './components/products';
import DataExport from './components/data-export';
import {assertWorkspaceCurrent,captureWorkspace,getWorkspaceInvalidation,registerWorkspaceController,setWorkspaceToken,subscribeWorkspaceInvalidation,workspaceFetch,type WorkspaceSnapshot} from '../lib/client-workspace';

async function json(r:Response){return await r.json() as AIResult & {state:AppState;revision:number;hasApiKey:boolean;error?:string;workspaceToken?:string;code?:string};}
const nav=[{id:'overview',text:'经营总览',icon:LayoutDashboard},{id:'customers',text:'客户管理',icon:Users},{id:'marketing',text:'营销与跟进',icon:MessageCircle},{id:'inbox',text:'微信数据',icon:Upload},{id:'auto-reply',text:'自动回复',icon:Bot},{id:'products',text:'商品与服务',icon:Package},{id:'settings',text:'AI 与设置',icon:Settings2}] as const;
export default function MerchantApp({displayName}:{displayName:string}){
  const [state,setState]=useState<AppState|null>(null),[page,setPage]=useState<PageId>('overview'),[selectedId,setSelectedId]=useState<string|null>(null),[hasApiKey,setHasApiKey]=useState(false),[saveStatus,setSaveStatus]=useState('正在加载'),[loadError,setLoadError]=useState(''),[toast,setToast]=useState<{text:string;error:boolean}|null>(null),[search,setSearch]=useState(''),[mobileNav,setMobileNav]=useState(false),[exportOpen,setExportOpen]=useState(false);
  const [workspace,setWorkspace]=useState<WorkspaceSnapshot|null>(null),[workspaceError,setWorkspaceError]=useState('');
  const revision=useRef(0),saved=useRef<AppState|null>(null),queue=useRef(Promise.resolve()),blocked=useRef(false),edits=useRef(0);
  const loadController=useRef<AbortController|null>(null);
  function notify(text:string,error=false){setToast({text,error})}
  useEffect(()=>{if(!toast)return;const id=setTimeout(()=>setToast(null),4500);return()=>clearTimeout(id)},[toast]);
  async function load(){setLoadError('');loadController.current?.abort();const controller=new AbortController();loadController.current=controller;const unregister=registerWorkspaceController(controller);try{const r=await fetch('/api/state',{signal:controller.signal,cache:'no-store'});const d=await json(r);if(controller.signal.aborted||getWorkspaceInvalidation())return;if(!r.ok)throw Error(d.error||'数据加载失败');setWorkspaceToken(d.workspaceToken||'legacy@1');setWorkspace(captureWorkspace());revision.current=d.revision;saved.current=d.state;blocked.current=false;setState(d.state);setHasApiKey(d.hasApiKey);setSaveStatus('已保存')}catch(e){if(!controller.signal.aborted)setLoadError((e as Error).message)}finally{unregister()}}
  useEffect(()=>{const unsubscribe=subscribeWorkspaceInvalidation(message=>{blocked.current=true;loadController.current?.abort();setWorkspaceError(message);setSaveStatus('账号已切换');setExportOpen(false)});void load();return()=>{unsubscribe();loadController.current?.abort()}},[]);
  function currentWorkspace(){if(!workspace)throw Error('工作空间尚未加载');assertWorkspaceCurrent(workspace);return workspace}
  function onChange(next:AppState){
    let expected:WorkspaceSnapshot;try{expected=currentWorkspace()}catch(e){notify((e as Error).message,true);return Promise.resolve(false)}
    if(new TextEncoder().encode(JSON.stringify(next)).length>1450000){notify('当前数据已接近体验版容量，请减少聊天条数后重试',true);return Promise.resolve(false)}
    if(blocked.current){notify('保存存在冲突，请刷新后重新操作',true);return Promise.resolve(false)}
    setState(next);setSaveStatus('保存中');const edit=++edits.current;
    queue.current=queue.current.then(async()=>{assertWorkspaceCurrent(expected);if(blocked.current)return;const r=await workspaceFetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:next,revision:revision.current})},expected);const d=await json(r);assertWorkspaceCurrent(expected);if(!r.ok)throw Error(d.error||'保存失败');revision.current=d.revision;saved.current=next;if(edit===edits.current)setSaveStatus('已保存')}).catch(e=>{blocked.current=true;setSaveStatus(getWorkspaceInvalidation()?'账号已切换':'保存失败');if(saved.current)setState(saved.current);if(!getWorkspaceInvalidation())notify(e.message+'，请刷新后重试',true)});
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
  function go(id:PageId,customer?:string){setPage(id);setMobileNav(false);setSearch('');if(customer)setSelectedId(customer);window.scrollTo({top:0,behavior:'auto'})}
  if(!state)return <div className="loading-screen"><div className="brand-mark"><MessageCircle size={25}/></div>{loadError?<><h2>暂时无法加载工作台</h2><p>{loadError}</p><button className="btn primary" onClick={load}>重新加载</button></>:<><Loader2 className="spin" size={24}/><p>正在准备你的经营工作台…</p></>}</div>;
  const props:SharedProps={state,onChange,notify,onAI};const dueCount=state.tasks.filter(t=>t.status==='todo'&&day(t.date)<=today()).length;
  const found=search.trim()?state.customers.filter(c=>[c.name,c.wechatId,...c.tags,...c.manualTags].join(' ').toLowerCase().includes(search.toLowerCase())).slice(0,5):[];
  return <div className="app-shell">{mobileNav&&<div className="mobile-scrim" onClick={()=>setMobileNav(false)}/>}<aside className={'sidebar '+(mobileNav?'open':'')}>
    <a className="brand" href="#" onClick={e=>{e.preventDefault();go('overview')}}><span className="brand-mark"><MessageCircle size={22}/></span><span>客序<span className="brand-en">KEXU</span></span></a>
    <button className="store-switch" onClick={()=>go('settings')}><span className="store-initial">{state.settings.storeName.slice(0,1)}</span><span><strong>{state.settings.storeName}</strong><small>商家经营工作台</small></span><ChevronDown size={15}/></button><div className="nav-label">工作空间</div>
    <nav>{nav.map(n=><button key={n.id} className={'nav-item '+(page===n.id?'active':'')} onClick={()=>go(n.id)}><n.icon size={19}/><span>{n.text}</span>{n.id==='marketing'&&dueCount>0&&<span className="nav-count">{dueCount}</span>}{n.id==='inbox'&&<span className="nav-new">NEW</span>}</button>)}</nav>
    <div className="sidebar-bottom"><div className="insight-tip"><span className="tip-icon"><Sparkles size={19}/></span><strong>让每一次沟通，更有价值</strong><p>从聊天发现需求，把了解变成恰到好处的服务。</p><button onClick={()=>go('inbox')}>导入微信聊天<ArrowRight size={14}/></button></div><button className="help-link" onClick={()=>{go('inbox');notify('支持普通微信 skill 导出的 JSON、JSONL、CSV 和聊天文本')}}><CircleHelp size={17}/>数据接入指南<ArrowUpRight size={14}/></button><div className="sidebar-footer"><span className="live-dot"/>专属工作空间<span>v1.0</span></div></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={()=>setMobileNav(true)} aria-label="展开菜单"><Menu size={20}/></button><span>工作空间</span><ChevronRight size={14}/><strong>{nav.find(n=>n.id===page)?.text}</strong></div><div className="top-actions"><div className="global-search"><Search size={16}/><input aria-label="搜索客户" placeholder="搜索客户、标签…" value={search} onChange={e=>setSearch(e.target.value)}/><kbd>搜索</kbd>{search&&<div className="search-results">{found.length?found.map(c=><button key={c.id} onClick={()=>go('customers',c.id)}><span className="avatar small" style={{background:c.color+'20',color:c.color}}>{c.name.slice(-2)}</span><span>{c.name}<small>{c.stage}</small></span><ArrowRight size={14}/></button>):<p>没有匹配的客户</p>}</div>}</div><button className="icon-button bell-button" onClick={()=>go('marketing')} aria-label="查看待办提醒"><Bell size={19}/>{dueCount>0&&<i/>}</button><span className="top-divider"/><button className="account-avatar" title={displayName} onClick={()=>go('settings')}>{displayName.slice(0,1).toUpperCase()}</button></div></header>
    <main className="main-content"><div className="page-heading"><div><div className="eyebrow">{({overview:'OVERVIEW',customers:'CUSTOMERS',marketing:'ENGAGEMENT',inbox:'WECHAT DATA','auto-reply':'REPLY CENTER',products:'KNOWLEDGE',settings:'PREFERENCES'})[page]}</div><h1>{nav.find(n=>n.id===page)?.text}{page==='overview'&&<span className="greeting-dot">✦</span>}</h1><p>{({overview:'看见增长，也看见每一位客户的需要。',customers:'把每一次往来，沉淀为更懂客户的档案。',marketing:'在合适的时间，送上一句有温度的关心。',inbox:'让微信里的沟通，成为经营的线索。','auto-reply':'及时回应客户，也把重要的对话留给你。',products:'准确的商品和服务资料，是每一句回复的依据。',settings:'让 AI 用你的方式，理解客户、提供服务。'})[page]}</p></div><div className="heading-actions"><span className={'save-label '+(saveStatus==='保存失败'?'error':'')}>{saveStatus==='保存中'?<Loader2 size={13} className="spin"/>:<CheckCircle2 size={13}/>} {saveStatus}</span><button className="btn secondary global-export-button" disabled={!!workspaceError} onClick={()=>setExportOpen(true)}><ArrowDownToLine size={16}/>导出数据</button>{page==='overview'&&<><button className="btn primary" onClick={()=>go('inbox')}><Plus size={16}/>导入聊天</button></>}</div></div>
    {workspaceError&&<div className="workspace-changed-banner" role="alert"><div><strong>请重新加载微信数据工作空间</strong><p>{workspaceError}</p></div><button className="btn primary" onClick={()=>window.location.reload()}>刷新工作空间</button></div>}
    {state.demo&&<div className="demo-banner"><span><Sparkles size={15}/>当前为示例工作空间，数据仅用于体验。导入真实聊天前，可在设置中清空示例。</span><button onClick={()=>go('settings')}>开始使用<ArrowRight size={13}/></button></div>}
    <div inert={!!workspaceError}>{page==='overview'&&<Overview {...props} go={go}/>} {page==='customers'&&<Customers {...props} selectedId={selectedId} onSelect={setSelectedId}/>} {page==='marketing'&&<Marketing {...props} go={go}/>} {page==='inbox'&&<Inbox {...props} go={go}/>} {page==='auto-reply'&&<AutoReply {...props}/>} {page==='products'&&<Products {...props}/>} {page==='settings'&&<Settings {...props} hasApiKey={hasApiKey} onSaveKey={onSaveKey} onExport={()=>setExportOpen(true)}/>}</div>
    <footer className="content-footer"><span>客序 · 用心经营，日有所长</span><span><ShieldCheck size={12}/>数据保存在你的专属工作空间</span></footer></main></div><DataExport state={state} open={exportOpen} onClose={()=>setExportOpen(false)} notify={notify} prepareState={prepareExportState}/>{toast&&<div className={'toast '+(toast.error?'error':'')} role="status">{toast.error?<CircleHelp size={18}/>:<CheckCircle2 size={18}/>}<span>{toast.text}</span><button onClick={()=>setToast(null)} aria-label="关闭通知"><X size={15}/></button></div>}</div>;
}
