'use strict';

const crypto = require('crypto');
const { DaifugoGame, normalizeRules } = require('./game');

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

// アバター画像は data URL (base64) で受け取る。サイズ上限を設けて肥大化を防ぐ。
const MAX_AVATAR_LENGTH = 60000; // 約45KB相当 (200x200程度のJPEGを想定)
function normalizeAvatar(avatar) {
  if (typeof avatar !== 'string') return null;
  if (!avatar.startsWith('data:image/')) return null;
  if (avatar.length > MAX_AVATAR_LENGTH) return null;
  return avatar;
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }

  createRoom(hostName, rules, avatar) {
    let code;
    do {
      code = makeRoomCode();
    } while (this.rooms.has(code));

    const playerId = makeId();
    const token = makeToken();
    const room = {
      code,
      hostId: playerId,
      players: [{ id: playerId, name: hostName, token, socketId: null, connected: false, avatar: normalizeAvatar(avatar) }],
      game: null,
      rules: normalizeRules(rules),
      maxPlayers: 6,
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    return { room, playerId, token };
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  joinRoom(code, name, avatar) {
    const room = this.getRoom(code);
    if (!room) return { error: 'ルームが見つかりません。ルームコードを確認してください。' };
    if (room.game && room.game.phase !== 'LOBBY') {
      return { error: 'このルームは既にゲームが開始されています。' };
    }
    if (room.players.length >= room.maxPlayers) {
      return { error: 'ルームの人数上限に達しています。(最大6人)' };
    }
    const playerId = makeId();
    const token = makeToken();
    room.players.push({ id: playerId, name, token, socketId: null, connected: false, avatar: normalizeAvatar(avatar) });
    return { room, playerId, token };
  }

  rejoin(code, playerId, token) {
    const room = this.getRoom(code);
    if (!room) return { error: 'ルームが見つかりません。' };
    const player = room.players.find((p) => p.id === playerId && p.token === token);
    if (!player) return { error: '再接続できませんでした。' };
    return { room, playerId, token };
  }

  removeEmptyRoomIfNeeded(code) {
    const room = this.getRoom(code);
    if (!room) return;
    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) {
      // 全員切断してから一定時間で破棄 (簡易実装: 即時破棄せず一定時間後にチェック)
      setTimeout(() => {
        const r = this.getRoom(code);
        if (r && !r.players.some((p) => p.connected)) {
          this.rooms.delete(code);
        }
      }, 30 * 60 * 1000);
    }
  }

  startGame(room) {
    room.game = new DaifugoGame(room.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar })), room.rules);
    return room.game.startRound();
  }
}

module.exports = { RoomManager };
