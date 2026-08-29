'use strict';
/**
 * サーバーを実際に起動し、4人のクライアント(bot)で
 * ルーム作成〜対戦〜ラウンド終了〜カード交換〜次ラウンド開始 までを
 * 通しで検証する統合テスト。
 * 実行: node test/integration.test.js
 */
const path = require('path');
const { fork } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3939;
const URL = `http://localhost:${PORT}`;
const RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

function strengthOf(rank, revolution) {
  if (rank === 'JOKER') return 1000;
  const idx = RANK_ORDER.indexOf(rank);
  return revolution ? (RANK_ORDER.length - 1 - idx) : idx;
}

function log(...args) {
  console.log('[integration]', ...args);
}

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

async function main() {
  const serverProc = fork(path.join(__dirname, '..', 'server', 'index.js'), {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });

  await new Promise((resolve) => setTimeout(resolve, 1200)); // サーバー起動待ち

  const NAMES = ['あかり', 'ぼたん', 'つばき', 'ひまり'];
  const clients = NAMES.map(() => io(URL, { transports: ['websocket'], reconnection: false }));
  const states = new Map(); // socket -> latest game state
  const playerIds = new Map(); // socket -> playerId

  function pickPlay(state) {
    const hand = state.myHand;
    const revolution = state.revolution;
    const byRank = new Map();
    for (const c of hand) {
      const key = c.joker ? 'JOKER' : c.rank;
      if (!byRank.has(key)) byRank.set(key, []);
      byRank.get(key).push(c);
    }

    const neededCount = state.field ? state.field.count : 1;
    const candidates = [];
    for (const [rank, cards] of byRank.entries()) {
      if (cards.length >= neededCount) {
        candidates.push({ rank, cards: cards.slice(0, neededCount) });
      }
    }
    // ロック中はスートが合うものだけに絞る
    let filtered = candidates;
    if (state.lockedSuits) {
      filtered = candidates.filter((c) => {
        if (c.rank === 'JOKER') return true;
        return c.cards.every((card) => state.lockedSuits.includes(card.suit));
      });
      if (filtered.length === 0) filtered = candidates.filter((c) => c.rank === 'JOKER');
    }

    if (!state.field) {
      // リード: 一番弱い手を出す (8切りは避けて楽しむため8以外を優先)
      filtered.sort((a, b) => strengthOf(a.rank, revolution) - strengthOf(b.rank, revolution));
      const nonEight = filtered.find((c) => c.rank !== '8');
      return nonEight || filtered[0] || null;
    }

    const fieldStrength = strengthOf(state.field.rank, revolution);
    const beatable = filtered.filter((c) => strengthOf(c.rank, revolution) > fieldStrength);
    if (beatable.length === 0) return null;
    beatable.sort((a, b) => strengthOf(a.rank, revolution) - strengthOf(b.rank, revolution));
    return beatable[0];
  }

  clients.forEach((socket, i) => {
    socket.on('game:state', (state) => {
      states.set(socket, state);
      const myId = playerIds.get(socket);

      // カード交換フェーズ: 自分のタスクがあれば弱いカードを返す
      if (state.phase === 'EXCHANGE' && state.pendingExchange) {
        const task = state.pendingExchange.find((t) => t.playerId === myId && !t.done);
        if (task) {
          const sorted = state.myHand.slice().sort((a, b) => strengthOf(a.rank, false) - strengthOf(b.rank, false));
          const giveIds = sorted.slice(0, task.count).map((c) => c.id);
          socket.emit('game:exchangeReturn', { cardIds: giveIds }, (res) => {
            if (!res.ok) fail(`${NAMES[i]} exchangeReturn失敗: ${res.error}`);
          });
        }
        return;
      }

      // 7渡しフェーズ: 自分が渡す番なら弱いカードを最初の候補に渡す
      if (state.phase === 'SEVEN_GIVE' && state.pendingSevenGive) {
        const pending = state.pendingSevenGive;
        if (pending.playerId === myId) {
          const sorted = state.myHand.slice().sort((a, b) => strengthOf(a.rank, false) - strengthOf(b.rank, false));
          const giveIds = sorted.slice(0, pending.count).map((c) => c.id);
          const toPlayerId = pending.candidates[0].id;
          socket.emit('game:sevenGive', { cardIds: giveIds, toPlayerId }, (res) => {
            if (!res.ok) fail(`${NAMES[i]} sevenGive失敗: ${res.error}`);
          });
        }
        return;
      }

      if (state.phase !== 'PLAYING') return;
      if (state.currentTurnPlayerId !== myId) return;

      const choice = pickPlay(state);
      if (choice) {
        socket.emit('game:play', { cardIds: choice.cards.map((c) => c.id) }, (res) => {
          if (!res.ok) {
            // フォールバック: 出せないと言われたらパスする
            socket.emit('game:pass', {}, (res2) => {
              if (!res2.ok) fail(`${NAMES[i]} play失敗後のpassも失敗: ${res2.error}`);
            });
          }
        });
      } else {
        socket.emit('game:pass', {}, (res) => {
          if (!res.ok) fail(`${NAMES[i]} pass失敗: ${res.error} (field=${JSON.stringify(state.field)})`);
        });
      }
    });
  });

  // 接続待ち
  await Promise.all(clients.map((s) => new Promise((resolve) => s.on('connect', resolve))));
  log('全クライアント接続完了');

  // ルーム作成 & 参加
  const roomCode = await new Promise((resolve) => {
    clients[0].emit('room:create', { name: NAMES[0] }, (res) => {
      if (!res.ok) fail('ルーム作成失敗');
      playerIds.set(clients[0], res.playerId);
      resolve(res.roomCode);
    });
  });
  log('ルーム作成:', roomCode);

  for (let i = 1; i < clients.length; i++) {
    await new Promise((resolve) => {
      clients[i].emit('room:join', { roomCode, name: NAMES[i] }, (res) => {
        if (!res.ok) fail(`参加失敗 ${NAMES[i]}: ${res.error}`);
        playerIds.set(clients[i], res.playerId);
        resolve();
      });
    });
  }
  log('全員参加完了');

  await new Promise((resolve) => setTimeout(resolve, 300));

  await new Promise((resolve) => {
    clients[0].emit('room:start', {}, (res) => {
      if (!res.ok) fail('ゲーム開始失敗: ' + res.error);
      resolve();
    });
  });
  log('ゲーム開始');

  // ラウンド終了まで待機 (最大15秒)
  async function waitForPhase(phase, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const st = states.get(clients[0]);
      if (st && st.phase === phase) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  const round1Ended = await waitForPhase('ROUND_END', 15000);
  if (!round1Ended) fail('第1ラウンドが時間内に終了しなかった');
  else {
    const st = states.get(clients[0]);
    log('第1ラウンド終了。順位:', st.finishedOrder.map((f) => `${f.name}(${f.role})`).join(', '));
    if (st.finishedOrder.length !== 4) fail('あがった人数が4人になっていない');
  }

  // 次のラウンドへ (カード交換が絡む)
  await new Promise((resolve) => {
    clients[0].emit('room:nextRound', {}, (res) => {
      if (!res.ok) fail('次ラウンド開始失敗: ' + res.error);
      resolve();
    });
  });
  log('第2ラウンド開始 (カード交換含む)');

  const round2Ended = await waitForPhase('ROUND_END', 15000);
  if (!round2Ended) fail('第2ラウンドが時間内に終了しなかった (カード交換フェーズで詰まった可能性)');
  else {
    const st = states.get(clients[0]);
    log('第2ラウンド終了。順位:', st.finishedOrder.map((f) => `${f.name}(${f.role})`).join(', '));
  }

  clients.forEach((s) => s.close());
  serverProc.kill();

  await new Promise((r) => setTimeout(r, 300));

  if (process.exitCode) {
    console.error('\n統合テスト: 失敗があります ❌');
  } else {
    console.log('\n統合テスト: すべて成功しました ✅');
  }
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
