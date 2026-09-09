const socket=io(),$=s=>document.querySelector(s),messages=$("#messages"),people=$("#peopleList");
let myName=localStorage.getItem("btc_name")||"",myId=null,room="tamil-friends",selectedId=null,selectedName="",privateTarget=null,pending=null,local=null,active=null,peers=new Map();

const meta={ "tamil-friends":["🦋 Tamil Friends","Public live chat • தமிழில் பேசலாம்"],"fm-lounge":["🎵 FM Lounge","Music & chat"],"love-corner":["❤️ Love Corner","Public room"] };
const avatar=n=>(n||"G").trim()[0].toUpperCase(), esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
function tm(t){return new Date(t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function bubble(box,name,text,mine,t){let d=document.createElement("div");d.className="msg "+(mine?"mine":"");d.innerHTML=`<div class="bubble">${name?`<b>${esc(name)}</b><br>`:""}${esc(text)}<div class="meta">${tm(t)}</div></div>`;box.appendChild(d);box.scrollTop=box.scrollHeight}
function sys(t,box=messages){let d=document.createElement("div");d.className="system";d.textContent=t;box.appendChild(d);box.scrollTop=box.scrollHeight}
function profile(){$("#myName").textContent=myName;$("#myAvatar").textContent=avatar(myName)}
function enter(){if(!myName){$("#nameDialog").showModal();return}profile();socket.emit("join",{name:myName})}
$("#nameForm").onsubmit=e=>{e.preventDefault();let n=$("#nameInput").value.trim();if(!n)return;myName=n.slice(0,30);localStorage.setItem("btc_name",myName);$("#nameDialog").close();profile();socket.emit("join",{name:myName})}
$("#editName").onclick=()=>{$("#nameInput").value=myName;$("#nameDialog").showModal()}
socket.on("joined",d=>{myId=d.id;room=d.room;selectRoom(room)});socket.on("room:joined",r=>{room=r;selectRoom(r)});socket.on("system",t=>sys(t));
socket.on("chat",m=>{if(m.room===room)bubble(messages,m.name,m.text,m.id===myId,m.time)});
socket.on("directory",list=>{ $("#onlineCount").textContent=list.length;people.innerHTML="";list.forEach(u=>{let p=document.createElement("div");p.className="person"+(u.id===selectedId?" selected":"");p.dataset.id=u.id;p.innerHTML=`<span class="mini">${avatar(u.name)}</span><div><b>${esc(u.name)}${u.id===myId?" (You)":""}</b><small>${meta[u.room]?.[0]||u.room}</small></div><i>●</i>`;if(u.id!==myId)p.onclick=()=>pick(u,p);people.appendChild(p)})});
function pick(u,p){selectedId=u.id;selectedName=u.name;document.querySelectorAll(".person").forEach(x=>x.classList.remove("selected","unread"));p.classList.add("selected");privateTarget=u.id;$("#privateName").textContent=u.name;$("#privatePanel").classList.add("open");$("#privateMessages").innerHTML=""}
$("#closePrivate").onclick=()=>$("#privatePanel").classList.remove("open");
$("#privateForm").onsubmit=e=>{e.preventDefault();let i=$("#privateInput"),t=i.value.trim();if(t&&privateTarget){socket.emit("private:message",{target:privateTarget,text:t});i.value=""}}
socket.on("private:message",m=>{if(m.from===privateTarget)bubble($("#privateMessages"),m.name,m.text,m.from===myId,m.time)});
$("#composer").onsubmit=e=>{e.preventDefault();let i=$("#message"),t=i.value.trim();if(t){socket.emit("chat",{room,text:t});i.value=""}}
$("#emoji").onclick=()=>{$("#message").value+=" 😊";$("#message").focus()}
document.querySelectorAll(".room").forEach(b=>b.onclick=()=>socket.emit("room:join",b.dataset.room));
function selectRoom(r){document.querySelectorAll(".room").forEach(b=>b.classList.toggle("active",b.dataset.room===r));$("#roomTitle").textContent=meta[r][0];$("#roomSubtitle").textContent=meta[r][1];messages.innerHTML="";sys("Entered "+meta[r][0])}
$("#setStream").onclick=()=>{let u=$("#streamUrl").value.trim();if(u){$("#radio").src=u;$("#radio").play().catch(()=>{})}};

async function getMedia(mode){return navigator.mediaDevices.getUserMedia(mode==="video"?{audio:true,video:true}:{audio:true,video:false})}
function peer(id,mode){let p=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});peers.set(id,p);p.onicecandidate=e=>e.candidate&&socket.emit("call:ice",{target:id,candidate:e.candidate});p.ontrack=e=>mode==="video"?$("#remoteVideo").srcObject=e.streams[0]:$("#remoteAudio").srcObject=e.streams[0];return p}
function showCall(t,mode){$("#callTitle").textContent=t;$("#remoteVideo").style.display=mode==="video"?"block":"none";$("#localVideo").style.display=mode==="video"?"block":"none";$("#toggleVideo").style.display=mode==="video"?"inline-block":"none";$("#callDialog").showModal()}
async function call(mode){if(!selectedId)return alert("Select an online user first.");try{active=selectedId;local=await getMedia(mode);showCall("Calling "+selectedName+"…",mode);let p=peer(active,mode);local.getTracks().forEach(x=>p.addTrack(x,local));if(mode==="video")$("#localVideo").srcObject=local;let o=await p.createOffer();await p.setLocalDescription(o);socket.emit("call:offer",{target:active,offer:o,mode})}catch(e){alert("Please allow microphone/camera access.")}}
socket.on("call:offer",x=>{pending=x;$("#incomingTitle").textContent=x.name+" is calling";$("#incomingMode").textContent=x.mode==="video"?"Incoming video call":"Incoming audio call";$("#incomingDialog").showModal()});
$("#answerCall").onclick=async()=>{let x=pending;$("#incomingDialog").close();try{active=x.from;local=await getMedia(x.mode);showCall("Call with "+x.name,x.mode);let p=peer(active,x.mode);local.getTracks().forEach(t=>p.addTrack(t,local));if(x.mode==="video")$("#localVideo").srcObject=local;await p.setRemoteDescription(x.offer);let a=await p.createAnswer();await p.setLocalDescription(a);socket.emit("call:answer",{target:active,answer:a})}catch(e){alert("Could not access microphone/camera.")}pending=null};
$("#rejectCall").onclick=()=>{$("#incomingDialog").close();pending=null};socket.on("call:answer",async x=>{let p=peers.get(x.from);if(p)await p.setRemoteDescription(x.answer)});socket.on("call:ice",async x=>{let p=peers.get(x.from);if(p&&x.candidate)try{await p.addIceCandidate(x.candidate)}catch{}});
function end(send=true){if(send&&active)socket.emit("call:hangup",{target:active});peers.forEach(p=>p.close());peers.clear();if(local)local.getTracks().forEach(t=>t.stop());local=null;active=null;if($("#callDialog").open)$("#callDialog").close()}
socket.on("call:hangup",()=>end(false));$("#hangup").onclick=()=>end(true);$("#audioCall").onclick=()=>call("audio");$("#videoCall").onclick=()=>call("video");
$("#mute").onclick=()=>{let t=local?.getAudioTracks()[0];if(t){t.enabled=!t.enabled;$("#mute").textContent=t.enabled?"🎙️":"🔇"}};$("#toggleVideo").onclick=()=>{let t=local?.getVideoTracks()[0];if(t){t.enabled=!t.enabled;$("#toggleVideo").textContent=t.enabled?"📹":"🚫"}};
enter();