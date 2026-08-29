'use strict';
/**
 * UI検証スクリプト: 選択の挙動(枚数上限・ランク固定)、飛んでくるモーション、
 * サイズ変更(アイコン縮小・場のカード拡大)を実際のブラウザで確認する。
 * 実行: node test/verify_ui.js
 */
const path = require('path');
const { fork } = require('child_process');
const { chromium } = require('playwright');
const { io } = require('socket.io-client');

const PORT = 3941;
const BASE = `http://localhost:${PORT}`;
const OUT = '/home/claude/preview_ui';

const RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
function strengthOf(rank, revolution) {
  if (rank === 'JOKER') return 1000;
  const idx = RANK_ORDER.indexOf(rank);
  return revolution ? (RANK_ORDER.length - 1 - idx) : idx;
}

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}
function ok(msg) {
  console.log('ok -', msg);
}

async function main() {
  const fs = require('fs');
  fs.mkdirSync(OUT, { recursive: true });

  const serverProc = fork(path.join(__dirname, '..', 'server', 'index.js'), {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 1200));

  // 3人のbot(ソケットのみ)を用意 -> 常にパスして人間の手番を素早く回す
  const NAMES_BOT = ['ぼたん', 'つばき', 'ひまり'];
  const bots = NAMES_BOT.map(() => io(BASE, { transports: ['websocket'], reconnection: false }));
  const botIds = new Map();

  // リード時(場が空)はパスできないため、integration.test.js と同じロジックで
  // 「出せるなら一番弱い手を出す・出せないならパス」を行う
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
      if (cards.length >= neededCount) candidates.push({ rank, cards: cards.slice(0, neededCount) });
    }
    let filtered = candidates;
    if (state.lockedSuits) {
      filtered = candidates.filter((c) => {
        if (c.rank === 'JOKER') return true;
        return c.cards.every((card) => state.lockedSuits.includes(card.suit));
      });
      if (filtered.length === 0) filtered = candidates.filter((c) => c.rank === 'JOKER');
    }
    if (!state.field) {
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

  function botPlay(state, myId, socket) {
    if (state.phase === 'EXCHANGE' && state.pendingExchange) {
      const task = state.pendingExchange.find((t) => t.playerId === myId && !t.done);
      if (task) {
        const sorted = state.myHand.slice().sort((a, b) => strengthOf(a.rank, false) - strengthOf(b.rank, false));
        socket.emit('game:exchangeReturn', { cardIds: sorted.slice(0, task.count).map((c) => c.id) }, () => {});
      }
      return;
    }
    if (state.phase === 'SEVEN_GIVE' && state.pendingSevenGive) {
      const pending = state.pendingSevenGive;
      if (pending.playerId === myId) {
        const sorted = state.myHand.slice().sort((a, b) => strengthOf(a.rank, false) - strengthOf(b.rank, false));
        socket.emit('game:sevenGive', { cardIds: sorted.slice(0, pending.count).map((c) => c.id), toPlayerId: pending.candidates[0].id }, () => {});
      }
      return;
    }
    if (state.phase !== 'PLAYING') return;
    if (state.currentTurnPlayerId !== myId) return;
    const choice = pickPlay(state);
    if (choice) {
      socket.emit('game:play', { cardIds: choice.cards.map((c) => c.id) }, (res) => {
        if (!res.ok) socket.emit('game:pass', {}, () => {});
      });
    } else {
      socket.emit('game:pass', {}, () => {});
    }
  }

  bots.forEach((socket) => {
    socket.on('game:state', (state) => {
      const myId = botIds.get(socket);
      if (myId) botPlay(state, myId, socket);
    });
  });

  await Promise.all(bots.map((s) => new Promise((resolve) => s.on('connect', resolve))));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  await page.goto(BASE);
  await page.fill('#input-name', 'せな');
  await page.click('#btn-create');
  await page.waitForSelector('#screen-lobby:not([hidden])');
  const roomCode = (await page.textContent('#lobby-roomcode')).trim();
  ok(`ルーム作成: ${roomCode}`);

  for (let i = 0; i < bots.length; i++) {
    await new Promise((resolve) => {
      bots[i].emit('room:join', { roomCode, name: NAMES_BOT[i] }, (res) => {
        if (!res.ok) fail(`bot参加失敗: ${res.error}`);
        botIds.set(bots[i], res.playerId);
        resolve();
      });
    });
  }
  await page.waitForTimeout(400);

  await page.click('#btn-start');
  await page.waitForSelector('#screen-game:not([hidden])');
  await page.waitForTimeout(500);
  ok('ゲーム開始');

  // 相手アイコンのサイズを確認 (小さくなっているか)
  await page.screenshot({ path: `${OUT}/00_game_start.png` });
  const avatarBox = await page.evaluate(() => {
    const av = document.querySelector('.opponent .avatar');
    if (!av) return null;
    const r = av.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  ok(`相手アイコンサイズ: ${JSON.stringify(avatarBox)}`);

  // 人間の手番になるまで待つ(最大25秒、ボットは常にパスするので早い)
  async function waitForMyTurn(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const isMyTurn = await page.evaluate(() => {
        // computePlayableCardIds は自分の手番のときだけ playable/unplayable クラスを付与する
        return document.querySelectorAll('#hand-cards .playing-card.playable, #hand-cards .playing-card.unplayable').length > 0;
      });
      if (isMyTurn) return true;
      await page.waitForTimeout(200);
    }
    return false;
  }

  const myTurn = await waitForMyTurn(45000);
  if (!myTurn) {
    fail('人間の手番が来なかった(タイムアウト)');
  } else {
    ok('人間の手番になった');

    // 手札カードごとのランクラベル (children[1].textContent) を取得
    const handRanks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#hand-cards .playing-card')).map((el) => {
        return el.children[1] ? el.children[1].textContent.trim() : '';
      });
    });
    ok(`手札: ${handRanks.join(',')}`);

    // 1枚目を選択 -> selectedクラスの確認 + 見た目のスクリーンショット(リフト演出が無いことを目視)
    // 手札は扇状に重なっているため実座標クリックだと隣のカードに奪われることがある。
    // 実際のクリックハンドラを直接叩いて選択を再現する。
    await page.evaluate(() => {
      document.querySelectorAll('#hand-cards .playing-card')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/01_selected_one.png` });
    const selectedAfterOne = await page.evaluate(() =>
      document.querySelectorAll('#hand-cards .playing-card.selected').length
    );
    if (selectedAfterOne !== 1) fail(`1枚目選択後のselected数が1でない (${selectedAfterOne})`);
    else ok('カード選択でselectedクラスが1件付与される');

    // 異なるランクの2枚目を探してクリック -> 追加されないことを確認
    const diffIdx = handRanks.findIndex((r, idx) => idx !== 0 && r !== handRanks[0] && r !== 'JOKER');
    if (diffIdx >= 0) {
      await page.evaluate((idx) => {
        document.querySelectorAll('#hand-cards .playing-card')[idx].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, diffIdx);
      await page.waitForTimeout(150);
      const selectedCount = await page.evaluate(() => document.querySelectorAll('#hand-cards .playing-card.selected').length);
      if (selectedCount !== 1) {
        fail(`異なるランクのカードを追加できてしまった (selected=${selectedCount})`);
      } else {
        ok('異なるランクのカードは複数選択に追加されない(select-lockedで弾かれる)');
      }
      await page.screenshot({ path: `${OUT}/02_diffrank_blocked.png` });
    } else {
      ok('(異なるランクの候補が手札になかったためこのチェックはスキップ)');
    }

    // 選択をリセットし、実際に出せる(playableな)カードを選び直す
    // (この場面での選択制約テストと違い、プレイの成立にはルール上出せるカードが必要)
    await page.evaluate(() => {
      document.querySelectorAll('#hand-cards .playing-card.selected').forEach((el) => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    });
    await page.waitForTimeout(150);
    const hasPlayable = await page.evaluate(() => {
      const target = document.querySelector('#hand-cards .playing-card.playable');
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });
    await page.waitForTimeout(150);
    if (!hasPlayable) ok('(出せるカードが手札になかったためプレイ確認はパスのみで進行)');

    // 場のカードサイズを確認 (プレイ前、場が空でなければ)
    const fieldSizeBefore = await page.evaluate(() => {
      const c = document.querySelector('.field-pile .playing-card');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    ok(`プレイ前の場のカードサイズ: ${JSON.stringify(fieldSizeBefore)}`);

    // flying-inクラスの検出準備
    await page.evaluate(() => {
      window.__flyWatch = [];
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName === 'class' && m.target.classList && m.target.classList.contains('flying-in')) {
            window.__flyWatch.push('flying-in-detected');
          }
        }
      });
      obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
      window.__flyObs = obs;
    });

    await page.evaluate(() => document.getElementById('btn-play').click());
    await page.waitForTimeout(700);
    const flyWatch = await page.evaluate(() => window.__flyWatch);
    if (flyWatch.length > 0) {
      ok('プレイ時にflying-inアニメーションクラスが検出された');
    } else if (hasPlayable) {
      fail('プレイ時にflying-inクラスが検出されなかった');
    } else {
      ok('(出せるカードがなかったためflying-in確認はスキップ)');
    }
    await page.screenshot({ path: `${OUT}/03_after_play.png` });

    const fieldSizeAfter = await page.evaluate(() => {
      const c = document.querySelector('.field-pile .playing-card');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    ok(`プレイ後の場のカードサイズ: ${JSON.stringify(fieldSizeAfter)}`);
    if (fieldSizeAfter && fieldSizeAfter.w < 100) {
      fail(`場のカードが十分に大きくなっていない (w=${fieldSizeAfter.w})`);
    } else if (fieldSizeAfter) {
      ok('場のカードが拡大されていることを確認');
    }

    // ---- 手札を選択しただけ・パスだけでは場のflying-inが再発火しないことを確認 ----
    // (ボットの応答で場の中身が実際に変わることがあるため、field-signatureが不変の場合のみ判定する)
    for (let attempt = 0; attempt < 3; attempt++) {
      const sigOf = () =>
        Array.from(document.querySelectorAll('.field-pile .playing-card')).map((c) => c.outerHTML.length).join(',') +
        '|' + document.querySelectorAll('.field-pile .playing-card').length;
      const fieldSigBefore = await page.evaluate(sigOf);
      await page.evaluate(() => { window.__flyWatch = []; });
      const clicked = await page.evaluate(() => {
        const cards = document.querySelectorAll('#hand-cards .playing-card');
        if (cards.length === 0) return false;
        cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      });
      await page.waitForTimeout(150);
      const fieldSigAfter = await page.evaluate(sigOf);
      await page.evaluate(() => {
        document.querySelectorAll('#hand-cards .playing-card.selected').forEach((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      });
      await page.waitForTimeout(80);
      if (!clicked) { ok('(手札が残っていなかったためこのチェックはスキップ)'); break; }
      if (fieldSigBefore !== fieldSigAfter) continue; // ちょうど場が動いた回はリトライ
      const flyWatchAfterSelect = await page.evaluate(() => window.__flyWatch);
      if (flyWatchAfterSelect.length > 0) fail('手札を選択しただけなのに場のflying-inが再発火した');
      else ok('手札選択のみでは場のflying-inが再発火しないことを確認(場の中身は不変)');
      break;
    }

    // ---- 「相手のプレイ直後にすぐ自分の手番になる」ケースでもflying-inが消えないことを確認 ----
    // (退行チェック: 誰が出しても必ずエフェクトが出ることを、複数ターンにわたって実際に観測する)
    {
      const byPlayerFly = {};
      for (let i = 0; i < 24; i++) {
        const info = await page.evaluate(() => {
          const pile = document.querySelector('.field-pile');
          const by = document.querySelector('.field-by');
          const isMyTurn = document.querySelectorAll('#hand-cards .playing-card.playable, #hand-cards .playing-card.unplayable').length > 0;
          return { cls: pile ? pile.className : null, by: by ? by.textContent : null, isMyTurn };
        });
        if (info.by) {
          const name = info.by.replace(' が出した', '');
          if (!byPlayerFly[name]) byPlayerFly[name] = { fly: 0, noFly: 0 };
          if (info.cls && info.cls.includes('flying-in')) byPlayerFly[name].fly++;
          else byPlayerFly[name].noFly++;
        }
        if (info.isMyTurn) {
          await page.evaluate(() => {
            const playable = document.querySelector('#hand-cards .playing-card.playable');
            if (playable) {
              playable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              document.getElementById('btn-play').click();
            } else {
              const passBtn = document.getElementById('btn-pass');
              if (passBtn && !passBtn.disabled) passBtn.click();
            }
          });
        }
        await page.waitForTimeout(400);
      }
      ok(`プレイヤー別のflying-in観測結果: ${JSON.stringify(byPlayerFly)}`);
      const neverFlew = Object.entries(byPlayerFly).filter(([, v]) => v.fly === 0 && v.noFly > 0);
      if (neverFlew.length > 0) {
        fail(`一部のプレイヤーのプレイでflying-inが一度も観測されなかった(相手の直後に手番が回るケースでエフェクトが消える不具合の可能性): ${neverFlew.map(([n]) => n).join(',')}`);
      } else {
        ok('観測されたすべてのプレイヤー(自分・CPU/対戦相手)のプレイでflying-inが発生することを確認');
      }
    }

    // ---- BGMリピート機能の検証 ----
    await page.evaluate(() => document.getElementById('btn-bgm-toggle').click());
    await page.waitForTimeout(150);
    const bgmModeInitial = await page.evaluate(() => document.getElementById('bgm-repeat').dataset.mode || 'all');
    ok(`BGMリピート初期モード: ${bgmModeInitial}`);
    const bgmModeAfterClick1 = await page.evaluate(() => {
      document.getElementById('bgm-repeat').click();
      return document.getElementById('bgm-repeat').dataset.mode;
    });
    const bgmModeAfterClick2 = await page.evaluate(() => {
      document.getElementById('bgm-repeat').click();
      return document.getElementById('bgm-repeat').dataset.mode;
    });
    const bgmModeAfterClick3 = await page.evaluate(() => {
      document.getElementById('bgm-repeat').click();
      return document.getElementById('bgm-repeat').dataset.mode;
    });
    ok(`BGMリピートモード遷移: ${bgmModeInitial} -> ${bgmModeAfterClick1} -> ${bgmModeAfterClick2} -> ${bgmModeAfterClick3}`);
    const modes = [bgmModeInitial, bgmModeAfterClick1, bgmModeAfterClick2, bgmModeAfterClick3];
    if (new Set(modes.slice(0, 3)).size !== 3 || modes[3] !== modes[0]) {
      fail(`BGMリピートが off/all/one の3状態を正しく循環しなかった: ${modes.join(',')}`);
    } else {
      ok('BGMリピートボタンが off/all/one を正しく循環する');
    }
    await page.screenshot({ path: `${OUT}/06_bgm_repeat.png` });

    // ---- J/Q/K 絵柄カード(絵札アート)の検証 ----
    const faceArtInfo = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('#hand-cards .playing-card .face-art'));
      return {
        count: imgs.length,
        srcs: imgs.map((im) => im.getAttribute('src') || ''),
        naturalWidths: imgs.map((im) => im.naturalWidth),
      };
    });
    ok(`手札内のJ/Q/K絵柄画像数: ${faceArtInfo.count}, srcs=${faceArtInfo.srcs.join(' / ')}`);
    if (faceArtInfo.count > 0) {
      if (faceArtInfo.srcs.some((s) => !/^\/cards\/[jqk]-[schd]\.png$/.test(s))) {
        fail(`face-art画像のsrcパスが想定と異なる: ${faceArtInfo.srcs.join(',')}`);
      } else {
        ok('face-art画像のsrcパスは /cards/{j,q,k}-{s,c,h,d}.png (スート別)形式');
      }
      if (faceArtInfo.naturalWidths.some((w) => !w)) {
        fail('face-art画像の読み込みに失敗しているものがある(naturalWidth=0、404の可能性)');
      } else {
        ok('face-art画像はすべて正常に読み込まれている(404なし)');
      }
    } else {
      ok('(手札にJ/Q/Kが無かったためこのチェックはスキップ)');
    }

    // ---- スタンプ機能の検証 ----
    // bot(ぼたん)がスタンプ受信を監視できるようにしておく
    let receivedSticker = null;
    bots[0].once('game:stickerReceived', (payload) => { receivedSticker = payload; });

    await page.evaluate(() => document.getElementById('btn-sticker-toggle').click());
    await page.waitForTimeout(150);
    const panelVisible = await page.evaluate(() => !document.getElementById('sticker-panel').hidden);
    if (!panelVisible) fail('スタンプパネルが開かなかった');
    else ok('スタンプパネルが開いた');

    const stickerBtnCount = await page.evaluate(() => document.querySelectorAll('#sticker-panel button').length);
    if (stickerBtnCount !== 10) fail(`スタンプの数が10個でない (${stickerBtnCount})`);
    else ok('スタンプが10種類表示されている');

    await page.evaluate(() => document.querySelectorAll('#sticker-panel button')[0].click());
    await page.waitForTimeout(400);

    // 自分の画面にスタンプが表示されるか
    const bubbleShown = await page.evaluate(() => document.querySelectorAll('.sticker-bubble').length > 0);
    if (!bubbleShown) fail('スタンプ送信後に自分の画面にスタンプが表示されなかった');
    else ok('スタンプ送信後にアニメーション付きで表示された');

    // 他プレイヤー(bot)に届いたか
    await page.waitForTimeout(300);
    if (!receivedSticker) {
      fail('他のプレイヤーにスタンプがブロードキャストされなかった');
    } else {
      ok(`他のプレイヤーにスタンプが届いた (stickerId=${receivedSticker.stickerId}, from=${receivedSticker.playerName})`);
    }
    await page.screenshot({ path: `${OUT}/05_sticker.png` });

    // 連投防止(クールダウン)の確認: サーバー側で短時間の連続送信が拒否されることを直接確認
    const cooldownResults = await new Promise((resolve) => {
      bots[0].emit('game:sticker', { stickerId: 'pass' }, (res1) => {
        bots[0].emit('game:sticker', { stickerId: 'pass' }, (res2) => {
          resolve([res1, res2]);
        });
      });
    });
    if (cooldownResults[0].ok && !cooldownResults[1].ok) {
      ok('連続送信はサーバー側のクールダウンで拒否される');
    } else {
      fail(`クールダウンの検証結果が想定と異なる: ${JSON.stringify(cooldownResults)}`);
    }

    // 不正なstickerIdは拒否されることを確認
    const invalidResult = await new Promise((resolve) => {
      bots[0].emit('game:sticker', { stickerId: '../../etc/passwd' }, resolve);
    });
    if (invalidResult.ok) fail('不正なstickerIdが受理されてしまった');
    else ok('不正なstickerIdは拒否される');
  }

  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/04_final_state.png`, fullPage: true });

  // youtube iframe API 等の外部リソース読み込み失敗はサンドボックス環境のネットワーク制限によるもので
  // アプリのバグではないため、それ以外の予期しないJSエラーだけをチェックする
  const realErrors = pageErrors.filter((e) => !/youtube/i.test(e) && !/Failed to load resource/i.test(e));
  if (realErrors.length > 0) {
    fail(`ページ内でエラーが発生: ${realErrors.slice(0, 5).join(' | ')}`);
  } else {
    ok('ページエラーなし(youtube iframe APIの読み込み失敗は環境上のネットワーク制限のため除外)');
  }

  bots.forEach((s) => s.close());
  await browser.close();
  serverProc.kill();
  await new Promise((r) => setTimeout(r, 300));

  if (process.exitCode) {
    console.error('\nUI検証: 失敗があります ❌');
  } else {
    console.log('\nUI検証: すべて成功しました ✅');
  }
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
