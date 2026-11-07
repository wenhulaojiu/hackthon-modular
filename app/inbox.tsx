'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,FileText,Upload} from 'lucide-react';
import type {PageId,SharedProps} from '../lib/types';
import {parseChatImport} from '../lib/domain';
import LocalWechat from './components/local-wechat';

export default function Inbox({state,onChange,notify,onExport}:SharedProps&{go:(id:PageId,customer?:string)=>void;onExport:()=>void}){
 const stateRef=useRef(state);useEffect(()=>{stateRef.current=state},[state]);
 const [tab,setTab]=useState<'extract'|'history'|'exports'>('extract');
 async function importLocalExports(exports:unknown[]):Promise<boolean>{
   if(!exports.length||exports.length>20)throw Error('本次提取结果数量无效，请重新选择私聊');
   const snapshot=stateRef.current;const demoIds=new Set(snapshot.customers.filter(c=>c.source==='demo').map(c=>c.id));
   let next={...snapshot};
   if(snapshot.demo&&demoIds.size){
     if(!window.confirm('首次导入将移除虚构示例客户及其消费、待办。真实导入和手工建立的客户会保留。是否继续？'))return false;
     next={...next,customers:next.customers.filter(c=>!demoIds.has(c.id)),orders:next.orders.filter(o=>!demoIds.has(o.customerId)),tasks:next.tasks.filter(t=>!demoIds.has(t.customerId)),demo:false};
   }
   const warnings:string[]=[];let messages=0;
   for(let i=0;i<exports.length;i++){
     const result=parseChatImport(JSON.stringify(exports[i]),`微信一键提取-${i+1}.json`,next.customers);
     next={...next,customers:result.customers,imports:[result.record,...next.imports],demo:false};messages+=result.record.messageCount;warnings.push(...result.warnings);
   }
   if(!messages)throw Error('所选时间范围内没有可导入消息，现有数据未修改');
   const success=await onChange(next);
   if(success){if(stateRef.current===snapshot)stateRef.current=next;notify(`已同步 ${exports.length} 个私聊、${messages} 条消息。未自动调用 AI`);if(warnings.length)notify(warnings[0]);}
   return success;
 }

 return <>
   <div className="tabs page-tabs"><button className={'tab '+(tab==='extract'?'active':'')} onClick={()=>setTab('extract')}>一键提取</button><button className={'tab '+(tab==='history'?'active':'')} onClick={()=>setTab('history')}>导入记录</button><button className={'tab '+(tab==='exports'?'active':'')} onClick={()=>setTab('exports')}>导出记录</button></div>
   {tab==='extract'&&<LocalWechat onImport={importLocalExports} notify={notify}/>}
   {tab==='history'&&<section className="card"><div className="card-heading"><h2>导入记录</h2><span className="muted">共 {state.imports.length} 次导入</span></div>{state.imports.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>文件</th><th>导入日期</th><th>客户数</th><th>消息数</th></tr></thead><tbody>{state.imports.map(record=><tr key={record.id}><td><FileText size={15}/> {record.fileName}</td><td>{new Date(record.date).toLocaleString('zh-CN')}</td><td>{record.customerCount}</td><td>{record.messageCount}</td></tr>)}</tbody></table></div>:<div className="empty-state"><Upload/><h3>暂无导入记录</h3></div>}</section>}
   {tab==='exports'&&<section className="card"><div className="card-heading"><div><h2>导出记录</h2><p>记录每次发起的文件下载。</p></div><button className="btn primary" onClick={onExport}><ArrowDownToLine size={15}/>导出数据</button></div>{state.exports?.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>文件</th><th>导出时间</th><th>客户数</th><th>消息数</th><th>状态</th></tr></thead><tbody>{state.exports.map(record=><tr key={record.id}><td><FileText size={15}/> {record.fileName}</td><td>{new Date(record.date).toLocaleString('zh-CN')}</td><td>{record.customerCount}</td><td>{record.messageCount}</td><td><span className="badge green">已发起下载</span></td></tr>)}</tbody></table></div>:<div className="empty-state"><ArrowDownToLine/><h3>暂无导出记录</h3></div>}</section>}
 </>;
}
