(() => {
  'use strict';

  // ブラウザから「アプリとしてインストール」できるようにするための登録
  // (対応ブラウザでのみ動作。未対応でも通常のWebサイトとして問題なく使える)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
  }

  const socket = io();

  const el = (id) => document.getElementById(id);
  const screens = {
    home: el('screen-home'),
    lobby: el('screen-lobby'),
    game: el('screen-game'),
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([k, node]) => (node.hidden = k !== name));
  }

  function toast(msg) {
    const t = el('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => (t.hidden = true), 2600);
  }

  // ルーム解散/キックでリロードされた直後なら、その旨を一言表示する
  try {
    const leaveNotice = sessionStorage.getItem('daifugo-leave-notice');
    if (leaveNotice) {
      sessionStorage.removeItem('daifugo-leave-notice');
      const msg = leaveNotice === 'kicked' ? 'ホストによってルームからキックされました' : 'ルームが解散されました';
      window.addEventListener('load', () => setTimeout(() => toast(msg), 300));
    }
  } catch (e) {}

  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };

  // ------------------------------------------------------------------
  // スタンプ
  // ------------------------------------------------------------------
  const STICKERS = [
    { id: 'revolution', label: '革命!!' },
    { id: 'eightcut', label: '8切りっ☆' },
    { id: 'shibari', label: 'しばり成立〜' },
    { id: 'joker', label: 'ジョーカー、もらうね' },
    { id: 'agari', label: 'あがり!!!' },
    { id: 'pass', label: 'パス。' },
    { id: 'daifugo', label: '大富豪、確定' },
    { id: 'hinmin', label: 'それ、貧民ですわ www' },
    { id: 'yowasugi', label: '弱すぎでしょ' },
    { id: 'aori', label: '煽り耐性、ある?' },
  ];
  let stickerCooldownUntil = 0;

  function showStickerBubble(fromName, stickerId) {
    const meta = STICKERS.find((s) => s.id === stickerId);
    if (!meta) return;
    const layer = el('sticker-layer');
    const bubble = document.createElement('div');
    bubble.className = 'sticker-bubble';
    bubble.innerHTML = `<img src="/stickers/${stickerId}.png" alt="${meta.label}" /><span class="sticker-from">${escapeHtml(fromName || '')}</span>`;
    layer.appendChild(bubble);
    bubble.addEventListener('animationend', () => bubble.remove());
    // 万一 animationend が発火しない環境向けの保険
    setTimeout(() => bubble.remove(), 3200);
  }

  function buildStickerPanel() {
    const panel = el('sticker-panel');
    panel.innerHTML = '';
    STICKERS.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = s.label;
      btn.innerHTML = `<img src="/stickers/${s.id}.png" alt="${s.label}" />`;
      btn.addEventListener('click', () => {
        const now = Date.now();
        if (now < stickerCooldownUntil) return;
        stickerCooldownUntil = now + 1200;
        socket.emit('game:sticker', { stickerId: s.id }, (res) => {
          if (res && !res.ok) toast(res.error);
        });
        el('sticker-panel').hidden = true;
      });
      panel.appendChild(btn);
    });
  }

  // 出せる/出せないカードのハイライト判定に使う強さ計算 (server/game.js と同じロジック)
  const RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
  function rankIndex(rank) { return rank === 'JOKER' ? 100 : RANK_ORDER.indexOf(rank); }
  function strengthOf(rank, revolution) {
    if (rank === 'JOKER') return 1000;
    const idx = rankIndex(rank);
    return revolution ? (RANK_ORDER.length - 1 - idx) : idx;
  }

  // ------------------------------------------------------------------
  // ローカル永続化 (リロード時の自動再接続用)
  // ------------------------------------------------------------------
  const STORAGE_KEY = 'daifugo-session';
  function saveSession(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  // ルーム退出: 保存中のセッションを消してからページを再読み込みする。
  // (BGM再生やソケット接続などの状態を全部きれいにリセットしたいので、
  //  画面遷移だけで済ませず素直にリロードする)
  function leaveRoom() {
    if (!confirm('ルームを退出しますか?')) return;
    clearSession();
    location.reload();
  }

  let myPlayerId = null;
  let selectedCardIds = new Set();
  let selectedExchangeIds = new Set();
  let selectedSevenGiveIds = new Set();
  let sevenGiveTarget = null;
  let lastGameState = null;
  let lastEffectSeq = -1;
  let effectQueue = Promise.resolve();
  let lastFieldSig = null;
  let freshFieldPlay = false; // 直前の描画で「新しく場にカードが出た」かどうか (出した人からのモーション用)
  let lastTurnPlayerId = null;
  // 「直近で実際にflying-inモーションを付けて描画した場の中身」を覚えておく。
  // render()は手札選択や再描画イベントなど、場の中身と無関係な理由でも何度も呼ばれることがあり、
  // freshFieldPlay(=effectsのseqベース)だけに頼ると、同じプレイに対して2回目以降のrender()が
  // 場のDOMを再構築してモーション用クラスを消してしまうことがある(例: 相手のプレイ直後に
  // 自分の手番になった通知が続けてrender()を呼ぶケース)。そのため場の描画自体は
  // 「このfieldSigを直前に描画済みかどうか」で判定し、seqの数え直しの影響を受けないようにする。
  let lastPileFieldSig = null;

  /* ---------------- 効果音 (Web Audio API で合成、外部音源なし) ---------------- */
  const AudioFX = (() => {
    let ctx = null;
    let muted = false;
    function ensureCtx() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(c, freq, start, dur, type, peak) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + dur + 0.03);
    }
    function noise(c, start, dur, f0, f1, peak) {
      const n = c.sampleRate * dur;
      const buf = c.createBuffer(1, n, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      src.buffer = buf;
      const filter = c.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(f0, start);
      filter.frequency.exponentialRampToValueAtTime(f1, start + dur);
      const gain = c.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      src.connect(filter).connect(gain).connect(c.destination);
      src.start(start);
      src.stop(start + dur + 0.03);
    }
    function guard(fn) {
      return (...args) => {
        if (muted) return;
        const c = ensureCtx();
        if (!c) return;
        try { fn(c, ...args); } catch (e) { /* 音声再生に失敗しても無視 */ }
      };
    }
    const playCard = guard((c) => {
      const t = c.currentTime;
      noise(c, t, 0.09, 2200, 900, 0.10);
      tone(c, 520, t, 0.07, 'triangle', 0.05);
    });
    const pass = guard((c) => {
      tone(c, 300, c.currentTime, 0.09, 'sine', 0.05);
    });
    const eightCut = guard((c) => {
      const t = c.currentTime;
      noise(c, t, 0.32, 3000, 300, 0.16);
      tone(c, 180, t + 0.03, 0.25, 'sawtooth', 0.08);
    });
    const revolution = guard((c) => {
      const t = c.currentTime;
      [660, 550, 440, 330].forEach((f, i) => tone(c, f, t + i * 0.06, 0.14, 'square', 0.08));
      [440, 550, 660, 880].forEach((f, i) => tone(c, f, t + 0.3 + i * 0.07, 0.16, 'triangle', 0.09));
    });
    const spade3 = guard((c) => {
      const t = c.currentTime;
      [880, 1174.66].forEach((f, i) => tone(c, f, t + i * 0.09, 0.18, 'sine', 0.09));
    });
    const elevenBack = guard((c) => {
      const t = c.currentTime;
      // 革命の逆再生っぽく、下降ではなく上昇+反転で「一時的に逆転」を表現
      [330, 440, 550, 660].forEach((f, i) => tone(c, f, t + i * 0.05, 0.12, 'square', 0.07));
      tone(c, 220, t + 0.25, 0.2, 'sawtooth', 0.06);
    });
    const finish = guard((c) => {
      const t = c.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, f, t + i * 0.09, 0.22, 'triangle', 0.1));
    });
    const yourTurn = guard((c) => {
      const t = c.currentTime;
      tone(c, 784, t, 0.1, 'sine', 0.06);
      tone(c, 988, t + 0.1, 0.14, 'sine', 0.06);
    });
    return {
      playCard, pass, eightCut, revolution, spade3, finish, yourTurn, elevenBack,
      unlock: () => ensureCtx(),
      setMuted: (v) => { muted = v; },
      isMuted: () => muted,
    };
  })();

  const RULE_LABELS = {
    eightCut: '8切り',
    revolution: '革命',
    shibari: 'しばり',
    useJoker: 'ジョーカー',
    spade3Return: 'スペ3返し',
    cardExchange: 'カード交換',
    sevenGive: '7渡し',
    elevenBack: 'イレブンバック',
  };

  function readRulesFromUI() {
    const rules = {};
    document.querySelectorAll('#rule-list input[data-rule]').forEach((elm) => { rules[elm.dataset.rule] = elm.checked; });
    return rules;
  }
  const jokerCheckbox = document.querySelector('#rule-list input[data-rule="useJoker"]');
  const spade3Checkbox = document.querySelector('#rule-list input[data-rule="spade3Return"]');
  if (jokerCheckbox && spade3Checkbox) {
    jokerCheckbox.addEventListener('change', () => {
      if (!jokerCheckbox.checked) { spade3Checkbox.checked = false; spade3Checkbox.disabled = true; }
      else spade3Checkbox.disabled = false;
    });
  }

  // ------------------------------------------------------------------
  // アイコン画像 (自分のフォルダから選んで、正方形に縮小してから使う)
  // ------------------------------------------------------------------
  const AVATAR_STORAGE_KEY = 'daifugo-avatar';
  let myAvatarDataUrl = null;
  function renderAvatarPreview() {
    const box = el('avatar-preview');
    box.innerHTML = '';
    if (myAvatarDataUrl) {
      const img = document.createElement('img');
      img.src = myAvatarDataUrl;
      box.appendChild(img);
      el('btn-avatar-clear').hidden = false;
    } else {
      const name = el('input-name').value.trim();
      box.textContent = name ? name.slice(0, 1) : '?';
      el('btn-avatar-clear').hidden = true;
    }
  }
  function loadStoredAvatar() {
    try {
      const stored = localStorage.getItem(AVATAR_STORAGE_KEY);
      if (stored) { myAvatarDataUrl = stored; renderAvatarPreview(); }
    } catch (e) {}
  }
  function resizeImageToDataUrl(file, size, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // 中央を正方形に切り抜いてから縮小
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        cb(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => toast('画像を読み込めませんでした。');
      img.src = reader.result;
    };
    reader.onerror = () => toast('画像を読み込めませんでした。');
    reader.readAsDataURL(file);
  }
  el('btn-avatar-pick').addEventListener('click', () => el('input-avatar').click());
  el('input-avatar').addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('画像ファイルを選んでください。'); return; }
    resizeImageToDataUrl(file, 160, (dataUrl) => {
      myAvatarDataUrl = dataUrl;
      try { localStorage.setItem(AVATAR_STORAGE_KEY, dataUrl); } catch (e) {}
      renderAvatarPreview();
    });
    ev.target.value = '';
  });
  el('btn-avatar-clear').addEventListener('click', () => {
    myAvatarDataUrl = null;
    try { localStorage.removeItem(AVATAR_STORAGE_KEY); } catch (e) {}
    renderAvatarPreview();
  });
  el('input-name').addEventListener('input', () => { if (!myAvatarDataUrl) renderAvatarPreview(); });
  loadStoredAvatar();
  renderAvatarPreview();

  // ------------------------------------------------------------------
  // ホーム画面
  // ------------------------------------------------------------------
  el('btn-create').addEventListener('click', () => {
    AudioFX.unlock();
    const name = el('input-name').value.trim();
    if (!name) { el('home-error').textContent = 'ニックネームを入力してください。'; return; }
    const rules = readRulesFromUI();
    socket.emit('room:create', { name, rules, avatar: myAvatarDataUrl }, (res) => {
      if (!res.ok) { el('home-error').textContent = res.error; return; }
      myPlayerId = res.playerId;
      saveSession({ roomCode: res.roomCode, playerId: res.playerId, token: res.token, name });
    });
  });

  el('btn-join').addEventListener('click', () => {
    AudioFX.unlock();
    const name = el('input-name').value.trim();
    const roomCode = el('input-roomcode').value.trim().toUpperCase();
    if (!name) { el('home-error').textContent = 'ニックネームを入力してください。'; return; }
    if (!roomCode) { el('home-error').textContent = 'ルームコードを入力してください。'; return; }
    socket.emit('room:join', { roomCode, name, avatar: myAvatarDataUrl }, (res) => {
      if (!res.ok) { el('home-error').textContent = res.error; return; }
      myPlayerId = res.playerId;
      saveSession({ roomCode: res.roomCode, playerId: res.playerId, token: res.token, name });
    });
  });

  // ------------------------------------------------------------------
  // ロビー画面
  // ------------------------------------------------------------------
  el('btn-leave-lobby').addEventListener('click', leaveRoom);

  el('btn-disband-lobby').addEventListener('click', () => {
    if (!confirm('ルームを解散しますか?(参加者全員がルームから退出します)')) return;
    socket.emit('room:disband', {}, (res) => {
      if (res && !res.ok) el('lobby-error').textContent = res.error;
      // 成功時は自分にも room:disbanded が届き、そちらでホーム画面に戻す処理をする
    });
  });

  // ホストがルームを解散したときに全員(ホスト自身も含む)呼ばれる。
  // BGM再生中やタイマーなど諸々の状態をきれいにリセットしたいので、退出時と同様にリロードする。
  socket.on('room:disbanded', () => {
    try { sessionStorage.setItem('daifugo-leave-notice', 'disband'); } catch (e) {}
    clearSession();
    location.reload();
  });

  // ホストにキックされたときに呼ばれる (自分だけ)。同様にリロードして状態をリセットする。
  socket.on('room:kicked', () => {
    try { sessionStorage.setItem('daifugo-leave-notice', 'kicked'); } catch (e) {}
    clearSession();
    location.reload();
  });

  el('btn-start').addEventListener('click', () => {
    socket.emit('room:start', {}, (res) => {
      if (!res.ok) el('lobby-error').textContent = res.error;
    });
  });

  socket.on('room:state', (state) => {
    if (state.started) return; // ゲーム中はロビーUIを更新しない
    showScreen('lobby');
    el('lobby-roomcode').textContent = state.code;
    const isHost = state.hostId === myPlayerId;
    const list = el('lobby-players');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      if (!p.connected) li.classList.add('disconnected');
      const left = document.createElement('span');
      left.className = 'p-left';
      const avatar = document.createElement('span');
      avatar.className = 'p-avatar';
      if (p.avatar) {
        const img = document.createElement('img');
        img.src = p.avatar;
        img.alt = '';
        avatar.appendChild(img);
      } else {
        avatar.textContent = escapeHtml(p.name).slice(0, 1);
      }
      left.appendChild(avatar);
      const label = document.createElement('span');
      label.textContent = p.name + (p.connected ? '' : ' (切断)');
      left.appendChild(label);
      li.appendChild(left);
      if (p.id === state.hostId) {
        const tag = document.createElement('span');
        tag.className = 'host-tag';
        tag.textContent = 'ホスト';
        li.appendChild(tag);
      } else if (isHost) {
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'kick-btn';
        kickBtn.textContent = 'キック';
        kickBtn.title = `${p.name} をキックする`;
        kickBtn.addEventListener('click', () => {
          if (!confirm(`${p.name} をキックしますか?`)) return;
          socket.emit('room:kick', { targetId: p.id }, (res) => {
            if (res && !res.ok) el('lobby-error').textContent = res.error;
          });
        });
        li.appendChild(kickBtn);
      }
      list.appendChild(li);
    });
    el('btn-start').hidden = !isHost;
    el('btn-start').disabled = state.players.length < 2;
    el('btn-disband-lobby').hidden = !isHost;
    el('lobby-wait-msg').hidden = isHost;

    const rulesBox = el('lobby-rules');
    rulesBox.innerHTML = '';
    if (state.rules) {
      Object.entries(RULE_LABELS).forEach(([key, label]) => {
        const tag = document.createElement('span');
        tag.className = 'tag' + (state.rules[key] ? ' on' : '');
        tag.textContent = (state.rules[key] ? '✓ ' : '✕ ') + label;
        rulesBox.appendChild(tag);
      });
    }
  });

  // ------------------------------------------------------------------
  // ゲーム画面
  // ------------------------------------------------------------------
  // J/Q/K は専用イラスト(/cards/*.png)を使用。4スートそれぞれ専用の絵柄。
  const FACE_RANKS = new Set(['J', 'Q', 'K']);
  const SUIT_FILE = { S: 's', H: 'h', D: 'd', C: 'c' };
  function cardNode(card, opts = {}) {
    const div = document.createElement('div');
    div.className = 'playing-card';
    if (opts.small) div.classList.add('small');
    if (card.joker) {
      div.classList.add('joker');
      div.innerHTML = '<div class="corner">JOKER</div><div>JOKER</div><div class="suit">★</div>';
    } else {
      const isRed = card.suit === 'H' || card.suit === 'D';
      div.classList.add(isRed ? 'red' : 'black');
      if (FACE_RANKS.has(card.rank)) {
        div.classList.add('has-art');
        const img = `/cards/${card.rank.toLowerCase()}-${SUIT_FILE[card.suit]}.png`;
        div.innerHTML = `<div class="corner">${card.rank}<br>${SUIT_SYMBOL[card.suit]}</div><img class="face-art" src="${img}" alt="${card.rank}${SUIT_SYMBOL[card.suit]}" draggable="false" />`;
      } else {
        div.innerHTML = `<div class="corner">${card.rank}<br>${SUIT_SYMBOL[card.suit]}</div><div>${card.rank}</div><div class="suit">${SUIT_SYMBOL[card.suit]}</div>`;
      }
    }
    return div;
  }

  const SEAT_COLORS = ['#e0899a', '#7fa8dd', '#82c69b', '#d6b25e', '#a58ce0'];
  function seatColorFor(playerId, state) {
    const idx = state.players.findIndex((p) => p.id === playerId);
    return SEAT_COLORS[idx % SEAT_COLORS.length];
  }

  function renderSelfBadge(state) {
    const me = state.players.find((p) => p.id === myPlayerId);
    if (!me) return;
    const avatarBox = el('self-avatar');
    avatarBox.innerHTML = me.avatar ? `<img src="${me.avatar}" alt="" />` : escapeHtml(me.name).slice(0, 1);
    el('self-name').textContent = me.name + (me.role ? `(${me.role})` : '');
  }

  function renderOpponents(state) {
    const container = el('opponents');
    container.innerHTML = '';
    const isHost = lastRoomHostId === myPlayerId;
    state.players
      .filter((p) => p.id !== myPlayerId)
      .forEach((p) => {
        const div = document.createElement('div');
        div.className = 'opponent';
        div.dataset.playerId = p.id;
        div.style.setProperty('--seat-color', seatColorFor(p.id, state));
        if (state.currentTurnPlayerId === p.id) div.classList.add('turn');
        if (p.finished) div.classList.add('finished');
        if (!p.connected) div.classList.add('disconnected');
        const avatarInner = p.avatar ? `<img src="${p.avatar}" alt="" />` : escapeHtml(p.name).slice(0, 1);
        div.innerHTML = `
          <div class="avatar">${avatarInner}</div>
          <div class="count">${p.finished ? 'あがり' : '🂠×' + p.handCount}</div>
          <div class="name">${escapeHtml(p.name)}</div>
          ${p.role ? `<div class="role">${p.role}</div>` : ''}
        `;
        if (isHost && p.connected) {
          const kickBtn = document.createElement('button');
          kickBtn.type = 'button';
          kickBtn.className = 'kick-btn kick-btn-opponent';
          kickBtn.textContent = 'キック';
          kickBtn.title = `${p.name} をキックする`;
          kickBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!confirm(`${p.name} をキックしますか?`)) return;
            socket.emit('room:kick', { targetId: p.id }, (res) => {
              if (res && !res.ok) toast(res.error);
            });
          });
          div.appendChild(kickBtn);
        }
        container.appendChild(div);
      });
  }

  // 場に出したカードを少し重ねて散らす (投げ出したような見た目)
  function fieldScatter(i, n) {
    const mid = (n - 1) / 2;
    const offset = i - mid;
    const rotate = offset * 7 + (i % 2 === 0 ? -4 : 4);
    const ty = ((i * 37) % 11) - 5;
    return `rotate(${rotate}deg) translateY(${ty}px)`;
  }
  // 今の選択状態から、次にどのカードを追加選択できるか (枚数上限 / ランク一致) を計算する。
  // ジョーカーは同じランクの束の穴埋めとして常に選べる。
  function selectionConstraints(state, selectedSet) {
    const hand = state.myHand;
    const field = state.field;
    const cap = field ? field.count : Infinity; // リード時(場が空)は枚数の上限なし
    const selectedCards = hand.filter((c) => selectedSet.has(c.id));
    const anchor = selectedCards.find((c) => !c.joker);
    return { cap, anchorRank: anchor ? anchor.rank : null };
  }
  function canAddToSelection(state, selectedSet, card) {
    const { cap, anchorRank } = selectionConstraints(state, selectedSet);
    if (selectedSet.size >= cap) return false;
    if (anchorRank && !card.joker && card.rank !== anchorRank) return false;
    return true;
  }

  function renderField(state) {
    const fc = el('field-cards');
    const fieldSig = state.field ? state.field.cards.map((c) => c.id).join(',') : 'EMPTY';
    // renderField()は場の中身と無関係な理由(手札選択・その他の再描画)でも何度も呼ばれることがある。
    // fieldSigが直前に実際に描画した内容と同じ(=本当に新しいプレイではない)場合は
    // 場のDOMには一切手を加えない。毎回作り直してしまうと、直前の呼び出しで付けた
    // flying-inクラス(モーション再生中のDOM要素そのもの)を消してしまい、
    // 「相手のプレイ直後にすぐ自分の手番になる」ケースなどでエフェクトが見えなくなる。
    if (state.field) {
      el('field-empty').hidden = true;
      if (fieldSig !== lastPileFieldSig) {
        fc.innerHTML = '';
        const pile = document.createElement('div');
        pile.className = 'field-pile';
        state.field.cards.forEach((c, i) => {
          const node = cardNode(c);
          node.style.transform = fieldScatter(i, state.field.cards.length);
          node.style.zIndex = String(i);
          node.style.animationDelay = `${i * 45}ms`;
          pile.appendChild(node);
        });
        fc.appendChild(pile);
        const by = document.createElement('div');
        by.className = 'field-by';
        by.textContent = `${state.field.playerName} が出した`;
        fc.appendChild(by);

        // 出した本人の位置(自分の手札 or 相手の席)から場までカードが飛んでくるモーション
        // (このブロックに入るのは fieldSig が変わったとき = 本当に新しいプレイのときだけ)
        const originEl = state.field.playerId === myPlayerId
          ? el('hand-cards')
          : document.querySelector(`.opponent[data-player-id="${state.field.playerId}"]`);
        if (originEl) {
          const originRect = originEl.getBoundingClientRect();
          const destRect = fc.getBoundingClientRect();
          const dx = (originRect.left + originRect.width / 2) - (destRect.left + destRect.width / 2);
          const dy = (originRect.top + originRect.height / 2) - (destRect.top + destRect.height / 2);
          pile.style.setProperty('--fly-x', `${dx}px`);
          pile.style.setProperty('--fly-y', `${dy}px`);
          pile.classList.add('flying-in');
        }
        lastPileFieldSig = fieldSig;
      }
      freshFieldPlay = false;
    } else {
      if (lastPileFieldSig !== 'EMPTY') fc.innerHTML = '';
      lastPileFieldSig = 'EMPTY';
      el('field-empty').hidden = false;
    }
  }

  // 今出せる/出せないカードを判定する (自分の番のときだけ意味を持つ)
  function computePlayableCardIds(state) {
    if (state.phase !== 'PLAYING' || state.currentTurnPlayerId !== myPlayerId) return null;
    const hand = state.myHand;
    const field = state.field;
    // サーバーの effectiveRevolution() と同じロジック (通常の革命 XOR イレブンバック)
    const revolution = !!state.revolution !== !!state.elevenBack;
    const lockedSuits = state.lockedSuits;
    const rules = state.rules || {};
    const byRank = new Map();
    hand.forEach((c) => {
      const key = c.joker ? 'JOKER' : c.rank;
      if (!byRank.has(key)) byRank.set(key, []);
      byRank.get(key).push(c);
    });
    const neededCount = field ? field.count : 1;
    const result = new Set();
    byRank.forEach((cards, rankKey) => {
      if (cards.length < neededCount) return;
      if (!field) { cards.forEach((c) => result.add(c.id)); return; }
      const isSpade3Group = rules.spade3Return && rankKey === '3' && field.rank === 'JOKER' && field.count === 1;
      if (isSpade3Group) {
        cards.forEach((c) => { if (c.suit === 'S') result.add(c.id); });
        return;
      }
      const fieldStrength = strengthOf(field.rank, revolution);
      const myStrength = strengthOf(rankKey, revolution);
      if (myStrength <= fieldStrength) return;
      if (lockedSuits && rankKey !== 'JOKER') {
        const suitSet = Array.from(new Set(cards.map((c) => c.suit))).sort();
        const locked = lockedSuits.slice().sort();
        const matches = suitSet.length === locked.length && suitSet.every((s, i) => s === locked[i]);
        if (!matches) return;
      }
      cards.forEach((c) => result.add(c.id));
    });
    return result;
  }

  // 手札全体がスライドせず1画面に収まるよう、枚数と幅から重なり幅を動的に計算する
  // 手札全体がスライドせず1画面に収まるよう、枚数と横幅から
  // (1) カード自体の縮小率(--hand-card-scale) と (2) 重なり幅 を動的に計算する。
  // どんなに枚数が多くても、隣のカードに隠れる部分は最大 maxOverlapRatio までに抑えるので
  // 左上の角(ランク/マーク)は常に見える状態を保ったまま、横スクロール無しで全部見えるようにする。
  function layoutHandOverlap(container, nodes) {
    const n = nodes.length;
    if (n === 0) return;
    // まず等倍でカード本来の幅を測るためにリセット
    container.style.setProperty('--hand-card-scale', '1');
    nodes.forEach((node) => { node.style.marginLeft = '0px'; });
    if (n <= 1) return;
    const cs = getComputedStyle(container);
    const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const containerWidth = container.clientWidth - padding;
    const baseCardWidth = nodes[0].offsetWidth;
    // 重ねても角のランク/マークだけは必ず見える範囲(以前は0.74だったが、枚数が多いときに
    // 隣のカードが角の文字まで覆ってしまい「何のカードか分からない」状態になっていたため、
    // 「重ねる」より先に「縮める」を優先するよう引き下げた)
    const maxOverlapRatio = 0.58;
    const minScale = 0.5; // これ以上は読めなくなるので縮小しない(枚数が多いときに手札欄の下が余りすぎないよう、0.42から引き上げ)

    // 手札は回転させないので、幅の計算はシンプルにカードの並び幅だけで済む
    // (以前は回転によるはみ出し分の補正が必要だったが、回転自体を廃止したため不要)。
    const cardAspect = 141 / 100; // .playing-card の height / width

    function widthForScale(s) {
      const cardWidth = baseCardWidth * s;
      const naturalTotal = cardWidth * n;
      let overlap = 0;
      if (naturalTotal > containerWidth) {
        overlap = (naturalTotal - containerWidth) / (n - 1);
        overlap = Math.min(overlap, cardWidth * maxOverlapRatio);
      }
      const totalWidth = cardWidth + (n - 1) * (cardWidth - overlap);
      return { cardWidth, overlap, totalWidth };
    }

    const denom = 1 + (n - 1) * (1 - maxOverlapRatio);
    let scale = containerWidth / (baseCardWidth * denom);
    scale = Math.max(minScale, Math.min(1, scale));
    let { cardWidth, overlap, totalWidth } = widthForScale(scale);

    // 上限の重なり率のままでは計算上まだ収まらない(=縮小率が下限に近い)場合のみ、
    // 重なりを増やす前にカード自体をもう少し縮める(角のランク/マークを優先して残す)
    let guard = 0;
    while (totalWidth > containerWidth + 0.5 && scale > minScale && guard++ < 12) {
      scale = Math.max(minScale, scale - 0.02);
      ({ cardWidth, overlap, totalWidth } = widthForScale(scale));
    }

    container.style.setProperty('--hand-card-scale', String(scale));
    nodes.forEach((node, i) => {
      if (i > 0) node.style.marginLeft = `-${overlap}px`;
    });

    // 最小縮小率まで来てもなお計算上収まらない(極端に枚数が多い場合)は、
    // スクロールさせない方を優先し、最後の手段として重なりを追加する。
    if (totalWidth > containerWidth + 0.5) {
      const extra = (totalWidth - containerWidth) / (n - 1) + 0.5;
      overlap = Math.min(overlap + extra, cardWidth * 0.92);
      nodes.forEach((node, i) => {
        if (i > 0) node.style.marginLeft = `-${overlap}px`;
      });
    }

    // 一番右のカードだけは後ろに隠す隣がいないため、他のカードが「一部だけ見える帯」
    // なのに1枚だけ全部見えてしまい、バランスが悪く見える原因になっていた。
    // clip-path で右端を他のカードと同じ幅だけ切って見た目の帯幅を揃える
    // (レイアウト上の幅・全体の横幅には影響しない = はみ出しの心配はない)。
    // ホバー時は z-index が最前面に来る通常の挙動と同じく、確認しやすいよう全体を見せる。
    nodes.forEach((node, i) => {
      node.style.clipPath = i === n - 1 && overlap > 0 ? `inset(0 ${overlap}px 0 0)` : '';
    });

    // 手札の枚数が多くて --hand-card-scale が縮んだときに、手札欄の高さだけ
    // 全枚数最大時のまま余ってしまわないよう、実際のカード高さに合わせて詰める。
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const cardHeight = cardWidth * cardAspect;
    container.style.minHeight = `${Math.round(padTop + cardHeight + padBottom)}px`;
  }

  // カードの並び(枚数・順序)が前回と同じ場合に使い回すためのキャッシュ。
  // 選択操作のたびに手札のDOMを全部作り直すと、レイアウト計算が
  // (等倍にリセット→再計算) の順で走る関係で手札全体が一瞬リセットされたように
  // 見えてしまっていたため、並びが変わっていないときはクラスの更新だけで済ませる。
  let handNodeCache = new Map(); // cardId -> node
  let lastHandOrder = [];

  function applyHandCardState(node, c, state, isExchange, isSevenGive) {
    const selected = isExchange ? selectedExchangeIds.has(c.id) : isSevenGive ? selectedSevenGiveIds.has(c.id) : selectedCardIds.has(c.id);
    node.classList.toggle('selected', selected);
    const playableIds = computePlayableCardIds(state);
    node.classList.toggle('playable', !!playableIds && playableIds.has(c.id));
    node.classList.toggle('unplayable', !!playableIds && !playableIds.has(c.id));
    // 通常プレイ中: 今の選択と組み合わせられない(枚数上限オーバー/ランク不一致)カードは
    // 選べないことを見た目でも示す (同じカードの束 + ジョーカー以外は複数選択できない)
    const locked = !isExchange && !isSevenGive && !selected && !canAddToSelection(state, selectedCardIds, c);
    node.classList.toggle('select-locked', locked);
  }

  function renderHand(state) {
    const hc = el('hand-cards');
    // 選択状態のクリーンアップ (手札から消えたカードIDを除去)
    const idsInHand = new Set(state.myHand.map((c) => c.id));
    selectedCardIds.forEach((id) => { if (!idsInHand.has(id)) selectedCardIds.delete(id); });

    // 交換/7渡しフェーズでは手札から消えたカードを除去 (選択リストのクリーンアップ)
    selectedExchangeIds.forEach((id) => { if (!idsInHand.has(id)) selectedExchangeIds.delete(id); });
    selectedSevenGiveIds.forEach((id) => { if (!idsInHand.has(id)) selectedSevenGiveIds.delete(id); });

    const isExchange = state.phase === 'EXCHANGE';
    const isSevenGive = state.phase === 'SEVEN_GIVE';
    const newOrder = state.myHand.map((c) => c.id);
    const sameOrder = newOrder.length === lastHandOrder.length && newOrder.every((id, i) => id === lastHandOrder[i]);

    if (sameOrder) {
      // 枚数・並びが変わっていないので、既存のDOM要素はそのまま使い回して
      // クラスだけ更新する(選択トグルのたびに作り直さない = 見た目がリセットされない)
      state.myHand.forEach((c) => {
        const node = handNodeCache.get(c.id);
        if (node) applyHandCardState(node, c, state, isExchange, isSevenGive);
      });
      return;
    }

    hc.innerHTML = '';
    handNodeCache = new Map();
    lastHandOrder = newOrder;
    const nodes = [];
    state.myHand.forEach((c, i) => {
      const node = cardNode(c);
      applyHandCardState(node, c, state, isExchange, isSevenGive);
      // ホバー時はまっすぐ上に持ち上げる
      // (--lift を hover 時だけ CSS 側で書き換える。scale もしない = 横幅が変わらず隣のカードを覆わない)
      node.style.transform = 'translateY(var(--lift, 0px))';
      node.style.transformOrigin = 'bottom center';
      node.style.zIndex = String(i);
      node.addEventListener('click', () => {
        if (state.phase === 'EXCHANGE' || state.phase === 'SEVEN_GIVE') return; // 交換/7渡しフェーズは別ハンドラ
        if (selectedCardIds.has(c.id)) selectedCardIds.delete(c.id);
        else if (canAddToSelection(state, selectedCardIds, c)) selectedCardIds.add(c.id);
        else return;
        renderHand(state);
        updateActionButtons(state);
      });
      handNodeCache.set(c.id, node);
      hc.appendChild(node);
      nodes.push(node);
    });
    layoutHandOverlap(hc, nodes);
  }

  function renderExchange(state) {
    const panel = el('exchange-panel');
    const myTask = state.pendingExchange && state.pendingExchange.find((r) => r.playerId === myPlayerId && !r.done);
    if (state.phase !== 'EXCHANGE' || !myTask) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    el('exchange-desc').textContent = `渡すカードを${myTask.count}枚選んでください (${selectedExchangeIds.size}/${myTask.count})`;
    el('btn-exchange-submit').disabled = selectedExchangeIds.size !== myTask.count;
  }

  function renderSevenGive(state) {
    const panel = el('sevengive-panel');
    const waitPanel = el('sevengive-wait');
    const pending = state.pendingSevenGive;
    if (state.phase !== 'SEVEN_GIVE' || !pending) {
      panel.hidden = true;
      waitPanel.hidden = true;
      return;
    }
    if (pending.playerId !== myPlayerId) {
      panel.hidden = true;
      waitPanel.hidden = false;
      el('sevengive-wait-desc').textContent = `${state.players.find((p) => p.id === pending.playerId)?.name || '相手'} がカードを渡す相手を選んでいます…`;
      return;
    }
    waitPanel.hidden = true;
    panel.hidden = false;
    el('sevengive-desc').textContent = `渡すカードを${pending.count}枚選び、渡す相手を選んでください (${selectedSevenGiveIds.size}/${pending.count})`;
    if (sevenGiveTarget && !pending.candidates.some((c) => c.id === sevenGiveTarget)) sevenGiveTarget = null;
    const box = el('sevengive-candidates');
    box.innerHTML = '';
    pending.candidates.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'candidate-btn' + (sevenGiveTarget === c.id ? ' selected' : '');
      btn.textContent = c.name;
      btn.addEventListener('click', () => { sevenGiveTarget = c.id; renderSevenGive(state); });
      box.appendChild(btn);
    });
    el('btn-sevengive-submit').disabled = selectedSevenGiveIds.size !== pending.count || !sevenGiveTarget;
  }

  function renderLog(state) {
    const list = el('log-list');
    list.innerHTML = '';
    state.log.forEach((entry) => {
      const div = document.createElement('div');
      div.textContent = entry.message;
      list.appendChild(div);
    });
    list.scrollTop = list.scrollHeight;
  }

  function renderRoundEnd(state) {
    const modal = el('modal-roundend');
    if (state.phase !== 'ROUND_END') { modal.hidden = true; return; }
    modal.hidden = false;
    const list = el('roundend-list');
    list.innerHTML = '';
    state.finishedOrder.forEach((f, idx) => {
      const li = document.createElement('li');
      li.textContent = `${idx + 1}位: ${f.name} (${f.role || ''})`;
      list.appendChild(li);
    });
    const isHost = lastRoomHostId === myPlayerId;
    el('btn-next-round').hidden = !isHost;
    el('roundend-wait').hidden = isHost;
  }

  function updateActionButtons(state) {
    const myTurn = state.currentTurnPlayerId === myPlayerId && state.phase === 'PLAYING';
    const iAmFinished = state.players.find((p) => p.id === myPlayerId)?.finished;
    el('btn-play').disabled = !myTurn || iAmFinished || selectedCardIds.size === 0;
    el('btn-pass').disabled = !myTurn || iAmFinished || !state.field;
  }

  // 手番の残り時間バッジ (毎秒更新。0秒になったら次のgame:stateが来るまで0のまま表示)
  let turnTimerInterval = null;
  function renderTurnTimer(state) {
    const badge = el('meta-turn-timer');
    if (!badge) return;
    if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
    if (state.phase !== 'PLAYING' || !state.turnDeadline) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    const update = () => {
      const remain = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
      badge.textContent = `⏱ ${remain}`;
      badge.classList.toggle('badge-timer-warn', remain <= 10);
      if (remain <= 0 && turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
    };
    update();
    turnTimerInterval = setInterval(update, 250);
  }

  function renderMeta(state) {
    el('meta-round').textContent = `ラウンド ${state.round}`;
    const rev = el('meta-revolution');
    rev.hidden = !!state.rules && !state.rules.revolution;
    rev.classList.toggle('badge-on', state.revolution);
    rev.classList.toggle('badge-off', !state.revolution);
    const shibari = el('meta-shibari');
    shibari.hidden = !!state.rules && !state.rules.shibari;
    shibari.classList.toggle('badge-on', !!state.lockedSuits);
    shibari.classList.toggle('badge-off', !state.lockedSuits);
    shibari.textContent = state.lockedSuits ? `しばり(${state.lockedSuits.map((s) => SUIT_SYMBOL[s]).join('')})` : 'しばり';

    const eleven = el('meta-eleven');
    if (eleven) {
      eleven.hidden = !!state.rules && !state.rules.elevenBack;
      eleven.classList.toggle('badge-on', !!state.elevenBack);
      eleven.classList.toggle('badge-off', !state.elevenBack);
    }
    // 実際に今トリックで有効な強さの向き (通常の革命 XOR イレブンバック)
    const effectiveRevolution = !!state.revolution !== !!state.elevenBack;
    const field = el('field-area');
    if (field) field.classList.toggle('revolution', effectiveRevolution);
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let lastRoomHostId = null;
  socket.on('room:state', (state) => { lastRoomHostId = state.hostId; });

  // ------------------------------------------------------------------
  // 演出 (革命 / 8切り / スペ3返し / あがり)
  // ------------------------------------------------------------------
  const EFFECT_CLASS = { REVOLUTION: 'revolution', EIGHT_CUT: 'eight', SPADE3_RETURN: 'spade3', FINISH: 'finish', ELEVEN_BACK: 'elevenback' };
  function playEffect(type, text) {
    return new Promise((resolve) => {
      const flash = el('fx-flash');
      const wrap = el('fx-banner-wrap');
      const banner = el('fx-banner');
      const cls = EFFECT_CLASS[type];
      flash.className = 'fx-flash ' + cls;
      banner.className = 'fx-banner ' + cls;
      banner.textContent = text;
      flash.hidden = false;
      wrap.hidden = false;
      void flash.offsetWidth;
      void banner.offsetWidth;
      flash.classList.add('play');
      wrap.classList.add('play');
      setTimeout(() => {
        flash.hidden = true;
        wrap.hidden = true;
        flash.classList.remove('play');
        wrap.classList.remove('play');
        resolve();
      }, 950);
    });
  }
  function triggerEffects(state) {
    if (state.seq === undefined) return;
    const fieldSig = state.field ? state.field.cards.map((c) => c.id).join(',') : 'EMPTY';
    if (state.seq === lastEffectSeq) {
      lastTurnPlayerId = state.currentTurnPlayerId;
      freshFieldPlay = false;
      return;
    }
    const firstRender = lastEffectSeq === -1;
    lastEffectSeq = state.seq;
    const prevFieldSig = lastFieldSig;
    const prevTurnPlayerId = lastTurnPlayerId;
    lastFieldSig = fieldSig;
    lastTurnPlayerId = state.currentTurnPlayerId;
    // 「新しく場にカードが出た」ときだけ、出した人からのモーションを再生する
    freshFieldPlay = !firstRender && fieldSig !== 'EMPTY' && fieldSig !== prevFieldSig;
    if (firstRender) return;

    const effects = state.effects || [];
    const actor = state.effectByName || '';
    const jobs = [];
    if (effects.includes('REVOLUTION')) { jobs.push(() => playEffect('REVOLUTION', '革命!!')); AudioFX.revolution(); }
    if (effects.includes('ELEVEN_BACK')) { jobs.push(() => playEffect('ELEVEN_BACK', 'イレブンバック!')); AudioFX.elevenBack(); }
    if (effects.includes('EIGHT_CUT')) { jobs.push(() => playEffect('EIGHT_CUT', '8切り!')); AudioFX.eightCut(); }
    if (effects.includes('SPADE3_RETURN')) { jobs.push(() => playEffect('SPADE3_RETURN', 'スペ3返し!')); AudioFX.spade3(); }
    if (effects.includes('FINISH')) { jobs.push(() => playEffect('FINISH', `${actor} あがり!`)); AudioFX.finish(); }
    if (jobs.length === 0) {
      if (fieldSig !== 'EMPTY' && fieldSig !== prevFieldSig) AudioFX.playCard();
      else if (fieldSig === prevFieldSig && prevFieldSig !== null) AudioFX.pass();
    }
    if (jobs.length) effectQueue = effectQueue.then(() => jobs.reduce((p, job) => p.then(job), Promise.resolve()));

    if (!firstRender && state.phase === 'PLAYING' && state.currentTurnPlayerId === myPlayerId && prevTurnPlayerId !== myPlayerId) {
      AudioFX.yourTurn();
    }
  }

  socket.on('game:state', (state) => {
    lastGameState = state;
      showScreen('game');
    triggerEffects(state);
    renderMeta(state);
    renderTurnTimer(state);
    renderSelfBadge(state);
    renderOpponents(state);
    renderField(state);
    renderHand(state);
    renderExchange(state);
    renderSevenGive(state);
    renderLog(state);
    renderRoundEnd(state);
    updateActionButtons(state);
  });

  socket.on('game:stickerReceived', ({ playerName, stickerId }) => {
    showStickerBubble(playerName, stickerId);
  });

  el('btn-play').addEventListener('click', () => {
    if (selectedCardIds.size === 0) return;
    socket.emit('game:play', { cardIds: Array.from(selectedCardIds) }, (res) => {
      if (!res.ok) toast(res.error);
      else selectedCardIds.clear();
    });
  });

  el('btn-pass').addEventListener('click', () => {
    socket.emit('game:pass', {}, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  el('btn-log-toggle').addEventListener('click', () => {
    const panel = el('log-panel');
    panel.hidden = !panel.hidden;
  });

  buildStickerPanel();
  el('btn-sticker-toggle').addEventListener('click', () => {
    const panel = el('sticker-panel');
    panel.hidden = !panel.hidden;
  });

  el('btn-mute').addEventListener('click', () => {
    AudioFX.unlock();
    AudioFX.setMuted(!AudioFX.isMuted());
    el('btn-mute').textContent = AudioFX.isMuted() ? '🔇' : '🔊';
  });

  el('btn-leave-game').addEventListener('click', leaveRoom);

  // ------------------------------------------------------------------
  // BGM (YouTube Music 風のミニプレイヤー) - ゲーム中に裏で音楽を流す
  // ------------------------------------------------------------------
  function extractYoutubeId(input) {
    const s = (input || '').trim();
    if (/^[\w-]{11}$/.test(s)) return s; // 動画IDそのまま貼られた場合
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/)([\w-]{11})/,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return m[1];
    }
    return null;
  }
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  const Bgm = {
    queue: [],
    index: -1,
    repeatMode: 'all', // 'off' | 'all' | 'one'
    player: null,
    ready: false,
    progressTimer: null,
    init(playerVar) {
      this.player = playerVar;
      this.ready = true;
      this.player.setVolume(Number(el('bgm-volume').value));
      el('bgm-note').textContent = '';
    },
    apiFailed() {
      el('bgm-note').textContent = 'YouTubeプレイヤーを読み込めませんでした(ネットワーク接続を確認してください)。';
    },
    async addByUrl(rawUrl) {
      const id = extractYoutubeId(rawUrl);
      if (!id) { toast('YouTubeのURLが読み取れませんでした。'); return; }
      const track = { id, title: 'YouTube 動画', channel: '', thumb: `https://img.youtube.com/vi/${id}/mqdefault.jpg` };
      this.queue.push(track);
      this.renderQueue();
      // タイトル/チャンネル名は取得できれば後から差し替え (失敗しても再生には影響しない)
      fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          track.title = data.title || track.title;
          track.channel = data.author_name || '';
          this.renderQueue();
          if (this.queue[this.index] === track) this.renderNowPlaying();
        })
        .catch(() => {});
      if (this.index === -1) this.playIndex(this.queue.length - 1);
    },
    playIndex(i) {
      if (i < 0 || i >= this.queue.length) return;
      this.index = i;
      const track = this.queue[i];
      if (!this.ready || !this.player) {
        el('bgm-note').textContent = 'YouTubeプレイヤーの準備中です…もう一度お試しください。';
        this.renderNowPlaying();
        this.renderQueue();
        return;
      }
      this.player.loadVideoById(track.id);
      this.renderNowPlaying();
      this.renderQueue();
    },
    playPause() {
      if (!this.ready || !this.player) return;
      if (this.index === -1 && this.queue.length) { this.playIndex(0); return; }
      const state = this.player.getPlayerState();
      if (state === 1) this.player.pauseVideo();
      else this.player.playVideo();
    },
    next() {
      if (this.queue.length === 0) return;
      this.playIndex((this.index + 1) % this.queue.length);
    },
    prev() {
      if (this.queue.length === 0) return;
      this.playIndex((this.index - 1 + this.queue.length) % this.queue.length);
    },
    cycleRepeat() {
      this.repeatMode = this.repeatMode === 'off' ? 'all' : this.repeatMode === 'all' ? 'one' : 'off';
      this.renderRepeatButton();
    },
    renderRepeatButton() {
      const btn = el('bgm-repeat');
      if (!btn) return;
      btn.classList.toggle('active', this.repeatMode !== 'off');
      btn.dataset.mode = this.repeatMode;
      btn.title = this.repeatMode === 'off' ? 'リピート: オフ' : this.repeatMode === 'all' ? 'リピート: 全曲' : 'リピート: この曲';
    },
    remove(i) {
      const wasPlaying = i === this.index;
      this.queue.splice(i, 1);
      if (i < this.index) this.index -= 1;
      else if (wasPlaying) {
        this.index = -1;
        if (this.ready && this.player) this.player.stopVideo();
        if (this.queue.length) this.playIndex(Math.min(i, this.queue.length - 1));
      }
      this.renderNowPlaying();
      this.renderQueue();
    },
    onStateChange(ytState) {
      const btn = el('bgm-playpause');
      if (ytState === 1) { // playing
        btn.textContent = '⏸';
        this.startProgressLoop();
      } else {
        btn.textContent = '▶';
        if (ytState !== 3) this.stopProgressLoop(); // 3=buffering中はループ継続
      }
      if (ytState === 0) { // ended
        if (this.repeatMode === 'one') { this.playIndex(this.index); return; }
        if (this.repeatMode === 'off' && this.index >= this.queue.length - 1) return; // 最後まで来たら止める
        this.next();
      }
    },
    startProgressLoop() {
      this.stopProgressLoop();
      this.progressTimer = setInterval(() => this.updateProgress(), 500);
      this.updateProgress();
    },
    stopProgressLoop() {
      if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
    },
    updateProgress() {
      if (!this.ready || !this.player) return;
      const dur = this.player.getDuration() || 0;
      const cur = this.player.getCurrentTime() || 0;
      el('bgm-time-current').textContent = formatTime(cur);
      el('bgm-time-duration').textContent = formatTime(dur);
      el('bgm-progress-fill').style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : '0%';
    },
    renderNowPlaying() {
      const track = this.index >= 0 ? this.queue[this.index] : null;
      const thumb = el('bgm-thumb');
      const thumbEmpty = el('bgm-thumb-empty');
      if (track) {
        thumb.src = track.thumb;
        thumb.hidden = false;
        thumbEmpty.hidden = true;
        el('bgm-title').textContent = track.title;
        el('bgm-channel').textContent = track.channel;
      } else {
        thumb.hidden = true;
        thumbEmpty.hidden = false;
        el('bgm-title').textContent = '再生中の曲はありません';
        el('bgm-channel').textContent = '';
        el('bgm-progress-fill').style.width = '0%';
        el('bgm-time-current').textContent = '0:00';
        el('bgm-time-duration').textContent = '0:00';
      }
    },
    renderQueue() {
      const box = el('bgm-queue');
      box.innerHTML = '';
      this.queue.forEach((track, i) => {
        const row = document.createElement('div');
        row.className = 'bgm-queue-item' + (i === this.index ? ' playing' : '');
        const img = document.createElement('img');
        img.src = track.thumb;
        img.alt = '';
        const title = document.createElement('span');
        title.className = 'qi-title';
        title.textContent = track.title;
        const remove = document.createElement('button');
        remove.className = 'qi-remove';
        remove.textContent = '×';
        remove.title = 'キューから削除';
        remove.addEventListener('click', (ev) => { ev.stopPropagation(); this.remove(i); });
        row.appendChild(img);
        row.appendChild(title);
        row.appendChild(remove);
        row.addEventListener('click', () => this.playIndex(i));
        box.appendChild(row);
      });
    },
  };

  window.onYouTubeIframeAPIReady = function () {
    try {
      const player = new YT.Player('yt-bgm-player', {
        height: '0',
        width: '0',
        playerVars: { playsinline: 1 },
        events: {
          onReady: () => Bgm.init(player),
          onStateChange: (e) => Bgm.onStateChange(e.data),
          onError: () => toast('この動画は再生できませんでした。'),
        },
      });
    } catch (e) {
      Bgm.apiFailed();
    }
  };
  // YouTube IFrame API 自体の読み込みに失敗した場合 (オフライン等) のフォールバック
  setTimeout(() => { if (!Bgm.ready) Bgm.apiFailed(); }, 8000);

  el('btn-bgm-toggle').addEventListener('click', () => {
    AudioFX.unlock();
    const panel = el('bgm-panel');
    panel.hidden = !panel.hidden;
  });
  el('bgm-add').addEventListener('click', () => {
    const input = el('bgm-url');
    if (!input.value.trim()) return;
    Bgm.addByUrl(input.value);
    input.value = '';
  });
  el('bgm-url').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('bgm-add').click();
  });
  el('bgm-playpause').addEventListener('click', () => Bgm.playPause());
  el('bgm-prev').addEventListener('click', () => Bgm.prev());
  el('bgm-next').addEventListener('click', () => Bgm.next());
  el('bgm-repeat').addEventListener('click', () => Bgm.cycleRepeat());
  Bgm.renderRepeatButton();
  el('bgm-volume').addEventListener('input', (ev) => {
    if (Bgm.ready && Bgm.player) Bgm.player.setVolume(Number(ev.target.value));
  });
  el('bgm-progress-track').addEventListener('click', (ev) => {
    if (!Bgm.ready || !Bgm.player || Bgm.index === -1) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const dur = Bgm.player.getDuration() || 0;
    if (dur > 0) Bgm.player.seekTo(dur * ratio, true);
  });

  el('btn-next-round').addEventListener('click', () => {
    socket.emit('room:nextRound', {}, (res) => {
      if (!res.ok) toast(res.error);
    });
  });
  el('btn-leave-round').addEventListener('click', leaveRoom);

  // 交換フェーズ用のカード選択 (renderHand内では拾えないので専用に上書き)
  el('hand-cards').addEventListener('click', (e) => {
    if (!lastGameState) return;
    const cardEl = e.target.closest('.playing-card');
    if (!cardEl) return;
    const idx = Array.from(el('hand-cards').children).indexOf(cardEl);
    const card = lastGameState.myHand[idx];
    if (!card) return;

    if (lastGameState.phase === 'EXCHANGE') {
      const myTask = lastGameState.pendingExchange && lastGameState.pendingExchange.find((r) => r.playerId === myPlayerId && !r.done);
      if (!myTask) return;
      if (selectedExchangeIds.has(card.id)) {
        selectedExchangeIds.delete(card.id);
        cardEl.classList.remove('selected');
      } else {
        if (selectedExchangeIds.size >= myTask.count) return;
        selectedExchangeIds.add(card.id);
        cardEl.classList.add('selected');
      }
      renderExchange(lastGameState);
      return;
    }

    if (lastGameState.phase === 'SEVEN_GIVE') {
      const pending = lastGameState.pendingSevenGive;
      if (!pending || pending.playerId !== myPlayerId) return;
      if (selectedSevenGiveIds.has(card.id)) {
        selectedSevenGiveIds.delete(card.id);
        cardEl.classList.remove('selected');
      } else {
        if (selectedSevenGiveIds.size >= pending.count) return;
        selectedSevenGiveIds.add(card.id);
        cardEl.classList.add('selected');
      }
      renderSevenGive(lastGameState);
    }
  });

  el('btn-exchange-submit').addEventListener('click', () => {
    socket.emit('game:exchangeReturn', { cardIds: Array.from(selectedExchangeIds) }, (res) => {
      if (!res.ok) { toast(res.error); return; }
      selectedExchangeIds.clear();
    });
  });

  el('btn-sevengive-submit').addEventListener('click', () => {
    if (!sevenGiveTarget) return;
    socket.emit('game:sevenGive', { cardIds: Array.from(selectedSevenGiveIds), toPlayerId: sevenGiveTarget }, (res) => {
      if (!res.ok) { toast(res.error); return; }
      selectedSevenGiveIds.clear();
      sevenGiveTarget = null;
    });
  });

  // ------------------------------------------------------------------
  // 起動時: 保存されたセッションがあれば自動再接続
  // ------------------------------------------------------------------
  socket.on('connect', () => {
    const session = loadSession();
    if (session && session.roomCode && session.playerId && session.token) {
      socket.emit('room:rejoin', session, (res) => {
        if (res.ok) {
          myPlayerId = res.playerId;
        } else {
          clearSession();
          showScreen('home');
        }
      });
    }
  });
})();
