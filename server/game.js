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
 *  - 5のスキップ / 10捨て / 4戻し
 *  - 救急車 (9の2枚出しで場が流れる) / ろくろ首 (6の2枚出しで場が流れる)
 *  - 都落ち (前回の大富豪が今回1位を逃すと強制的に大貧民になる)
 *  - 階段 (同じスートの連続した数字を3枚以上まとめて出せる)
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
  fiveSkip: true, // 5のスキップ (5を出すと次のプレイヤーの番を飛ばす)
  tenClear: true, // 10捨て (10を出すと場が流れる。8切りと同様に続けて出せる)
  fourReturn: true, // 4戻し (4を出すと順番が1つ前のプレイヤーに戻る)
  ambulance: true, // 救急車 (9の2枚出しで場が流れる。3枚/4枚出しでは発動しない)
  rokurokubi: true, // ろくろ首 (6の2枚出しで場が流れる)
  miyakoochi: true, // 都落ち (前回の大富豪が今回1位を逃すと、その場で脱落し次回大貧民が確定)
  straight: true, // 階段 (同じスートの連続した数字を3枚以上まとめて出せる。ジョーカーで穴埋め可)
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
    this.miyakoochiId = null; // 都落ち: このラウンドで発動済みなら対象プレイヤーのid (1ラウンド1回まで)
    this.prevFinishOrder = null; // 前ラウンドのあがり順 (都落り・カード交換の判定に使う)
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
    this.miyakoochiId = null;

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
  // 戻り値の kind: 'set' (同じランクの束、ジョーカーは穴埋め自由) または
  //               'straight' (階段: 同じスートの連続した数字、ジョーカーで途中の穴埋め可)
  analyzeCombo(cards) {
    if (!cards || cards.length === 0) return null;
    const nonJokers = cards.filter((c) => !c.joker);
    const jokerCount = cards.length - nonJokers.length;
    if (nonJokers.length === 0) {
      // 全部ジョーカー (1枚のみ想定)
      if (cards.length === 1) return { kind: 'set', rank: 'JOKER', count: 1, suits: [], jokerCount: 1 };
      return null;
    }
    // まず「同じランクの束」として成立するか確認する (1枚だけの実カード+ジョーカー複数、
    // という組み合わせもここに含まれる。階段と紛らわしいケースだが、大富豪の伝統的な
    // 挙動として「同ランクの束」を優先する)
    const rank = nonJokers[0].rank;
    if (nonJokers.every((c) => c.rank === rank)) {
      const suits = Array.from(new Set(nonJokers.map((c) => c.suit))).sort();
      return { kind: 'set', rank, count: cards.length, suits, jokerCount };
    }

    // 階段: 同じスートで連続した数字が3枚以上 (ジョーカーは途中の欠番の穴埋めに使える)
    if (this.rules.straight && cards.length >= 3) {
      const suit = nonJokers[0].suit;
      if (!nonJokers.every((c) => c.suit === suit)) return null; // スート不一致
      const idxs = nonJokers.map((c) => RANK_ORDER.indexOf(c.rank));
      if (idxs.some((i) => i < 0)) return null;
      if (new Set(idxs).size !== idxs.length) return null; // 同じランクが2枚以上あると階段にならない
      const lowIdx = Math.min(...idxs);
      const highIdx = Math.max(...idxs);
      const span = highIdx - lowIdx + 1;
      if (span !== cards.length) return null; // 欠番の数がジョーカーの枚数とぴったり一致しないと成立しない
      return {
        kind: 'straight',
        suit,
        lowRank: RANK_ORDER[lowIdx],
        highRank: RANK_ORDER[highIdx],
        count: cards.length,
        suits: [suit],
        jokerCount,
      };
    }

    return null;
  }

  // 場に出ている/出そうとしている組み合わせの「強さ」を数値化する。
  // 'set' はランクそのもの、'straight' は一番弱いカード(lowRank)で比較する
  // (階段同士は同じ枚数のときだけ比較でき、開始ランクが高い方が強い)。
  comboStrength(combo, revolution) {
    if (combo.kind === 'straight') return strengthOf(combo.lowRank, revolution);
    return strengthOf(combo.rank, revolution);
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
    if (!combo) {
      return {
        ok: false,
        error: this.rules.straight
          ? '同じランクの束か、同じスートの連続した数字(3枚以上)で出してください。'
          : '同じランクのカードを組み合わせて出してください。',
      };
    }

    // スペ3返し: 場がジョーカー単騎の時、スペード3の単騎だけは特別に勝てる
    const isSpade3Return =
      this.rules.spade3Return &&
      this.field &&
      this.field.rank === 'JOKER' &&
      this.field.count === 1 &&
      combo.kind === 'set' &&
      combo.count === 1 &&
      cards[0].suit === 'S' &&
      cards[0].rank === '3';

    if (this.field) {
      if (combo.count !== this.field.count) {
        return { ok: false, error: `場と同じ${this.field.count}枚で出してください。` };
      }
      if (!isSpade3Return) {
        if (combo.kind !== this.field.kind) {
          return {
            ok: false,
            error: this.field.kind === 'straight' ? '階段には階段で返してください。' : '同じランクの束で返してください。',
          };
        }
        const rev = this.effectiveRevolution();
        const fieldStrength = this.comboStrength(this.field, rev);
        const myStrength = this.comboStrength(combo, rev);
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

    const isSet = combo.kind === 'set';
    const isEight = isSet && this.rules.eightCut && combo.rank === '8';
    const isTenClear = isSet && this.rules.tenClear && combo.rank === '10';
    const isRevolution = isSet && this.rules.revolution && combo.count >= 4;
    const isElevenBack = isSet && this.rules.elevenBack && combo.rank === 'J';
    const isSevenGive = isSet && this.rules.sevenGive && combo.rank === '7';
    const isFiveSkip = isSet && this.rules.fiveSkip && combo.rank === '5';
    const isFourReturn = isSet && this.rules.fourReturn && combo.rank === '4';
    const isAmbulance = isSet && this.rules.ambulance && combo.rank === '9' && combo.count === 2;
    const isRokurokubi = isSet && this.rules.rokurokubi && combo.rank === '6' && combo.count === 2;

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

    this.field = {
      cards,
      count: combo.count,
      kind: combo.kind,
      rank: combo.kind === 'set' ? combo.rank : null,
      suit: combo.kind === 'straight' ? combo.suit : null,
      lowRank: combo.kind === 'straight' ? combo.lowRank : null,
      highRank: combo.kind === 'straight' ? combo.highRank : null,
      playerId,
    };
    this.leaderId = playerId;

    let justFinished = false;
    if (this.hands[playerId].length === 0) {
      this.finished.push(playerId);
      justFinished = true;
      this.addLog(`${this.playerName(playerId)} が上がりました! (${this.finished.length}位)`);
      this.checkMiyakoochi();
    }

    this.seq += 1;
    const effects = [];
    if (isRevolution) effects.push('REVOLUTION');
    if (isElevenBack) effects.push('ELEVEN_BACK');
    if (isEight) effects.push('EIGHT_CUT');
    if (isTenClear) effects.push('TEN_CLEAR');
    if (isFiveSkip) effects.push('FIVE_SKIP');
    if (isFourReturn) effects.push('FOUR_RETURN');
    if (isAmbulance) effects.push('AMBULANCE');
    if (isRokurokubi) effects.push('ROKUROKUBI');
    if (isSpade3Return) effects.push('SPADE3_RETURN');
    if (justFinished) effects.push('FINISH');
    this.lastEffects = effects;
    this.lastEffectBy = playerId;

    const roundOver = this.checkRoundOver();
    if (roundOver) return { ok: true, roundOver: true };

    const pendingClearField = isEight || isTenClear || isSpade3Return || isAmbulance || isRokurokubi;

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
      else if (isTenClear) this.addLog('10捨て!場が流れます。');
      else if (isAmbulance) this.addLog('救急車!場が流れます。');
      else if (isRokurokubi) this.addLog('ろくろ首!場が流れます。');
      else this.addLog('8切り!場が流れます。');
      this.clearField(justFinished ? null : playerId);
    } else {
      const advanceOpts = {};
      if (isFourReturn) advanceOpts.direction = -1;
      if (isFiveSkip) advanceOpts.extraSkip = 1;
      if (isFourReturn) this.addLog('4戻し!順番が前のプレイヤーに戻ります。');
      if (isFiveSkip) this.addLog('5のスキップ!次のプレイヤーの番を飛ばします。');
      this.advanceTurn(playerId, advanceOpts);
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
      this.checkMiyakoochi();
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

  nextActiveFrom(startIdx, direction = 1) {
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (((startIdx + step * direction) % n) + n) % n;
      const id = this.order[idx];
      if (!this.finished.includes(id) && !this.disconnected.has(id)) return id;
    }
    return null;
  }

  // direction: 1=通常(時計回り) / -1=4戻し用の逆回り
  // extraSkip: 5のスキップ用。0より大きい場合、その人数分だけさらに次へ飛ばす
  advanceTurn(fromPlayerId, opts = {}) {
    const { direction = 1, extraSkip = 0 } = opts;
    const fromIdx = this.order.indexOf(fromPlayerId);
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (((fromIdx + step * direction) % n) + n) % n;
      const id = this.order[idx];
      if (this.finished.includes(id) || this.disconnected.has(id)) continue;
      if (this.passed.has(id)) continue;
      if (this.field && id === this.leaderId) {
        // 一周して場を出した本人まで戻ってきた -> 場が流れて新しいトリックへ
        this.clearField(id);
        return;
      }
      this.turnIndex = idx;
      if (extraSkip > 0) {
        this.addLog(`${this.playerName(id)} の番はスキップされました。`);
        this.advanceTurn(id, { direction, extraSkip: extraSkip - 1 });
        return;
      }
      return;
    }
    // 誰も応答できない (リーダーがあがった/切断した等) -> 場が流れる
    this.clearField(this.leaderId);
  }

  // 都落ち: 前回大富豪だった人が、自分以外の誰かに1位を取られた瞬間、
  // その場で手札を放棄して脱落する(次ラウンドで必ず大貧民になる)。
  // 1ラウンドにつき1回だけ判定する。
  checkMiyakoochi() {
    if (!this.rules.miyakoochi || this.miyakoochiId) return;
    const prevDaifugoId = this.prevFinishOrder && this.prevFinishOrder[0];
    if (!prevDaifugoId) return;
    if (this.finished.length !== 1) return; // 「1位が決まった瞬間」だけを見る
    if (this.finished[0] === prevDaifugoId) return; // 本人が1位なら都落ちしない
    if (!this.order.includes(prevDaifugoId) || this.disconnected.has(prevDaifugoId)) return;
    if (this.finished.includes(prevDaifugoId)) return; // 既にあがっている(あり得ないが念のため)

    this.miyakoochiId = prevDaifugoId;
    this.hands[prevDaifugoId] = [];
    this.finished.push(prevDaifugoId);
    this.addLog(
      `${this.playerName(prevDaifugoId)} は前回大富豪でしたが1位を逃したため「都落ち」!強制的に大貧民が確定しました。`
    );
  }

  checkRoundOver() {
    const remaining = this.order.filter((id) => !this.finished.includes(id) && !this.disconnected.has(id));
    if (remaining.length <= 1) {
      if (remaining.length === 1) this.finished.push(remaining[0]);
      // 都落ち対象者は、あがった順番に関わらず必ず最下位(大貧民)になるよう最後尾に回す
      if (this.miyakoochiId && this.finished.includes(this.miyakoochiId)) {
        this.finished = this.finished.filter((id) => id !== this.miyakoochiId).concat(this.miyakoochiId);
      }
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
    // 自分があがった後は、まだプレイ中の他のプレイヤーの手札を観戦できるようにする
    const iAmSpectating = this.finished.includes(viewerId);
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
            kind: this.field.kind,
            rank: this.field.rank,
            suit: this.field.suit,
            lowRank: this.field.lowRank,
            highRank: this.field.highRank,
            playerId: this.field.playerId,
            playerName: this.playerName(this.field.playerId),
          }
        : null,
      currentTurnPlayerId: this.order[this.turnIndex],
      turnDeadline: this.turnDeadline || null,
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
      players: this.players.map((p) => {
        const isFinished = this.finished.includes(p.id);
        return {
          id: p.id,
          name: p.name,
          avatar: p.avatar || null,
          handCount: (this.hands[p.id] || []).length,
          finished: isFinished,
          connected: !this.disconnected.has(p.id),
          role: roles[p.id] || null,
          // あがった人だけ、まだあがっていない他プレイヤーの手札を観戦できる
          hand:
            iAmSpectating && p.id !== viewerId && !isFinished
              ? (this.hands[p.id] || []).map((c) => ({ id: c.id, suit: c.suit, rank: c.rank, joker: c.joker, label: this.cardLabel(c) }))
              : undefined,
        };
      }),
      myHand: (this.hands[viewerId] || []).map((c) => ({ id: c.id, suit: c.suit, rank: c.rank, joker: c.joker, label: this.cardLabel(c) })),
      rules: this.rules,
      seq: this.seq,
      effects: this.lastEffects,
      effectBy: this.lastEffectBy,
      effectByName: this.lastEffectBy ? this.playerName(this.lastEffectBy) : null,
    };
  }
}

module.exports = { DaifugoGame, makeDeck, roleNamesFor, normalizeRules, DEFAULT_RULES, SUIT_LABEL, RANK_ORDER };
