'use strict';

/**
 * 大富豪 (Daifugo / Daihinmin) ゲームロジック
 * ------------------------------------------------
 * 収録ルール:
 *  - 8切り (8を出すと場が流れる、続けて出せる)
 *  - 革命 (4枚以上の同ランクで強弱が逆転)
 *  - しばり (同じスートの出し方が連続すると、場が流れるまでそのスート縛り)
 *  - ジョーカー (最強の1枚として出せる。スペードの3で返せる=スペ3返し)
 *  - あがり順位 (大富豪・富豪・平民・貧民・大貧民)
 *  - 前回順位によるカード交換 (大富豪⇔大貧民は2枚、富豪⇔貧民は1枚)
 */

const SUITS = ['S', 'H', 'D', 'C']; // スペード・ハート・ダイヤ・クラブ
const SUIT_LABEL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

// ホストが対局作成時に選べるルール一覧とデフォルト値
const DEFAULT_RULES = {
  useJoker: true, // ジョーカーを使う
  eightCut: true, // 8切り
  revolution: true, // 革命 (4枚以上)
  shibari: true, // しばり
  spade3Return: true, // スペードの3返し (ジョーカー単騎に対して)
  cardExchange: true, // 次ラウンドのカード交換
  sevenGive: true, // 7渡し (7を出した枚数分、好きな相手にカードを渡す)
  elevenBack: true, // イレブンバック (Jを出すとそのトリック限定で強さが逆転)
};

function normalizeRules(rules) {
  const r = Object.assign({}, DEFAULT_RULES, rules || {});
  if (!r.useJoker) r.spade3Return = false; // ジョーカーが無ければスペ3返しも成立しない
  return r;
}

function makeDeck(useJoker) {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANK_ORDER) {
      cards.push({ id: `${suit}${rank}`, suit, rank, joker: false });
    }
  }
  if (useJoker) cards.push({ id: 'JOKER', suit: null, rank: 'JOKER', joker: true });
  return cards;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rankIndex(rank) {
  if (rank === 'JOKER') return 100;
  return RANK_ORDER.indexOf(rank);
}

// 通常時/革命時それぞれでの強さの数値化 (ジョーカーは常に最強)
function strengthOf(rank, revolution) {
  if (rank === 'JOKER') return 1000;
  const idx = rankIndex(rank);
  return revolution ? (RANK_ORDER.length - 1 - idx) : idx;
}

function roleNamesFor(n) {
  // n人プレイ時の順位名を返す (先頭が1位=大富豪)
  if (n <= 2) return ['大富豪', '大貧民'];
  if (n === 3) return ['大富豪', '平民', '大貧民'];
  if (n === 4) return ['大富豪', '富豪', '貧民', '大貧民'];
  if (n === 5) return ['大富豪', '富豪', '平民', '貧民', '大貧民'];
  // 6人以上: 大富豪, 富豪, 平民...平民, 貧民, 大貧民
  const middle = new Array(n - 4).fill('平民');
  return ['大富豪', '富豪', ...middle, '貧民', '大貧民'];
}

class DaifugoGame {
  /**
   * @param {{id:string, name:string}[]} players 座席順のプレイヤー一覧
   * @param {object} [rules] ホストが選んだルール設定 (省略時は全ルールON)
   */
  constructor(players, rules) {
    this.players = players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar || null }));
    this.rules = normalizeRules(rules);
    this.round = 0;
    this.hands = {}; // playerId -> card[]
    this.finished = []; // 今ラウンドであがった順 (playerId)
    this.prevRoles = null; // 前ラウンドの roleName by playerId
    this.log = [];
    this.phase = 'LOBBY'; // LOBBY -> EXCHANGE -> PLAYING -> ROUND_END -> (次ラウンド) or GAME_OVER
    this.field = null; // {cards, count, rank, playerId}
    this.revolution = false;
    this.lockedSuits = null;
    this.lastSuits = null;
    this.passed = new Set();
    this.order = this.players.map((p) => p.id);
    this.turnIndex = 0;
    this.pendingExchange = null; // {giverId->receiverId 強制分} 待ち情報
    this.leaderId = null;
    this.disconnected = new Set();
    this.seq = 0; // プレイのたびに増える通し番号 (演出のトリガー用)
    this.lastEffects = []; // 直近のプレイで発生した演出: 'REVOLUTION' | 'EIGHT_CUT' | 'SPADE3_RETURN' | 'FINISH' | 'ELEVEN_BACK'
    this.lastEffectBy = null;
    this.elevenBack = false; // イレブンバック: このトリック限定の強さ反転 (場が流れるとリセット)
    this.pendingSevenGive = null; // 7渡し待ち: {playerId, count, candidates, pendingClearField}
  }

  // このトリックで実際に使う「革命状態」(通常の革命 と イレブンバック の合成)
  effectiveRevolution() {
    return this.revolution !== this.elevenBack;
  }

  addLog(message) {
    this.log.push({ t: Date.now(), message });
    if (this.log.length > 200) this.log.shift();
  }

  activePlayerIds() {
    return this.order.filter((id) => !this.finished.includes(id) && !this.disconnected.has(id));
  }

  playerName(id) {
    const p = this.players.find((pl) => pl.id === id);
    return p ? p.name : '???';
  }

  // ----------------------------------------------------------------
  // ラウンド開始 (配札 + 前ラウンド順位に応じたカード交換の準備)
  // ----------------------------------------------------------------
  startRound() {
    this.round += 1;
    this.finished = [];
    this.field = null;
    this.revolution = false;
    this.lockedSuits = null;
    this.lastSuits = null;
    this.passed = new Set();
    this.log = [];

    const deck = shuffle(makeDeck(this.rules.useJoker));
    const activeIds = this.order.filter((id) => !this.disconnected.has(id));
    const hands = {};
    activeIds.forEach((id) => (hands[id] = []));
    let i = 0;
    for (const card of deck) {
      const id = activeIds[i % activeIds.length];
      hands[id].push(card);
      i++;
    }
    this.hands = hands;
    this.sortAllHands();

    this.addLog(`--- 第${this.round}ラウンド開始 (${activeIds.length}人) ---`);

    if (this.round === 1 || !this.prevRoles) {
      // 初回: クラブの3を持っている人からスタート
      let starter = activeIds[0];
      for (const id of activeIds) {
        if (this.hands[id].some((c) => c.suit === 'C' && c.rank === '3')) {
          starter = id;
          break;
        }
      }
      this.leaderId = starter;
      this.turnIndex = this.order.indexOf(starter);
      this.phase = 'PLAYING';
      this.addLog(`${this.playerName(starter)} がクラブの3を持っているので先手です。`);
      return { needsExchange: false };
    }

    if (!this.rules.cardExchange) {
      // カード交換ルールOFF: 前回の大貧民から (いなければ先頭から) スタート
      const daihinmin = this.prevFinishOrder && this.prevFinishOrder[this.prevFinishOrder.length - 1];
      this.leaderId = daihinmin && activeIds.includes(daihinmin) ? daihinmin : activeIds[0];
      this.turnIndex = this.order.indexOf(this.leaderId);
      this.phase = 'PLAYING';
      this.addLog('カード交換ルールはOFFです。');
      return { needsExchange: false };
    }

    // 2回目以降: 前回の順位に基づくカード交換
    return this.setupExchange(activeIds);
  }

  setupExchange(activeIds) {
    const n = activeIds.length;
    const roles = roleNamesFor(n);
    // 前回のプレイヤー構成が変わっている場合は交換をスキップ
    const roleOf = {};
    activeIds.forEach((id, idx) => {
      // 前回の finished 順を再利用できないケース(人数変化)は安全にスキップ
    });

    const daifugoId = this.prevFinishOrder && this.prevFinishOrder[0];
    const daihinminId = this.prevFinishOrder && this.prevFinishOrder[this.prevFinishOrder.length - 1];
    const fugoId = n >= 4 ? this.prevFinishOrder && this.prevFinishOrder[1] : null;
    const hinminId = n >= 4 ? this.prevFinishOrder && this.prevFinishOrder[this.prevFinishOrder.length - 2] : null;

    const valid = (id) => id && activeIds.includes(id);

    const tasks = [];
    if (valid(daifugoId) && valid(daihinminId) && daifugoId !== daihinminId) {
      tasks.push({ from: daihinminId, to: daifugoId, count: 2, forced: true });
    }
    if (n >= 4 && valid(fugoId) && valid(hinminId) && fugoId !== hinminId && new Set([daifugoId, daihinminId, fugoId, hinminId]).size === 4) {
      tasks.push({ from: hinminId, to: fugoId, count: 1, forced: true });
    }

    if (tasks.length === 0) {
      this.leaderId = daihinminId && activeIds.includes(daihinminId) ? daihinminId : activeIds[0];
      this.turnIndex = this.order.indexOf(this.leaderId);
      this.phase = 'PLAYING';
      this.addLog('前回のプレイヤー構成が変わったためカード交換はありません。');
      return { needsExchange: false };
    }

    // 強制側 (大貧民・貧民) は自動的に最強カードを提出
    const giveResults = [];
    for (const task of tasks) {
      const hand = this.hands[task.from];
      const sorted = hand
        .slice()
        .sort((a, b) => strengthOf(b.rank, false) - strengthOf(a.rank, false));
      const givenCards = sorted.slice(0, task.count);
      const givenIds = givenCards.map((c) => c.id);
      this.hands[task.from] = hand.filter((c) => !givenIds.includes(c.id));
      this.hands[task.to] = this.hands[task.to].concat(givenCards);
      giveResults.push({ from: task.from, to: task.to, cards: givenCards, count: task.count });
      this.addLog(
        `${this.playerName(task.from)} は ${this.playerName(task.to)} に強いカードを${task.count}枚渡しました。`
      );
    }
    this.sortAllHands();

    // 受け取った側 (大富豪・富豪) はカードを選んで返す必要がある
    this.pendingExchange = {
      returns: giveResults.map((r) => ({ playerId: r.to, count: r.count, to: r.from, done: false })),
    };
    this.phase = 'EXCHANGE';
    this.leaderId = daihinminId && activeIds.includes(daihinminId) ? daihinminId : activeIds[0];
    this.turnIndex = this.order.indexOf(this.leaderId);
    return { needsExchange: true };
  }

  // 大富豪/富豪がカードを選んで返す
  submitExchangeReturn(playerId, cardIds) {
    if (this.phase !== 'EXCHANGE' || !this.pendingExchange) {
      return { ok: false, error: '今は交換フェーズではありません。' };
    }
    const task = this.pendingExchange.returns.find((r) => r.playerId === playerId && !r.done);
    if (!task) return { ok: false, error: 'あなたが返すカードはありません。' };
    if (!Array.isArray(cardIds) || cardIds.length !== task.count) {
      return { ok: false, error: `${task.count}枚選んでください。` };
    }
    const hand = this.hands[playerId];
    const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== task.count) return { ok: false, error: '手札にないカードが含まれています。' };

    this.hands[playerId] = hand.filter((c) => !cardIds.includes(c.id));
    this.hands[task.to] = this.hands[task.to].concat(cards);
    this.sortAllHands();
    task.done = true;
    this.addLog(`${this.playerName(playerId)} が ${this.playerName(task.to)} にカードを${task.count}枚返しました。`);

    if (this.pendingExchange.returns.every((r) => r.done)) {
      this.pendingExchange = null;
      this.phase = 'PLAYING';
      this.addLog('カード交換が終わりました。ゲーム開始!');
    }
    return { ok: true };
  }

  sortAllHands() {
    for (const id of Object.keys(this.hands)) {
      this.hands[id].sort((a, b) => strengthOf(a.rank, false) - strengthOf(b.rank, false));
    }
  }

  // ----------------------------------------------------------------
  // 手札の組み合わせ判定
  // ----------------------------------------------------------------
  // cards: 選択されたカードオブジェクトの配列
  analyzeCombo(cards) {
    if (!cards || cards.length === 0) return null;
    const nonJokers = cards.filter((c) => !c.joker);
    const jokerCount = cards.length - nonJokers.length;
    if (nonJokers.length === 0) {
      // 全部ジョーカー (1枚のみ想定)
      if (cards.length === 1) return { rank: 'JOKER', count: 1, suits: [] };
      return null;
    }
    const rank = nonJokers[0].rank;
    if (!nonJokers.every((c) => c.rank === rank)) return null; // ランク不一致
    const suits = Array.from(new Set(nonJokers.map((c) => c.suit))).sort();
    return { rank, count: cards.length, suits, jokerCount };
  }

  suitsEqual(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const sa = a.slice().sort();
    const sb = b.slice().sort();
    return sa.every((v, i) => v === sb[i]);
  }

  // プレイヤーが出そうとしている手が合法か判定する
  validatePlay(playerId, cardIds) {
    if (this.phase !== 'PLAYING') return { ok: false, error: '現在は場に出せません。' };
    if (this.order[this.turnIndex] !== playerId) return { ok: false, error: 'あなたの番ではありません。' };
    if (this.finished.includes(playerId)) return { ok: false, error: 'あなたは既にあがっています。' };

    const hand = this.hands[playerId] || [];
    const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length || cards.length === 0) {
      return { ok: false, error: '手札にないカードが選択されています。' };
    }

    const combo = this.analyzeCombo(cards);
    if (!combo) return { ok: false, error: '同じランドのカードを組み合わせて出してください。' };

    // スペ3返し: 場がジョーカー単騎の時、スペード3の単騎だけは特別に勝てる
    const isSpade3Return =
      this.rules.spade3Return &&
      this.field &&
      this.field.rank === 'JOKER' &&
      this.field.count === 1 &&
      combo.count === 1 &&
      cards[0].suit === 'S' &&
      cards[0].rank === '3';

    if (this.field) {
      if (combo.count !== this.field.count) {
        return { ok: false, error: `場と同じ${this.field.count}枚で出してください。` };
      }
      if (!isSpade3Return) {
        const rev = this.effectiveRevolution();
        const fieldStrength = strengthOf(this.field.rank, rev);
        const myStrength = strengthOf(combo.rank, rev);
        if (myStrength <= fieldStrength) {
          return { ok: false, error: '場より強いカードを出してください。' };
        }
      }
      if (this.lockedSuits && !isSpade3Return) {
        // ジョーカー単騎(suits=[])は縛りを無視できる
        if (combo.suits.length > 0 && !this.suitsEqual(this.lockedSuits, combo.suits)) {
          return { ok: false, error: `しばり中です。${this.lockedSuits.map((s) => SUIT_LABEL[s]).join('')} のスートで出してください。` };
        }
      }
    }

    return { ok: true, cards, combo, isSpade3Return };
  }

  playCards(playerId, cardIds) {
    const check = this.validatePlay(playerId, cardIds);
    if (!check.ok) return check;
    const { cards, combo, isSpade3Return } = check;

    // 手札から取り除く
    this.hands[playerId] = this.hands[playerId].filter((c) => !cardIds.includes(c.id));

    const isEight = this.rules.eightCut && combo.rank === '8';
    const isRevolution = this.rules.revolution && combo.count >= 4;
    const isElevenBack = this.rules.elevenBack && combo.rank === 'J';
    const isSevenGive = this.rules.sevenGive && combo.rank === '7';

    this.addLog(
      `${this.playerName(playerId)} が ${cards.map((c) => this.cardLabel(c)).join(' ')} を出しました。`
    );

    if (isRevolution) {
      this.revolution = !this.revolution;
      this.addLog('革命が起きました!強さが逆転します。');
    }
    if (isElevenBack) {
      this.elevenBack = !this.elevenBack;
      this.addLog('イレブンバック!このトリック限定で強さが逆転します。');
    }

    // しばり判定 (ジョーカー単騎はスート判定から除外)
    if (this.rules.shibari && combo.suits.length > 0) {
      if (this.lockedSuits) {
        // 既にロック中 -> 維持 (validatePlayで一致確認済み)
      } else if (this.lastSuits && this.suitsEqual(this.lastSuits, combo.suits)) {
        this.lockedSuits = combo.suits;
        this.addLog(`しばり成立!(${combo.suits.map((s) => SUIT_LABEL[s]).join('')})`);
      }
      this.lastSuits = combo.suits;
    }

    this.field = { cards, count: combo.count, rank: combo.rank, playerId };
    this.leaderId = playerId;

    let justFinished = false;
    if (this.hands[playerId].length === 0) {
      this.finished.push(playerId);
      justFinished = true;
      this.addLog(`${this.playerName(playerId)} が上がりました! (${this.finished.length}位)`);
    }

    this.seq += 1;
    const effects = [];
    if (isRevolution) effects.push('REVOLUTION');
    if (isElevenBack) effects.push('ELEVEN_BACK');
    if (isEight) effects.push('EIGHT_CUT');
    if (isSpade3Return) effects.push('SPADE3_RETURN');
    if (justFinished) effects.push('FINISH');
    this.lastEffects = effects;
    this.lastEffectBy = playerId;

    const roundOver = this.checkRoundOver();
    if (roundOver) return { ok: true, roundOver: true };

    const pendingClearField = isEight || isSpade3Return;

    // 7渡し: まだ手札が残っていれば、進行を一旦止めて渡し先とカードを選んでもらう
    if (isSevenGive && !justFinished) {
      const candidates = this.order.filter(
        (id) => id !== playerId && !this.finished.includes(id) && !this.disconnected.has(id)
      );
      if (candidates.length > 0) {
        this.pendingSevenGive = { playerId, count: combo.count, candidates, pendingClearField };
        this.phase = 'SEVEN_GIVE';
        this.addLog(`${this.playerName(playerId)} は7を出したので、カードを${combo.count}枚渡します。`);
        return { ok: true, needsSevenGive: true };
      }
    }

    if (pendingClearField) {
      if (isSpade3Return) this.addLog('スペードの3返し!場が流れます。');
      else this.addLog('8切り!場が流れます。');
      this.clearField(justFinished ? null : playerId);
    } else {
      this.advanceTurn(playerId);
    }

    return { ok: true };
  }

  // 7渡し: 選んだカードを指定した相手に渡し、止まっていた進行を再開する
  submitSevenGive(playerId, cardIds, toPlayerId) {
    if (this.phase !== 'SEVEN_GIVE' || !this.pendingSevenGive) {
      return { ok: false, error: '今は7渡しのフェーズではありません。' };
    }
    const pending = this.pendingSevenGive;
    if (pending.playerId !== playerId) return { ok: false, error: 'あなたが渡す番ではありません。' };
    if (!pending.candidates.includes(toPlayerId)) return { ok: false, error: '渡し先が正しくありません。' };
    if (!Array.isArray(cardIds) || cardIds.length !== pending.count) {
      return { ok: false, error: `${pending.count}枚選んでください。` };
    }
    const hand = this.hands[playerId];
    const uniqueIds = new Set(cardIds);
    if (uniqueIds.size !== cardIds.length) return { ok: false, error: '同じカードが重複しています。' };
    const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== pending.count) return { ok: false, error: '手札にないカードが含まれています。' };

    this.hands[playerId] = hand.filter((c) => !cardIds.includes(c.id));
    this.hands[toPlayerId] = this.hands[toPlayerId].concat(cards);
    this.sortAllHands();
    this.addLog(
      `${this.playerName(playerId)} が ${this.playerName(toPlayerId)} に ${cards.map((c) => this.cardLabel(c)).join(' ')} を渡しました。`
    );

    const { pendingClearField } = pending;
    this.pendingSevenGive = null;
    this.phase = 'PLAYING';

    let justFinished = false;
    if (this.hands[playerId].length === 0 && !this.finished.includes(playerId)) {
      this.finished.push(playerId);
      justFinished = true;
      this.addLog(`${this.playerName(playerId)} が上がりました! (${this.finished.length}位)`);
      this.seq += 1;
      this.lastEffects = this.lastEffects.includes('FINISH') ? this.lastEffects : this.lastEffects.concat('FINISH');
      this.lastEffectBy = playerId;
    }

    const roundOver = this.checkRoundOver();
    if (roundOver) return { ok: true, roundOver: true };

    if (pendingClearField) {
      this.clearField(justFinished ? null : playerId);
    } else {
      this.advanceTurn(playerId);
    }
    return { ok: true };
  }

  pass(playerId) {
    if (this.phase !== 'PLAYING') return { ok: false, error: '今はパスできません。' };
    if (this.order[this.turnIndex] !== playerId) return { ok: false, error: 'あなたの番ではありません。' };
    if (!this.field) return { ok: false, error: '場が空の時はパスできません。最初の一手を出してください。' };
    if (this.finished.includes(playerId)) return { ok: false, error: 'あなたは既にあがっています。' };

    this.passed.add(playerId);
    this.addLog(`${this.playerName(playerId)} がパスしました。`);
    this.seq += 1;
    this.lastEffects = [];
    this.lastEffectBy = null;
    this.advanceTurn(playerId);
    return { ok: true };
  }

  clearField(keepLeaderId) {
    this.field = null;
    this.lockedSuits = null;
    this.lastSuits = null;
    this.elevenBack = false; // イレブンバックはこのトリック限定
    this.passed = new Set();
    let leader = keepLeaderId;
    if (!leader || this.finished.includes(leader) || this.disconnected.has(leader)) {
      leader = this.nextActiveFrom(this.order.indexOf(this.leaderId ?? this.order[this.turnIndex]));
    }
    if (leader) {
      this.turnIndex = this.order.indexOf(leader);
      this.leaderId = leader;
    }
  }

  nextActiveFrom(startIdx) {
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (startIdx + step) % n;
      const id = this.order[idx];
      if (!this.finished.includes(id) && !this.disconnected.has(id)) return id;
    }
    return null;
  }

  advanceTurn(fromPlayerId) {
    const fromIdx = this.order.indexOf(fromPlayerId);
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIdx + step) % n;
      const id = this.order[idx];
      if (this.finished.includes(id) || this.disconnected.has(id)) continue;
      if (this.passed.has(id)) continue;
      if (this.field && id === this.leaderId) {
        // 一周して場を出した本人まで戻ってきた -> 場が流れて新しいトリックへ
        this.clearField(id);
        return;
      }
      this.turnIndex = idx;
      return;
    }
    // 誰も応答できない (リーダーがあがった/切断した等) -> 場が流れる
    this.clearField(this.leaderId);
  }

  checkRoundOver() {
    const remaining = this.order.filter((id) => !this.finished.includes(id) && !this.disconnected.has(id));
    if (remaining.length <= 1) {
      if (remaining.length === 1) this.finished.push(remaining[0]);
      this.phase = 'ROUND_END';
      this.prevFinishOrder = this.finished.slice();
      const roles = roleNamesFor(this.finished.length);
      const roleByPlayer = {};
      this.finished.forEach((id, idx) => (roleByPlayer[id] = roles[idx]));
      this.prevRoles = roleByPlayer;
      this.addLog('--- ラウンド終了 ---');
      this.finished.forEach((id, idx) => {
        this.addLog(`${idx + 1}位: ${this.playerName(id)} (${roleByPlayer[id]})`);
      });
      return true;
    }
    return false;
  }

  cardLabel(card) {
    if (card.joker) return 'JOKER';
    return `${SUIT_LABEL[card.suit]}${card.rank}`;
  }

  // ----------------------------------------------------------------
  // クライアントに送るための状態 (自分の手札は公開、他人は枚数のみ)
  // ----------------------------------------------------------------
  getStateFor(viewerId) {
    const roles = this.prevRoles || {};
    return {
      round: this.round,
      phase: this.phase,
      revolution: this.revolution,
      elevenBack: this.elevenBack,
      lockedSuits: this.lockedSuits,
      field: this.field
        ? {
            cards: this.field.cards.map((c) => ({ id: c.id, suit: c.suit, rank: c.rank, joker: c.joker, label: this.cardLabel(c) })),
            count: this.field.count,
            rank: this.field.rank,
            playerId: this.field.playerId,
            playerName: this.playerName(this.field.playerId),
          }
        : null,
      currentTurnPlayerId: this.order[this.turnIndex],
      leaderId: this.leaderId,
      finishedOrder: this.finished.map((id) => ({ id, name: this.playerName(id), role: roles[id] || null })),
      passed: Array.from(this.passed),
      pendingExchange: this.pendingExchange
        ? this.pendingExchange.returns.map((r) => ({ playerId: r.playerId, count: r.count, done: r.done }))
        : null,
      pendingSevenGive: this.pendingSevenGive
        ? {
            playerId: this.pendingSevenGive.playerId,
            count: this.pendingSevenGive.count,
            candidates: this.pendingSevenGive.candidates.map((id) => ({ id, name: this.playerName(id) })),
          }
        : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar || null,
        handCount: (this.hands[p.id] || []).length,
        finished: this.finished.includes(p.id),
        connected: !this.disconnected.has(p.id),
        role: roles[p.id] || null,
      })),
      myHand: (this.hands[viewerId] || []).map((c) => ({ id: c.id, suit: c.suit, rank: c.rank, joker: c.joker, label: this.cardLabel(c) })),
      log: this.log.slice(-40),
      rules: this.rules,
      seq: this.seq,
      effects: this.lastEffects,
      effectBy: this.lastEffectBy,
      effectByName: this.lastEffectBy ? this.playerName(this.lastEffectBy) : null,
    };
  }
}

module.exports = { DaifugoGame, makeDeck, roleNamesFor, normalizeRules, DEFAULT_RULES, SUIT_LABEL, RANK_ORDER };
