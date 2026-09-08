'use strict';
/**
 * server/game.js のルールを直接検証する簡易テスト (外部ライブラリ不使用)
 * 実行: node test/game.test.js
 */
const assert = require('assert');
const { DaifugoGame } = require('../server/game');

let passCount = 0;
function check(label, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ok - ${label}`);
  } catch (e) {
    console.error(`  FAIL - ${label}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function card(suit, rank) {
  return { id: `${suit}${rank}`, suit, rank, joker: false };
}
function joker() {
  return { id: 'JOKER', suit: null, rank: 'JOKER', joker: true };
}

function freshGame(playerIds = ['p1', 'p2', 'p3', 'p4'], rules) {
  const g = new DaifugoGame(playerIds.map((id) => ({ id, name: id })), rules);
  g.phase = 'PLAYING';
  g.order = playerIds.slice();
  g.turnIndex = 0;
  g.field = null;
  g.revolution = false;
  g.lockedSuits = null;
  g.lastSuits = null;
  g.passed = new Set();
  g.finished = [];
  g.leaderId = null;
  g.hands = {};
  playerIds.forEach((id) => (g.hands[id] = []));
  return g;
}

console.log('=== 大富豪ゲームロジック テスト ===');

check('通常の出し→全員パスで場が流れ、元のプレイヤーに戻る', () => {
  const g = freshGame();
  // 4/5/7/8/10/J は特殊効果(4戻し/5のスキップ/7渡し/8切り/10捨て/イレブンバック)が
  // 発動するランクなので、このテストでは無関係な6を使う
  g.hands.p1 = [card('H', '6'), card('H', '9')]; // 出した後も手札が残る
  g.hands.p2 = [card('S', '9')];
  g.hands.p3 = [card('D', '9')];
  g.hands.p4 = [card('C', '9')];

  let r = g.playCards('p1', ['H6']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.order[g.turnIndex], 'p2');

  r = g.pass('p2');
  assert.strictEqual(r.ok, true);
  r = g.pass('p3');
  assert.strictEqual(r.ok, true);
  r = g.pass('p4');
  assert.strictEqual(r.ok, true);

  // 全員パス -> 場が流れて p1 に戻る (p1はまだ手札があるので再度リード)
  assert.strictEqual(g.field, null);
  assert.strictEqual(g.order[g.turnIndex], 'p1');
});

check('リーダーがあがった後、全員パスすると次の人にリードが移る', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '6')]; // これ1枚だけ -> 出したらあがる (6は特殊効果のないランク)
  g.hands.p2 = [card('S', '9')];
  g.hands.p3 = [card('D', '9')];
  g.hands.p4 = [card('C', '9')];

  let r = g.playCards('p1', ['H6']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.finished.includes('p1'), true, 'p1はあがっているはず');

  g.pass('p2');
  g.pass('p3');
  g.pass('p4');

  // p1はあがっているのでリードできない -> 次の active player (p2) に移る
  assert.strictEqual(g.field, null);
  assert.strictEqual(g.order[g.turnIndex], 'p2');
  assert.strictEqual(g.leaderId, 'p2');
});

check('弱いカードでは出せない', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '9')];
  g.hands.p2 = [card('S', '5')];
  g.playCards('p1', ['H9']);
  const r = g.playCards('p2', ['S5']);
  assert.strictEqual(r.ok, false);
});

check('8切りで場が流れて同じ人が続けて出せる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '8'), card('H', '3')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H8']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.field, null, '8切り後は場が空になる');
  assert.strictEqual(g.order[g.turnIndex], 'p1', '8切り後は同じプレイヤーの番');
});

check('革命: 4枚出しで強弱が逆転する', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '5'), card('S', '5'), card('D', '5'), card('C', '5')];
  g.hands.p2 = [card('H', '3'), card('S', '3')];
  const r = g.playCards('p1', ['H5', 'S5', 'D5', 'C5']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.revolution, true, '革命が発生しているはず');
});

check('しばり: 同じスートの単騎が2回続くとロックされ、違うスートは出せない', () => {
  const g = freshGame();
  // 4/7/J は4戻し/7渡し/イレブンバックが発動してしまうので、このテストでは無関係な6を使う
  g.hands.p1 = [card('H', '6')];
  g.hands.p2 = [card('H', '9')];
  g.hands.p3 = [card('S', 'Q')]; // 9より強いランクにして、失敗理由が強さでなくしばりだと分かるようにする
  g.hands.p4 = [card('H', 'J')];

  g.playCards('p1', ['H6']); // 1回目 ハート
  assert.strictEqual(g.lockedSuits, null);
  g.playCards('p2', ['H9']); // 2回目 ハート -> しばり成立
  assert.deepStrictEqual(g.lockedSuits, ['H']);

  const r = g.playCards('p3', ['SQ']); // 9より強いがスペードなので出せないはず
  assert.strictEqual(r.ok, false);

  const r2 = g.playCards('p3'.replace('p3', 'p3'), ['SQ']);
  assert.strictEqual(r2.ok, false);
});

check('スペ3返し: ジョーカー単騎をスペードの3で返せる', () => {
  const g = freshGame(['p1', 'p2']);
  g.hands.p1 = [joker(), card('H', '3')]; // 手札を空にしないよう予備カードを持たせる
  g.hands.p2 = [card('S', '3')];
  g.playCards('p1', ['JOKER']);
  const r = g.playCards('p2', ['S3']);
  assert.strictEqual(r.ok, true, 'スペ3はジョーカーに勝てるはず');
});

check('あがり順位が正しく記録される (4人)', () => {
  const g = freshGame();
  // 4/5は4戻し/5のスキップで手番の進み方が変わってしまうので、無関係な3/6/9/Qを使う
  g.hands.p1 = [card('H', '3')];
  g.hands.p2 = [card('H', '6')];
  g.hands.p3 = [card('H', '9')];
  g.hands.p4 = [card('H', 'Q')];

  let r = g.playCards('p1', ['H3']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.finished.includes('p1'), true, 'p1はあがったはず');

  r = g.playCards('p2', ['H6']);
  assert.strictEqual(g.finished.includes('p2'), true);

  r = g.playCards('p3', ['H9']);
  // この時点で p4 だけが残る -> ラウンド終了、p4が自動的に大貧民
  assert.strictEqual(r.roundOver, true);
  assert.deepStrictEqual(g.finished, ['p1', 'p2', 'p3', 'p4']);
  assert.strictEqual(g.prevRoles.p1, '大富豪');
  assert.strictEqual(g.prevRoles.p4, '大貧民');
});

check('カード交換: 大貧民の最強2枚が大富豪に渡る', () => {
  const g = freshGame();
  g.prevFinishOrder = ['p1', 'p2', 'p3', 'p4']; // p1=大富豪 p4=大貧民 (前ラウンド)
  g.prevRoles = { p1: '大富豪', p2: '富豪', p3: '貧民', p4: '大貧民' };
  g.round = 1;
  const result = g.startRound(); // 実際の配札はランダムだが交換ロジックを検証
  assert.strictEqual(result.needsExchange, true);
  assert.strictEqual(g.phase, 'EXCHANGE');
  const task = g.pendingExchange.returns.find((t) => t.playerId === 'p1');
  assert.ok(task, '大富豪(p1)が返すタスクがあるはず');
  assert.strictEqual(task.count, 2);

  // p1 (大富豪) が最初の2枚を選んで返す
  const cardsToReturn = g.hands.p1.slice(0, 2).map((c) => c.id);
  const r = g.submitExchangeReturn('p1', cardsToReturn);
  assert.strictEqual(r.ok, true);

  const task2 = g.pendingExchange && g.pendingExchange.returns.find((t) => t.playerId === 'p2');
  if (task2) {
    const cardsToReturn2 = g.hands.p2.slice(0, 1).map((c) => c.id);
    g.submitExchangeReturn('p2', cardsToReturn2);
  }
  assert.strictEqual(g.phase, 'PLAYING', '両方の交換が終わればPLAYINGに戻る');
});

check('ルールOFF: 8切りを無効にすると場が流れない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { eightCut: false });
  g.hands.p1 = [card('H', '8'), card('H', '3')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H8']);
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(g.field, null, '8切りOFFなら場は流れないはず');
  assert.strictEqual(g.order[g.turnIndex], 'p2', '8切りOFFなら次のプレイヤーの番になるはず');
});

check('ルールOFF: 革命を無効にすると4枚出しでも強さは変わらない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { revolution: false });
  g.hands.p1 = [card('H', '5'), card('S', '5'), card('D', '5'), card('C', '5')];
  const r = g.playCards('p1', ['H5', 'S5', 'D5', 'C5']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.revolution, false, '革命OFFなら強さは逆転しないはず');
});

check('ルールOFF: ジョーカーを使わない設定では山札に入らない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { useJoker: false });
  g.round = 0;
  g.prevRoles = null;
  g.startRound();
  const allCards = Object.values(g.hands).flat();
  assert.strictEqual(allCards.some((c) => c.joker), false, 'ジョーカーが配られていないはず');
  assert.strictEqual(allCards.length, 52, '52枚のみ配られるはず');
});

check('演出用のeffects: 革命と8切りが同時に発生すると両方記録される', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4']);
  g.hands.p1 = [card('H', '8'), card('S', '8'), card('D', '8'), card('C', '8')];
  const r = g.playCards('p1', ['H8', 'S8', 'D8', 'C8']);
  assert.strictEqual(r.ok, true);
  assert.ok(g.lastEffects.includes('REVOLUTION'));
  assert.ok(g.lastEffects.includes('EIGHT_CUT'));
  assert.strictEqual(g.lastEffectBy, 'p1');
});

check('7渡し: 7を出すとSEVEN_GIVEフェーズに入り、通常のプレイが止まる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '7'), card('S', '5'), card('D', '5')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H7']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needsSevenGive, true);
  assert.strictEqual(g.phase, 'SEVEN_GIVE');
  assert.ok(g.pendingSevenGive);
  assert.strictEqual(g.pendingSevenGive.playerId, 'p1');
  assert.strictEqual(g.pendingSevenGive.count, 1);
  assert.deepStrictEqual(g.pendingSevenGive.candidates.sort(), ['p2', 'p3', 'p4']);

  // フェーズ中は他のプレイヤーは出せない
  const blocked = g.playCards('p2', ['S9']);
  assert.strictEqual(blocked.ok, false);
});

check('7渡し: submitSevenGiveでカードが移動し、ターンが進む', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '7'), card('S', '5')];
  g.hands.p2 = [card('C', '9')];
  g.playCards('p1', ['H7']);
  assert.strictEqual(g.phase, 'SEVEN_GIVE');

  const r = g.submitSevenGive('p1', ['S5'], 'p3');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.phase, 'PLAYING');
  assert.strictEqual(g.pendingSevenGive, null);
  assert.ok(g.hands.p3.some((c) => c.id === 'S5'), '渡したカードが相手の手札に入っているはず');
  assert.strictEqual(g.hands.p1.some((c) => c.id === 'S5'), false, '渡したカードは自分の手札から消えるはず');
  assert.strictEqual(g.order[g.turnIndex], 'p2', '7渡し完了後は次のプレイヤーの番になるはず');
});

check('7渡し: 手札を全部渡してあがった場合はFINISH扱いになる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '7'), card('S', '5')];
  g.hands.p2 = [card('C', '9')];
  g.playCards('p1', ['H7']);
  const r = g.submitSevenGive('p1', ['S5'], 'p3');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.hands.p1.length, 0);
  assert.ok(g.finished.includes('p1'), '手札が0枚になったらあがり扱いになるはず');
  assert.ok(g.lastEffects.includes('FINISH'));
});

check('7渡し: 候補がいない(全員あがり済み)場合は渡さずそのまま進む', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '7'), card('S', '5')];
  g.hands.p2 = [];
  g.hands.p3 = [];
  g.hands.p4 = [];
  g.finished = ['p2', 'p3', 'p4'];
  const r = g.playCards('p1', ['H7']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.roundOver, true, '他全員あがっていれば即ラウンド終了になるはず');
});

check('ルールOFF: 7渡しを無効にすると7を出してもSEVEN_GIVEに入らない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { sevenGive: false });
  g.hands.p1 = [card('H', '7'), card('S', '5')];
  g.hands.p2 = [card('C', '9')];
  const r = g.playCards('p1', ['H7']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.phase, 'PLAYING', '7渡しOFFなら通常通りPLAYINGのまま');
  assert.strictEqual(g.order[g.turnIndex], 'p2');
});

check('イレブンバック: Jを出すとこのトリック限定で強さが逆転する', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', 'J')];
  g.hands.p2 = [card('S', '5'), card('S', 'K')];
  let r = g.playCards('p1', ['HJ']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.elevenBack, true);
  assert.ok(g.lastEffects.includes('ELEVEN_BACK'));

  // イレブンバック中は通常より弱いランクの方が「強い」扱いになる
  const weakerRankPlay = g.validatePlay('p2', ['S5']);
  assert.strictEqual(weakerRankPlay.ok, true, 'イレブンバック中は5がJより強く出せるはず');
  const strongerRankPlay = g.validatePlay('p2', ['SK']);
  assert.strictEqual(strongerRankPlay.ok, false, 'イレブンバック中はKはJより弱く扱われるはず');
});

check('イレブンバック: 場が流れるとリセットされる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', 'J'), card('S', '8'), card('D', '8'), card('C', '8'), card('H', '8')];
  g.playCards('p1', ['HJ']); // 単騎なのでターンはp2に進む
  assert.strictEqual(g.elevenBack, true);
  g.turnIndex = g.order.indexOf('p1'); // テスト用にp1のターンへ戻す (場は空のまま新しい一手として8切り)
  g.field = null;
  const r = g.playCards('p1', ['S8', 'D8', 'C8', 'H8']); // 8切りで場が流れる
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.elevenBack, false, '場が流れたらイレブンバックはリセットされるはず');
});

check('イレブンバック: 革命中に発動すると二重反転で通常と同じ向きになる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '5'), card('S', '5'), card('D', '5'), card('C', '5'), card('H', 'J')];
  g.playCards('p1', ['H5', 'S5', 'D5', 'C5']); // 革命発生 (4枚出しなので場には4枚要求が残る)
  assert.strictEqual(g.revolution, true);
  assert.strictEqual(g.effectiveRevolution(), true);

  // テスト用に場をリセットして、J単騎を新しい一手として出せるようにする
  g.turnIndex = g.order.indexOf('p1');
  g.field = null;
  const r = g.playCards('p1', ['HJ']); // イレブンバックで一時的に打ち消す
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.elevenBack, true);
  assert.strictEqual(g.effectiveRevolution(), false, '革命中にイレブンバックが起きると実質通常の強さ順に戻るはず');
});

check('ルールOFF: イレブンバックを無効にするとJを出しても強さは変わらない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { elevenBack: false });
  g.hands.p1 = [card('H', 'J')];
  const r = g.playCards('p1', ['HJ']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.elevenBack, false, 'イレブンバックOFFなら反転しないはず');
});

check('5のスキップ: 5を出すと次のプレイヤーの番が飛ばされる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '5'), card('H', '3')]; // 出した後も手札が残る
  g.hands.p2 = [card('S', '9')];
  g.hands.p3 = [card('D', '9')];
  g.hands.p4 = [card('C', '9')];
  const r = g.playCards('p1', ['H5']);
  assert.strictEqual(r.ok, true);
  assert.ok(g.lastEffects.includes('FIVE_SKIP'));
  assert.strictEqual(g.order[g.turnIndex], 'p3', 'p2の番はスキップされ、p3の番になるはず');
});

check('ルールOFF: 5のスキップを無効にすると次のプレイヤーの番になる', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { fiveSkip: false });
  g.hands.p1 = [card('H', '5'), card('H', '3')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H5']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.order[g.turnIndex], 'p2', '5のスキップOFFなら通常通り次のプレイヤーの番になるはず');
});

check('10捨て: 10を出すと場が流れて同じ人が続けて出せる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '10'), card('H', '3')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H10']);
  assert.strictEqual(r.ok, true);
  assert.ok(g.lastEffects.includes('TEN_CLEAR'));
  assert.strictEqual(g.field, null, '10捨て後は場が空になる');
  assert.strictEqual(g.order[g.turnIndex], 'p1', '10捨て後は同じプレイヤーの番');
});

check('ルールOFF: 10捨てを無効にすると場は流れない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { tenClear: false });
  g.hands.p1 = [card('H', '10'), card('H', '3')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H10']);
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(g.field, null, '10捨てOFFなら場は流れないはず');
  assert.strictEqual(g.order[g.turnIndex], 'p2', '10捨てOFFなら次のプレイヤーの番になるはず');
});

check('4戻し: 4を出すと順番が1つ前のプレイヤーに戻る', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '4'), card('H', '3')]; // 出した後も手札が残る
  g.hands.p2 = [card('S', '9')];
  g.hands.p3 = [card('D', '9')];
  g.hands.p4 = [card('C', '9')];
  const r = g.playCards('p1', ['H4']);
  assert.strictEqual(r.ok, true);
  assert.ok(g.lastEffects.includes('FOUR_RETURN'));
  assert.strictEqual(g.order[g.turnIndex], 'p4', '前のプレイヤー(p4)の番に戻るはず');
});

check('ルールOFF: 4戻しを無効にすると次のプレイヤーの番になる', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { fourReturn: false });
  g.hands.p1 = [card('H', '4'), card('H', '3')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H4']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.order[g.turnIndex], 'p2', '4戻しOFFなら通常通り次のプレイヤーの番になるはず');
});

check('救急車: 9を2枚出すと場が流れて同じ人が続けて出せる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '9'), card('S', '9'), card('H', '3')];
  g.hands.p2 = [card('S', '6')];
  const r = g.playCards('p1', ['H9', 'S9']);
  assert.strictEqual(r.ok, true);
  assert.ok(g.lastEffects.includes('AMBULANCE'));
  assert.strictEqual(g.field, null, '救急車で場が流れるはず');
  assert.strictEqual(g.order[g.turnIndex], 'p1', '救急車後は同じプレイヤーの番');
});

check('救急車: 9を3枚出しでは発動しない', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '9'), card('S', '9'), card('D', '9'), card('H', '3')];
  g.hands.p2 = [card('S', '6')];
  const r = g.playCards('p1', ['H9', 'S9', 'D9']);
  assert.strictEqual(r.ok, true);
  assert.ok(!g.lastEffects.includes('AMBULANCE'), '3枚出しでは救急車は発動しないはず');
  assert.notStrictEqual(g.field, null, '3枚出しでは場は流れないはず');
  assert.strictEqual(g.order[g.turnIndex], 'p2');
});

check('ルールOFF: 救急車を無効にすると9の2枚出しでも場は流れない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { ambulance: false });
  g.hands.p1 = [card('H', '9'), card('S', '9')];
  g.hands.p2 = [card('S', '6')];
  const r = g.playCards('p1', ['H9', 'S9']);
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(g.field, null, '救急車OFFなら場は流れないはず');
  assert.strictEqual(g.order[g.turnIndex], 'p2');
});

check('ろくろ首: 6を2枚出すと場が流れて同じ人が続けて出せる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '6'), card('S', '6'), card('H', '3')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H6', 'S6']);
  assert.strictEqual(r.ok, true);
  assert.ok(g.lastEffects.includes('ROKUROKUBI'));
  assert.strictEqual(g.field, null, 'ろくろ首で場が流れるはず');
  assert.strictEqual(g.order[g.turnIndex], 'p1', 'ろくろ首後は同じプレイヤーの番');
});

check('ルールOFF: ろくろ首を無効にすると6の2枚出しでも場は流れない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { rokurokubi: false });
  g.hands.p1 = [card('H', '6'), card('S', '6')];
  g.hands.p2 = [card('S', '9')];
  const r = g.playCards('p1', ['H6', 'S6']);
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(g.field, null, 'ろくろ首OFFなら場は流れないはず');
  assert.strictEqual(g.order[g.turnIndex], 'p2');
});

check('都落ち: 前回大富豪が今回1位を逃すと強制的に大貧民になる', () => {
  const g = freshGame();
  g.prevFinishOrder = ['p1', 'p2', 'p3', 'p4']; // 前回: p1が大富豪
  g.hands.p1 = [card('H', '3'), card('S', '3')];
  g.hands.p2 = [card('H', '9')];
  g.hands.p3 = [card('D', '9')];
  g.hands.p4 = [card('C', '9')];
  g.turnIndex = g.order.indexOf('p2');

  // p2が1位であがる -> 前回大富豪のp1が都落ちして強制的に脱落する
  let r = g.playCards('p2', ['H9']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.finished[0], 'p2');
  assert.strictEqual(g.miyakoochiId, 'p1', '前回大富豪のp1が都落ち対象になるはず');
  assert.strictEqual(g.hands.p1.length, 0, '都落ちで手札を放棄する');
  assert.ok(g.finished.includes('p1'), 'p1は強制的に脱落してfinishedに入る');
  assert.strictEqual(g.phase, 'PLAYING', 'まだp3・p4が残っているのでラウンドは続く');

  // p3・p4がパス -> 誰も応答できず場が流れてp3がリードし直す
  g.pass('p3');
  g.pass('p4');
  r = g.playCards('p3', ['D9']);
  assert.strictEqual(r.ok, true);

  // p3があがると残りp4だけになり、ラウンドが終了する
  assert.strictEqual(g.phase, 'ROUND_END');
  // 都落ち対象のp1は、実際にあがった順番(2番目)に関わらず必ず最下位(大貧民)になる
  assert.strictEqual(g.finished[g.finished.length - 1], 'p1', 'p1は最下位(大貧民)になるはず');
  assert.strictEqual(g.finished.includes('p4'), true);
});

check('ルールOFF: 都落ちを無効にすると前回大富豪が1位を逃しても脱落しない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { miyakoochi: false });
  g.prevFinishOrder = ['p1', 'p2', 'p3', 'p4'];
  g.hands.p1 = [card('H', '3'), card('S', '3')];
  g.hands.p2 = [card('H', '9')];
  g.turnIndex = g.order.indexOf('p2');
  const r = g.playCards('p2', ['H9']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.miyakoochiId, null, '都落ちOFFなら発動しないはず');
  assert.strictEqual(g.hands.p1.length, 2, '都落ちOFFならp1の手札はそのまま残るはず');
  assert.ok(!g.finished.includes('p1'), '都落ちOFFならp1は脱落しないはず');
});

check('階段: 同じスートの連続した3枚以上をまとめて出せる', () => {
  const g = freshGame();
  const combo = g.analyzeCombo([card('H', '5'), card('H', '6'), card('H', '7')]);
  assert.ok(combo, '階段として成立するはず');
  assert.strictEqual(combo.kind, 'straight');
  assert.strictEqual(combo.suit, 'H');
  assert.strictEqual(combo.lowRank, '5');
  assert.strictEqual(combo.highRank, '7');
  assert.strictEqual(combo.count, 3);
});

check('階段: ジョーカーで途中の欠番を穴埋めできる', () => {
  const g = freshGame();
  const combo = g.analyzeCombo([card('H', '5'), joker(), card('H', '7')]);
  assert.ok(combo, 'ジョーカー穴埋めの階段が成立するはず');
  assert.strictEqual(combo.kind, 'straight');
  assert.strictEqual(combo.lowRank, '5');
  assert.strictEqual(combo.highRank, '7');
  assert.strictEqual(combo.jokerCount, 1);
});

check('階段: スートが違うと成立しない', () => {
  const g = freshGame();
  const combo = g.analyzeCombo([card('H', '5'), card('S', '6'), card('H', '7')]);
  assert.strictEqual(combo, null, 'スートが混ざっていると階段は成立しないはず');
});

check('階段: 同じランクが重複すると成立しない', () => {
  const g = freshGame();
  const combo = g.analyzeCombo([card('H', '5'), card('H', '5'), card('H', '7')]);
  assert.strictEqual(combo, null, '同じランクの重複があると階段は成立しないはず');
});

check('階段: ジョーカーの枚数が欠番より多い/少ないと成立しない', () => {
  const g = freshGame();
  // 5,6,7,8 のうち6と8が欠番(2枚欠け)なのにジョーカーが1枚だけ -> 不成立
  const combo = g.analyzeCombo([card('H', '5'), joker(), card('H', '8')]);
  assert.strictEqual(combo, null, '欠番の数とジョーカーの枚数が合わないと不成立のはず');
});

check('階段: 2枚以下では成立しない', () => {
  const g = freshGame();
  const combo = g.analyzeCombo([card('H', '5'), card('H', '6')]);
  assert.strictEqual(combo, null, '階段は3枚以上必要なはず');
});

check('ルールOFF: 階段を無効にすると連続した数字を出しても成立しない', () => {
  const g = freshGame(['p1', 'p2', 'p3', 'p4'], { straight: false });
  const combo = g.analyzeCombo([card('H', '5'), card('H', '6'), card('H', '7')]);
  assert.strictEqual(combo, null, '階段ルールOFFなら成立しないはず');
});

check('階段: 階段より強い階段で返せる (開始ランクの高さで比較)', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '5'), card('H', '6'), card('H', '7')];
  g.hands.p2 = [card('S', '8'), card('S', '9'), card('S', '10')];
  let r = g.playCards('p1', ['H5', 'H6', 'H7']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.field.kind, 'straight');
  r = g.playCards('p2', ['S8', 'S9', 'S10']);
  assert.strictEqual(r.ok, true, '開始ランクがより高い階段は勝てるはず');
  assert.strictEqual(g.order[g.turnIndex], 'p3');
});

check('階段: セットでは階段に勝てず、階段ではセットに勝てない', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '5'), card('H', '6'), card('H', '7')];
  g.hands.p2 = [card('S', 'K'), card('D', 'K'), card('C', 'K')];
  let r = g.playCards('p1', ['H5', 'H6', 'H7']);
  assert.strictEqual(r.ok, true);
  r = g.playCards('p2', ['SK', 'DK', 'CK']);
  assert.strictEqual(r.ok, false, '階段が場にある時はセットで返せないはず');

  const g2 = freshGame();
  g2.hands.p1 = [card('H', '5'), card('S', '5'), card('D', '5')];
  g2.hands.p2 = [card('S', '8'), card('S', '9'), card('S', '10')];
  r = g2.playCards('p1', ['H5', 'S5', 'D5']);
  assert.strictEqual(r.ok, true);
  r = g2.playCards('p2', ['S8', 'S9', 'S10']);
  assert.strictEqual(r.ok, false, 'セットが場にある時は階段で返せないはず');
});

check('階段: しばり中でもロック対象と同じスートの階段なら出せる', () => {
  const g = freshGame();
  g.hands.p1 = [card('H', '5'), card('H', '6'), card('H', '7')];
  g.field = {
    cards: [card('H', '3'), card('H', '4'), card('H', 'Q')],
    count: 3, kind: 'straight', suit: 'H', lowRank: '3', highRank: 'Q', playerId: 'p2',
  };
  g.lockedSuits = ['H'];
  g.lastSuits = ['H'];
  g.leaderId = 'p2';
  g.turnIndex = g.order.indexOf('p1');
  const r = g.playCards('p1', ['H5', 'H6', 'H7']);
  assert.strictEqual(r.ok, true, 'ロック対象と同じスートの階段は出せるはず');
});

check('階段: しばり中にロック対象と違うスートの階段は出せない', () => {
  const g = freshGame();
  g.hands.p3 = [card('S', '8'), card('S', '9'), card('S', '10')];
  g.field = {
    cards: [card('H', '3'), card('H', '4'), card('H', 'Q')],
    count: 3, kind: 'straight', suit: 'H', lowRank: '3', highRank: 'Q', playerId: 'p2',
  };
  g.lockedSuits = ['H'];
  g.lastSuits = ['H'];
  g.leaderId = 'p2';
  g.turnIndex = g.order.indexOf('p3');
  const r = g.playCards('p3', ['S8', 'S9', 'S10']);
  assert.strictEqual(r.ok, false, 'しばり中のスート以外の階段は出せないはず(強さでは勝っているのに弾かれる)');
});

console.log(`\n${passCount} 件成功`);
if (process.exitCode) {
  console.error('テスト失敗があります');
} else {
  console.log('すべてのテストが成功しました ✅');
}
