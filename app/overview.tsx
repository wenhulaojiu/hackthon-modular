'use client';
import {useId,useState} from 'react';
import {ArrowRight,ArrowUpRight,CalendarDays,TrendingUp,UserRound,Users,Wallet} from 'lucide-react';
import {currency,overviewStats,shiftDate} from '../lib/domain';
import type {PageId,SharedProps} from '../lib/types';
import {day,humanDate} from './ui';
export default function Overview({state,go}:SharedProps&{go:(id:PageId,customer?:string)=>void}){
 const [range,setRange]=useState(7),[metric,setMetric]=useState<'revenue'|'customers'>('revenue');const stats=overviewStats(state,range);
 const values=metric==='revenue'?stats.series.map(s=>s.netRevenue):stats.series.map(s=>state.customers.filter(c=>day(c.createdAt)===s.date).length);
 const areaPattern=useId();
 const high=Math.max(...values,1), low=Math.min(...values,0);
 const y=(value:number)=>24+(high-value)/(high-low)*156;
 const zero=y(0), step=600/Math.max(values.length-1,1), x=(index:number)=>values.length===1?367:67+index*step;
 const line=values.map((value,index)=>`${index?'L':'M'}${x(index)},${y(value)}`).join(' ');
 const area=values.length?`${line} L${x(values.length-1)},${zero} L${x(0)},${zero} Z`:'';
 const axisFormatter=new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1});
 const ticks=[low,(high+low)/2,high];
 if(low<0&&!ticks.includes(0))ticks.push(0);
 const recentOrders=state.orders.filter(order=>order.status==='confirmed').sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id)).slice(0,5);
 return <><div className="stats-grid"><Stat label="客户总数" value={state.customers.length.toString()} unit="位" icon={Users} color="green" note="当前工作空间已记录的客户档案"/><Stat label={`近 ${range} 天新增客户`} value={stats.newCustomers.toString()} unit="位" icon={TrendingUp} color="green" note={`${humanDate(shiftDate(1-range))} — 今天`}/><Stat label="今日净营业额" value={currency(stats.todayRevenue).replace(/[¥￥]/g,'')} unit="元" icon={Wallet} color="amber" note="仅统计已确认的消费与退款"/><Stat label="今日待跟进" value={stats.dueTasks.toString()} unit="项" icon={CalendarDays} color="blue" note={`${stats.pendingCount} 笔消费待确认`} action={()=>go('marketing')}/></div>
 <div className="overview-middle"><section className="card trend-card"><div className="card-heading"><div><h2>经营趋势</h2><p>{metric==='revenue'?'已确认消费减去退款后的净收入':'按首次建档日期统计的新增客户'}</p></div><div className="range-toggle"><button className={range===7?'active':''} onClick={()=>setRange(7)}>近7天</button><button className={range===30?'active':''} onClick={()=>setRange(30)}>近30天</button></div></div><div className="chart-summary"><strong>{metric==='revenue'?currency(stats.netRevenue):stats.newCustomers}<small>{metric==='revenue'?'区间净营业额':'区间新增客户'}</small></strong><div className="chart-legend"><button className={metric==='revenue'?'active':''} onClick={()=>setMetric('revenue')}><i/>营业额</button><button className={metric==='customers'?'active':''} onClick={()=>setMetric('customers')}><i/>新增客户</button></div></div><div className="chart-area">
  <svg viewBox="0 0 680 225" role="img" aria-label={metric==='revenue'?'每日净营业额折线图':'每日新增客户折线图'}>
   <defs>
    <pattern id={areaPattern} width="6" height="6" patternUnits="userSpaceOnUse"><circle className="chart-pattern-dot" cx="2" cy="2" r="1" fill="currentColor" opacity=".25"/></pattern>
   </defs>
   {ticks.map(value=><g key={value}>
    <line className={value===0?'chart-zero':'chart-gridline'} x1="67" x2="667" y1={y(value)} y2={y(value)}/>
    <text className="chart-axis" x="57" y={y(value)+4} textAnchor="end">{axisFormatter.format(value)}</text>
   </g>)}
   {area&&<path className="chart-area-fill" d={area} fill={'url(#'+areaPattern+')'}/>}
   {line&&<path className="chart-line" d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>}
   {values.map((value,index)=>{
    const center=x(index);
    const last=index===values.length-1, showLabel=range===7||index%5===0||last;
    const mobileLabel=range===7?index%2===0:index===0||index===15||last;
    return <g key={stats.series[index].date}>
     <circle className="chart-dot" cx={center} cy={y(value)} r={range===7?3:2} fill="#fff" stroke="currentColor" strokeWidth="1.5"><title>{stats.series[index].date} · {metric==='revenue'?currency(value):value+' 位'}</title></circle>
     {showLabel&&<text className={'chart-axis'+(mobileLabel?'':' chart-axis-mobile-hide')} x={center} y="210" textAnchor="middle">{stats.series[index].date.slice(5).replace('-','/')}</text>}
    </g>;
   })}
  </svg>
 </div></section>
 <section className="card recent-card"><div className="card-heading"><div><h2>最近经营记录</h2><p>最近已确认的销售与退款</p></div><button className="icon-button" onClick={()=>go('inbox')} aria-label="核对消费与退款"><ArrowUpRight size={17}/></button></div>{recentOrders.length?<div className="recent-list">{recentOrders.map(order=>{
  const customer=state.customers.find(item=>item.id===order.customerId);
  const refund=order.type==='refund';
  return <button type="button" className="recent-row" key={order.id} onClick={()=>go('customers',order.customerId)} aria-label={`${customer?.name||'客户'}，${refund?'退款':'销售'}，${humanDate(order.date)}，${currency(order.amount)}`}>
   <span className="recent-avatar" aria-hidden="true"><UserRound size={18}/></span>
   <span className="recent-person"><strong>{customer?.name||'客户'}</strong><small>{refund?'退款':'销售'} · {humanDate(order.date)}</small></span>
   <span className={'recent-amount '+(refund?'refund':'sale')}>{refund?'−':'+'}{currency(order.amount)}</span>
  </button>;
 })}</div>:<div className="empty-state recent-empty"><Wallet size={27}/><h3>暂无已确认的经营记录</h3><p>确认消费或退款后，将在这里显示。</p></div>}</section></div>
 </>;
}
function Stat({label,value,unit,icon:Icon,color,note,action}:{label:string;value:string;unit:string;icon:typeof Users;color:string;note:string;action?:()=>void}){
 const content=<><span className="stat-top"><span>{label}</span><span className={'stat-icon '+color}><Icon size={19} strokeWidth={1.7}/></span></span><span className="stat-value">{value}<small>{unit}</small></span><span className="stat-footer"><span className="stat-note">{note}</span>{action&&<ArrowRight size={14}/>}</span></>;
 return action ? <button type="button" className="stat-card clickable" onClick={action}>{content}</button> : <section className="stat-card">{content}</section>;
}
