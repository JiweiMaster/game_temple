/**
 * 云上禅寺 - 多人在线服务器
 * 职责：静态文件服务 + WebSocket 实时同步（位置/状态/动作/聊天）
 * 容量：最多 100 人同时在线，满员拒绝；同 ID 踢旧迎新（支持刷新重连）
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8188;
const MAX_USERS = 100;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VALID_STATES = ['idle', 'sit', 'chant', 'incense'];
const KNOCK_MERIT = 108; // 木鱼功德圆满阈值

/* ---------------- 静态文件服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ply': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
  let url = (req.url || '/').split('?')[0];
  if (url === '/') url = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(url));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server });
const users = new Map(); // ws -> user { id,color,x,z,ry,s,merit,lastActive }

function sendTo(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, exclude) {
  const msg = JSON.stringify(obj);
  for (const client of users.keys()) {
    if (client !== exclude && client.readyState === 1) client.send(msg);
  }
}
function snapshot() {
  return Array.from(users.values()).map(u => ({ id: u.id, color: u.color, x: u.x, z: u.z, ry: u.ry, s: u.s, m: u.merit }));
}
const AVATAR_COLORS = [0x8a8d93, 0xc9a86a, 0x7a8a8f, 0x9a7a5a, 0x5a6a8a, 0x8a4a52, 0x6b8a6e, 0xa08a5a, 0x4a5a68, 0x8a6a7a]; // 僧衣色板
function pickColor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

wss.on('connection', (ws) => {
  let user = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (user) user.lastActive = Date.now();

    /* ---- 入寺 ---- */
    if (data.t === 'join') {
      const id = String(data.id || '').trim().slice(0, 12);
      if (user) return; // 已登录过
      if (!id || id.length < 2) return sendTo(ws, { t: 'err', m: 'ID 至少需要 2 个字符' });
      if (users.size >= MAX_USERS) return sendTo(ws, { t: 'full' });

      // 同 ID：踢旧迎新
      for (const [client, u] of users) {
        if (u.id === id) {
          users.delete(client);
          try { client.close(); } catch (e) {}
          broadcast({ t: 'left', id });
        }
      }

      user = {
        id,
        color: pickColor(id),
        x: Math.random() * 5 - 2.5,
        z: 26 + Math.random() * 2,
        ry: Math.PI, // 面朝北（大殿）
        s: 'idle',
        merit: 0,
        lastActive: Date.now()
      };
      users.set(ws, user);

      sendTo(ws, { t: 'ok', you: { id: user.id, color: user.color, x: user.x, z: user.z, ry: user.ry }, users: snapshot() });
      broadcast({ t: 'join', u: { id: user.id, color: user.color, x: user.x, z: user.z, ry: user.ry, s: 'idle' } }, ws);
      broadcast({ t: 'sys', m: `施主「${id}」入寺` });
      console.log(`[+] ${id} 入寺 (在线 ${users.size})`);
      return;
    }

    if (!user) return;

    switch (data.t) {
      case 'pos': {
        const nx = clamp(+data.x || 0, -45, 45);
        const nz = clamp(+data.z || 0, -45, 45);
        if (Math.abs(nx - user.x) < 0.001 && Math.abs(nz - user.z) < 0.001 && Math.abs((+data.ry || 0) - user.ry) < 0.01) break;
        user.x = nx; user.z = nz; user.ry = +data.ry || 0;
        broadcast({ t: 'pos', id: user.id, x: user.x, z: user.z, ry: user.ry }, ws);
        break;
      }
      case 'state': {
        const s = VALID_STATES.includes(data.s) ? data.s : 'idle';
        if (s === user.s) break;
        user.s = s;
        broadcast({ t: 'state', id: user.id, s }, ws);
        break;
      }
      case 'action': {
        if (data.a === 'knock') {
          user.merit += 1;
          broadcast({ t: 'action', id: user.id, a: 'knock' }, ws);
          if (user.merit === KNOCK_MERIT) {
            broadcast({ t: 'sys', m: `施主「${user.id}」敲满一百零八下木鱼，功德圆满！` });
            console.log(`[!] ${user.id} 功德圆满`);
          }
        } else if (data.a === 'burn') {
          user.merit += 10;
          broadcast({ t: 'action', id: user.id, a: 'burn', bx: +data.bx || 0, bz: +data.bz || 0 }, ws);
        }
        break;
      }
      case 'chat': {
        const m = String(data.m || '').slice(0, 60).trim();
        if (m) broadcast({ t: 'chat', id: user.id, m }, ws);
        break;
      }
      case 'ping': break; // 保活
    }
  });

  ws.on('close', () => {
    if (!user) return;
    users.delete(ws);
    broadcast({ t: 'left', id: user.id });
    broadcast({ t: 'sys', m: `施主「${user.id}」离寺` });
    console.log(`[-] ${user.id} 离寺 (在线 ${users.size})`);
  });
  ws.on('error', () => {});
});

/* 60 秒无消息视为掉线 */
setInterval(() => {
  const now = Date.now();
  for (const [client, u] of users) {
    if (now - u.lastActive > 60000) { try { client.terminate(); } catch (e) {} }
  }
}, 15000);

/* ---------------- 启动 ---------------- */
function lanIPs() {
  const res = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) res.push(net.address);
    }
  }
  return res;
}

server.listen(PORT, () => {
  console.log('=========================================');
  console.log('  云上禅寺已开启');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`  局域网访问: http://${ip}:${PORT}`);
  console.log(`  容量上限:   ${MAX_USERS} 人同时在线`);
  console.log('=========================================');
});
