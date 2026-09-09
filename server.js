const express=require("express");
const http=require("http");
const path=require("path");
const {Server}=require("socket.io");
const app=express(), server=http.createServer(app), io=new Server(server);
const PORT=process.env.PORT||3000;
const users=new Map();
const rooms=["tamil-friends","fm-lounge","love-corner"];

app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(req,res)=>res.json({ok:true,service:"ButterflyTamilChat"}));

const safe=s=>String(s||"").trim().slice(0,30)||"Guest";
function directory(){return [...users].map(([id,u])=>({id,name:u.name,room:u.room}));}
function broadcast(){io.emit("directory",directory());}

io.on("connection",socket=>{
  socket.on("join",({name})=>{
    const user={name:safe(name),room:rooms[0]};
    users.set(socket.id,user); socket.join(user.room);
    socket.emit("joined",{id:socket.id,room:user.room});
    io.to(user.room).emit("system",`${user.name} joined the room`);
    broadcast();
  });
  socket.on("room:join",room=>{
    if(!users.has(socket.id)||!rooms.includes(room))return;
    const u=users.get(socket.id);
    socket.leave(u.room); socket.to(u.room).emit("system",`${u.name} left the room`);
    u.room=room; socket.join(room); socket.emit("room:joined",room);
    io.to(room).emit("system",`${u.name} joined the room`); broadcast();
  });
  socket.on("chat",({room,text})=>{
    const u=users.get(socket.id), t=String(text||"").trim().slice(0,1000);
    if(!u||!t)return;
    const r=rooms.includes(room)?room:u.room;
    io.to(r).emit("chat",{id:socket.id,name:u.name,text:t,room:r,time:new Date().toISOString()});
  });
  socket.on("private:message",({target,text})=>{
    const u=users.get(socket.id),t=String(text||"").trim().slice(0,1000);
    if(!u||!users.has(target)||!t)return;
    const p={from:socket.id,name:u.name,text:t,time:new Date().toISOString()};
    socket.emit("private:message",p);io.to(target).emit("private:message",p);
  });
  // WebRTC signaling. Add TURN credentials in public/app.js for production NAT traversal.
  socket.on("call:offer",({target,offer,mode})=>{
    if(users.has(target))io.to(target).emit("call:offer",{from:socket.id,name:users.get(socket.id).name,offer,mode:mode==="video"?"video":"audio"});
  });
  socket.on("call:answer",({target,answer})=>{if(users.has(target))io.to(target).emit("call:answer",{from:socket.id,answer});});
  socket.on("call:ice",({target,candidate})=>{if(users.has(target))io.to(target).emit("call:ice",{from:socket.id,candidate});});
  socket.on("call:hangup",({target})=>{if(users.has(target))io.to(target).emit("call:hangup",{from:socket.id});});
  socket.on("disconnect",()=>{
    const u=users.get(socket.id);users.delete(socket.id);
    if(u)io.to(u.room).emit("system",`${u.name} left the room`);
    broadcast();
  });
});
server.listen(PORT,()=>console.log(`ButterflyTamilChat listening on ${PORT}`));