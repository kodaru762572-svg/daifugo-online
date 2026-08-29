'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const PORT = process.env.PORT || 3000;

const app = express();
// exe化(pkg)して実行した場合、埋め込みスナップショットではなく実行ファイルと
// 同じ場所に置いた public/ フォルダを直接読みに行く(静的ファイル配信の互換性のため)。
// 通常の `node server/index.js` 実行時は従来通りソース相対のpublicを使う。
const publicDir = process.pkg
  ? path.join(path.dirname(process.execPath), 'public')
  : path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

const server = http.createServer(app);
const io = new Server(server);

const manager = new RoomManager();

// スタンプ機能で送信を許可するID一覧 (public/stickers/<id>.png と対応)
const STICKER_IDS = new Set([
  'revolution', 'eightcut', 'shibari', 'joker', 'agari',
  'pass', 'daifugo', 'hinmin', 'yowasugi', 'aori',
]);
const STICKER_COOLDOWN_MS = 1000;

function playerBySocket(socket) {
  return { roomCode: socket.data.roomCode, playerId: socket.data.playerId };
}

function broadcastLobby(room) {
  const payload = {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, avatar: p.avatar || null })),
    started: !!room.game,
    rules: room.rules,
  };
  io.to(room.code).emit('room:state', payload);
}

function broadcastGame(room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('game:state', room.game.getStateFor(p.id));
    }
  }
}

function handleGameResultIfNeeded(room, result) {
  if (!result) return;
  if (result.error) return;
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, rules, avatar }, cb) => {
    const cleanName = (name || 'プレイヤー').toString().trim().slice(0, 16) || 'プレイヤー';
    const { room, playerId, token } = manager.createRoom(cleanName, rules, avatar);
    joinSocketToRoom(socket, room, playerId, token);
    cb && cb({ ok: true, roomCode: room.code, playerId, token });
    broadcastLobby(room);
  });

  socket.on('room:join', ({ roomCode, name, avatar }, cb) => {
    const cleanName = (name || 'プレイヤー').toString().trim().slice(0, 16) || 'プレイヤー';
    const result = manager.joinRoom(roomCode, cleanName, avatar);
    if (result.error) {
      cb && cb({ ok: false, error: result.error });
      return;
    }
    const { room, playerId, token } = result;
    joinSocketToRoom(socket, room, playerId, token);
    cb && cb({ ok: true, roomCode: room.code, playerId, token });
    broadcastLobby(room);
  });

  socket.on('room:rejoin', ({ roomCode, playerId, token }, cb) => {
    const result = manager.rejoin(roomCode, playerId, token);
    if (result.error) {
      cb && cb({ ok: false, error: result.error });
      return;
    }
    const { room } = result;
    joinSocketToRoom(socket, room, playerId, token);
    cb && cb({ ok: true, roomCode: room.code, playerId, token });
    broadcastLobby(room);
    if (room.game) broadcastGame(room);
  });

  socket.on('room:start', (_, cb) => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room) return cb && cb({ ok: false, error: 'ルームがありません。' });
    if (room.hostId !== playerId) return cb && cb({ ok: false, error: 'ホストのみ開始できます。' });
    if (room.players.length < 2) return cb && cb({ ok: false, error: '2人以上必要です。' });
    if (room.game) return cb && cb({ ok: false, error: '既に開始しています。' });

    manager.startGame(room);
    cb && cb({ ok: true });
    broadcastLobby(room);
    broadcastGame(room);
  });

  socket.on('room:nextRound', (_, cb) => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room || !room.game) return cb && cb({ ok: false, error: 'ゲームがありません。' });
    if (room.hostId !== playerId) return cb && cb({ ok: false, error: 'ホストのみ操作できます。' });
    if (room.game.phase !== 'ROUND_END') return cb && cb({ ok: false, error: '今は次のラウンドを開始できません。' });

    room.game.startRound();
    cb && cb({ ok: true });
    broadcastGame(room);
  });

  socket.on('game:play', ({ cardIds }, cb) => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room || !room.game) return cb && cb({ ok: false, error: 'ゲームがありません。' });
    const result = room.game.playCards(playerId, cardIds || []);
    cb && cb(result);
    if (result.ok) broadcastGame(room);
  });

  socket.on('game:pass', (_, cb) => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room || !room.game) return cb && cb({ ok: false, error: 'ゲームがありません。' });
    const result = room.game.pass(playerId);
    cb && cb(result);
    if (result.ok) broadcastGame(room);
  });

  socket.on('game:sticker', ({ stickerId }, cb) => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room) return cb && cb({ ok: false, error: 'ルームがありません。' });
    if (!STICKER_IDS.has(stickerId)) return cb && cb({ ok: false, error: '不正なスタンプです。' });
    const now = Date.now();
    if (socket.data.lastStickerAt && now - socket.data.lastStickerAt < STICKER_COOLDOWN_MS) {
      return cb && cb({ ok: false, error: '連続で送りすぎです。少し待ってください。' });
    }
    socket.data.lastStickerAt = now;
    const player = room.players.find((p) => p.id === playerId);
    io.to(room.code).emit('game:stickerReceived', {
      playerId,
      playerName: player ? player.name : '',
      stickerId,
    });
    cb && cb({ ok: true });
  });

  socket.on('game:exchangeReturn', ({ cardIds }, cb) => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room || !room.game) return cb && cb({ ok: false, error: 'ゲームがありません。' });
    const result = room.game.submitExchangeReturn(playerId, cardIds || []);
    cb && cb(result);
    if (result.ok) broadcastGame(room);
  });

  socket.on('game:sevenGive', ({ cardIds, toPlayerId }, cb) => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room || !room.game) return cb && cb({ ok: false, error: 'ゲームがありません。' });
    const result = room.game.submitSevenGive(playerId, cardIds || [], toPlayerId);
    cb && cb(result);
    if (result.ok) broadcastGame(room);
  });

  socket.on('disconnect', () => {
    const { roomCode, playerId } = playerBySocket(socket);
    const room = manager.getRoom(roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    if (player) {
      player.connected = false;
      player.socketId = null;
    }
    if (room.game) {
      room.game.disconnected.add(playerId);
    }
    broadcastLobby(room);
    if (room.game) broadcastGame(room);
    manager.removeEmptyRoomIfNeeded(room.code);
  });
});

function joinSocketToRoom(socket, room, playerId, token) {
  const player = room.players.find((p) => p.id === playerId);
  if (player) {
    player.connected = true;
    player.socketId = socket.id;
  }
  socket.data.roomCode = room.code;
  socket.data.playerId = playerId;
  socket.data.token = token;
  if (room.game) {
    room.game.disconnected.delete(playerId);
  }
  socket.join(room.code);
}

function localNetworkAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

server.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  大富豪オンライン サーバー起動 ✅');
  console.log('========================================');
  console.log(`  このPCから遊ぶ:      http://localhost:${PORT}`);
  const lan = localNetworkAddresses();
  if (lan.length > 0) {
    console.log('  同じWi-Fi/LANの人:');
    lan.forEach((addr) => console.log(`    http://${addr}:${PORT}`));
  }
  console.log('');
  console.log('  ※ 家の外にいる友達にも遊んでもらうには、別途');
  console.log('    トンネルサービス(ngrok など)でこのポートを');
  console.log('    外部公開する必要があります。');
  console.log('  ※ このウィンドウを閉じるとサーバーは停止します。');
  console.log('========================================');
});
