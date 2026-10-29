import { useEffect, useRef, useState } from "react";
import type { HostingNode, HostingPolicy, HostingState } from "../shared/hosting.js";
import type { AdminConfirm } from "./AdminPanel.js";
const names: Record<HostingNode,string>={vps:"한국 VPS",pc:"내 컴퓨터"};
const when=(v:string|null)=>v?new Date(v).toLocaleString("ko-KR"):"기록 없음";

export function HostingPanel({confirm}:{confirm:(request:AdminConfirm)=>void}) {
  const [state,setState]=useState<HostingState|null>(null);
  const [draft,setDraft]=useState<HostingPolicy|null>(null);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const initialized=useRef(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  useEffect(()=>{
    let live=true;
    const load=async()=>{
      try {
        const next=await window.bweeep.adminHosting();
        if(!live)return;
        setState(next);
        if(!initialized.current){setDraft(next.policy);setRevision(next.revision);initialized.current=true;}
      }catch(e){if(live)setError(e instanceof Error?e.message:"서버 운영 정보를 불러오지 못했어요.");}
    };
    void load();
    const timer=setInterval(()=>void load(),15000);
    return ()=>{live=false;clearInterval(timer);};
  },[]);
  async function reload(){
    setBusy(true);setError("");
    try {const s=await window.bweeep.adminHosting();setState(s);setDraft(s.policy);setRevision(s.revision);initialized.current=true;}
    catch(e){setError(e instanceof Error?e.message:"새로고침하지 못했어요.");}
    finally{setBusy(false);}
  }
  async function save(){
    if(!draft)return;
    setBusy(true);setError("");setMessage("");
    try {
      const s=await window.bweeep.configureHosting(draft,revision);
      setState(s);setDraft(s.policy);setRevision(s.revision);initialized.current=true;setMessage("전환 조건을 저장했어요.");
    }catch(e){setError(e instanceof Error?e.message:"저장하지 못했어요.");}
    finally{setBusy(false);}
  }
  function switchTo(node:HostingNode){
    confirm({title:names[node]+"로 전환 요청",body:"접속 중인 사람이 없는지 먼저 확인해 주세요. 현재 서버의 접속을 닫고 최신 월드를 동기화한 뒤 전환해요. 동기화나 운영 권한을 확인하지 못하면 전환을 보류해요.",confirmLabel:"전환 요청",onConfirm:()=>{
      setBusy(true);setError("");
      void window.bweeep.requestHostingSwitch(node).then(s=>{setState(s);setMessage("전환 요청을 전달했어요. 완료 상태를 확인해 주세요.");}).catch(e=>setError(e instanceof Error?e.message:"전환을 요청하지 못했어요.")).finally(()=>setBusy(false));
    }});
  }
  if(!state || !draft)return <section className="panel"><h3>서버 운영</h3><p role={error?"alert":"status"}>{error||"운영 상태를 불러오는 중…"}</p><button className="textButton" disabled={busy} onClick={()=>void reload()}>다시 불러오기</button></section>;
  const invalid=![draft.failureSeconds,draft.syncMinutes,draft.maxSnapshotMinutes].every(Number.isInteger)||draft.failureSeconds<90||draft.failureSeconds>1800||draft.syncMinutes<1||draft.syncMinutes>60||draft.maxSnapshotMinutes<draft.syncMinutes||draft.maxSnapshotMinutes>120||(draft.automatic&&!draft.allowRecovery);
  return <section className="panel hostingPanel">
    <div className="panelHeader"><h3>서버 운영</h3><button className="textButton" disabled={busy} onClick={()=>void reload()}>새로고침</button></div>
    <p>현재 운영: <strong>{names[state.activeNode]}</strong></p>
    {state.requestedNode&&<p role="status">{names[state.requestedNode]}로 전환을 기다리고 있어요. <button className="textButton" disabled={busy} onClick={()=>{
      setBusy(true);setError("");
      void window.bweeep.requestHostingSwitch(state.activeNode).then(s=>{setState(s);setMessage("전환 요청을 취소했어요.");}).catch(e=>setError(e instanceof Error?e.message:"요청을 취소하지 못했어요.")).finally(()=>setBusy(false));
    }}>전환 요청 취소</button></p>}
    <div className="hostingNodes">{(["vps","pc"] as const).map(node=>{
      const s=state.nodes.find(n=>n.node===node);
      const connected=Boolean(s?.lastSeen&&Date.now()-Date.parse(s.lastSeen)<30000);
      const ready=s?.snapshotEpoch===state.epoch&&s.snapshotSource===state.activeNode&&Boolean(s.snapshotAt&&Date.now()-Date.parse(s.snapshotAt)<state.policy.maxSnapshotMinutes*60000);
      const status=!connected?"연결 확인 필요":s?.status==="active"&&state.activeNode===node?"운영 중":s?.status==="syncing"?"월드 동기화 중":ready?"보조 서버 준비됨":state.activeNode===node?"전환 준비 중":"대기 중";
      return <article className="adminRow" key={node}><div className="adminRowText"><strong>{names[node]}</strong><small>마지막 연결: {when(s?.lastSeen??null)}</small><small>동기화 완료: {when(s?.snapshotAt??null)}</small><small>{status}</small></div><button className="textButton" disabled={busy||state.activeNode===node||state.requestedNode!==null} onClick={()=>switchTo(node)}>이 서버로 전환</button></article>;
    })}</div>
    <fieldset className="hostingFields" disabled={busy}>
      <legend>우선순위와 자동 전환</legend>
      <label>1순위<select value={draft.primaryNode} onChange={e=>setDraft({...draft,primaryNode:e.target.value as HostingNode})}><option value="vps">한국 VPS</option><option value="pc">내 컴퓨터</option></select></label>
      <p>2순위: {names[draft.primaryNode==="vps"?"pc":"vps"]}. 1순위를 바꿔 저장하면 해당 서버로 전환을 요청해요.</p>
      <label><input type="checkbox" checked={draft.automatic} onChange={e=>setDraft({...draft,automatic:e.target.checked})}/>장애 시 자동 전환</label>
      <label>운영 권한 만료 후 장애 확인 시간 (초)<input type="number" min={90} max={1800} step={30} value={draft.failureSeconds} onChange={e=>setDraft({...draft,failureSeconds:Number(e.target.value)})}/></label>
      <label>월드 동기화 간격 (분)<input type="number" min={1} max={60} value={draft.syncMinutes} onChange={e=>setDraft({...draft,syncMinutes:Number(e.target.value)})}/></label>
      <label>복구에 허용할 동기화본 경과 시간 (분)<input type="number" min={draft.syncMinutes} max={120} value={draft.maxSnapshotMinutes} onChange={e=>setDraft({...draft,maxSnapshotMinutes:Number(e.target.value)})}/></label>
      <label><input type="checkbox" checked={draft.allowRecovery} onChange={e=>setDraft({...draft,allowRecovery:e.target.checked})}/>장애 전환 때 마지막 동기화 이후 진행 내용이 사라질 수 있음을 확인했어요.</label>
    </fieldset>
    <p>보조 컴퓨터가 켜져 있고 최근 동기화본이 있어야 전환할 수 있어요. VPS 복구 후에는 위의 전환 버튼으로 최신 월드를 맞춘 뒤 복귀해 주세요.</p>
    {invalid&&<p role="alert">입력 범위와 동기화 간격을 확인해 주세요. 자동 전환에는 마지막 동기화본 복구 동의가 필요해요.</p>}
    <button className="primaryButton" disabled={busy||invalid} onClick={()=>void save()}>설정 저장</button>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  </section>;
}
