'use strict';
const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
const OUT = '/home/claude/preview';

(async () => {
  const fs = require('fs');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx1 = await browser.newContext({ viewport: { width: 480, height: 800 } });
  const ctx2 = await browser.newContext({ viewport: { width: 480, height: 800 } });
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  // 1. ホーム画面
  await p1.goto(BASE);
  await p1.fill('#input-name', 'せな');
  await p1.screenshot({ path: `${OUT}/01_home.png` });

  // 2. ルーム作成 -> ロビー画面
  await p1.click('#btn-create');
  await p1.waitForSelector('#screen-lobby:not([hidden])');
  const roomCode = await p1.textContent('#lobby-roomcode');
  console.log('roomCode:', roomCode);
  await p1.screenshot({ path: `${OUT}/02_lobby_host.png` });

  // 3. 2人目が参加
  await p2.goto(BASE);
  await p2.fill('#input-name', 'ゆう');
  await p2.fill('#input-roomcode', roomCode.trim());
  await p2.click('#btn-join');
  await p2.waitForSelector('#screen-lobby:not([hidden])');
  await p1.waitForTimeout(400);
  await p1.screenshot({ path: `${OUT}/03_lobby_two_players.png` });
  await p2.screenshot({ path: `${OUT}/04_lobby_guest_view.png` });

  // 4. ゲーム開始
  await p1.click('#btn-start');
  await p1.waitForSelector('#screen-game:not([hidden])');
  await p2.waitForSelector('#screen-game:not([hidden])');
  await p1.waitForTimeout(400);
  await p1.screenshot({ path: `${OUT}/05_game_start.png` });

  // 5. カードを1枚選んで出す演出も見せる (先手の手札から1枚クリック)
  const currentTurnEl = await p1.evaluate(() => {
    return document.querySelector('#hand-cards .playing-card') ? true : false;
  });
  if (currentTurnEl) {
    // 手札の中から一番左(最弱)のカードを選択してハイライト状態を見せる
    await p1.click('#hand-cards .playing-card >> nth=0');
    await p1.waitForTimeout(200);
    await p1.screenshot({ path: `${OUT}/06_card_selected.png` });
  }

  await browser.close();
  console.log('DONE');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
