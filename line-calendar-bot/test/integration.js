/**
 * Webhook 受信からカレンダー登録・返信までを、GAS のサービスを差し替えて通しで検証する。
 * `node test/integration.js` で実行する。
 */
process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FIXED_NOW = new Date(2026, 8, 13, 10, 0, 0).getTime(); // 2026-09-13(日) 10:00

/* ------------------------------------------------------------------ *
 * GAS サービスのスタブ
 * ------------------------------------------------------------------ */

function buildSandbox() {
  const state = {
    props: new Map(),
    cache: new Map(),
    calendars: new Map(),
    sent: [],
    logs: [],
    lockTaken: 0,
    lockReleased: 0,
    webAppUrl: 'https://script.google.com/macros/s/AKfyTEST/exec'
  };

  let eventSeq = 0;
  let uuidSeq = 1;

  function makeCalendar(id) {
    const events = [];
    const cal = {
      getId: () => id,
      _events: events,
      createEvent(title, start, end) { return add(title, start, end, false); },
      createAllDayEvent(title, start, end) {
        return add(title, start, end || new Date(start.getTime() + 86400000), true);
      },
      getEvents(from, to) {
        return events.filter((e) => !e.deleted && e.end > from && e.start < to)
          .sort((a, b) => a.start - b.start);
      },
      getEventById(eventId) {
        return events.find((e) => e.id === eventId && !e.deleted) || null;
      }
    };
    function add(title, start, end, allDay) {
      const ev = {
        id: 'evt' + (++eventSeq) + '@google.com',
        title, start, end, allDay, location: '', description: '', deleted: false,
        calendarId: id
      };
      ev.getId = () => ev.id;
      ev.getTitle = () => ev.title;
      ev.getStartTime = () => ev.start;
      ev.getEndTime = () => ev.end;
      ev.isAllDayEvent = () => ev.allDay;
      ev.getLocation = () => ev.location;
      ev.setLocation = (v) => { ev.location = v; return ev; };
      ev.setDescription = (v) => { ev.description = v; return ev; };
      ev.deleteEvent = () => { ev.deleted = true; };
      events.push(ev);
      return ev;
    }
    return cal;
  }

  function calendar(id) {
    if (!state.calendars.has(id)) state.calendars.set(id, makeCalendar(id));
    return state.calendars.get(id);
  }

  const pad = (n, w) => String(n).padStart(w, '0');

  const sandbox = {
    console: {
      log: (m) => state.logs.push(['log', String(m)]),
      warn: (m) => state.logs.push(['warn', String(m)]),
      error: (m) => state.logs.push(['error', String(m)])
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (state.props.has(k) ? state.props.get(k) : null),
        setProperty: (k, v) => { state.props.set(k, String(v)); }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (state.cache.has(k) ? state.cache.get(k) : null),
        put: (k, v) => { state.cache.set(k, v); },
        remove: (k) => { state.cache.delete(k); }
      })
    },
    CalendarApp: {
      getDefaultCalendar: () => calendar('primary'),
      getCalendarById: (id) => calendar(id)
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { state.lockTaken++; return true; },
        releaseLock: () => { state.lockReleased++; }
      })
    },
    ScriptApp: { getService: () => ({ getUrl: () => state.webAppUrl }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        state.sent.push({ url, payload: JSON.parse(opts.payload) });
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      }
    },
    Utilities: {
      getUuid: () => 'uuid-' + (uuidSeq++).toString().padStart(8, '0') + '-aaaa-bbbb-cccc',
      formatDate: (d, tz, fmt) => fmt
        .replace(/yyyy/g, d.getFullYear())
        .replace(/MM/g, pad(d.getMonth() + 1, 2))
        .replace(/dd/g, pad(d.getDate(), 2))
        .replace(/HH/g, pad(d.getHours(), 2))
        .replace(/mm/g, pad(d.getMinutes(), 2))
        .replace(/M/g, d.getMonth() + 1)
        .replace(/d/g, d.getDate())
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ _c: s, setMimeType() { return this; }, getContent() { return this._c; } })
    },
    _state: state
  };

  const ctx = vm.createContext(sandbox);
  // new Date() を基準時刻に固定する
  vm.runInContext(`
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(${FIXED_NOW}); else super(...a); }
      static now() { return ${FIXED_NOW}; }
    }
    Date = FakeDate;
  `, ctx);

  if (process.env.BUNDLE === '1') {
    // 結合版（dist/Code.gs）が src と同じ動きをするか確認する
    const bundle = path.join(__dirname, '..', 'dist', 'Code.gs');
    vm.runInContext(fs.readFileSync(bundle, 'utf8'), ctx, { filename: 'Code.gs' });
  } else {
    ['Parser.gs', 'Config.gs', 'LineClient.gs', 'CalendarService.gs', 'Commands.gs', 'Webhook.gs']
      .forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));
  }

  return { ctx, state, sandbox };
}

/* ------------------------------------------------------------------ *
 * テストユーティリティ
 * ------------------------------------------------------------------ */

const TOKEN = 'test-webhook-token';
let pass = 0;
const failures = [];

function check(label, actual, expected) {
  if (actual === expected) pass++;
  else failures.push(`${label}\n    expected: ${expected}\n    actual:   ${actual}`);
}

function assertTrue(label, cond) { check(label, !!cond, true); }

function setup(props) {
  const env = buildSandbox();
  const base = {
    LINE_CHANNEL_ACCESS_TOKEN: 'dummy-access-token',
    WEBHOOK_TOKEN: TOKEN
  };
  Object.entries(Object.assign(base, props || {}))
    .forEach(([k, v]) => env.state.props.set(k, v));
  return env;
}

let msgSeq = 0;
function textEvent(text, source, eventId) {
  return {
    type: 'message',
    webhookEventId: eventId || 'wh' + (++msgSeq),
    replyToken: 'reply' + msgSeq,
    source: source,
    message: { type: 'text', id: 'm' + msgSeq, text: text }
  };
}

function post(env, events, token) {
  return env.sandbox.doPost({
    parameter: { token: token === undefined ? TOKEN : token },
    postData: { contents: JSON.stringify({ destination: 'U0', events: events }) }
  });
}

const USER = { type: 'user', userId: 'Uuser123' };
const GROUP = { type: 'group', groupId: 'Cgroup456', userId: 'Uuser123' };

const replies = (env) => env.state.sent.map((s) => s.payload.messages
  .map((m) => (m.type === 'template' ? m.template.text : m.text)).join('\n'));

/** 直近に送った確認メッセージのボタン（postback）を取り出す。 */
function lastConfirmActions(env) {
  for (let i = env.state.sent.length - 1; i >= 0; i--) {
    const m = env.state.sent[i].payload.messages[0];
    if (m && m.type === 'template' && m.template.type === 'confirm') return m.template.actions;
  }
  return null;
}

function postPostback(env, data, source) {
  return env.sandbox.doPost({
    parameter: { token: TOKEN },
    postData: {
      contents: JSON.stringify({
        events: [{
          type: 'postback',
          webhookEventId: 'pb' + (++msgSeq),
          replyToken: 'rt' + msgSeq,
          source: source,
          postback: { data: data }
        }]
      })
    }
  });
}
const liveEvents = (env, id) => (env.state.calendars.get(id || 'primary') || { _events: [] })
  ._events.filter((e) => !e.deleted);

/* ------------------------------------------------------------------ *
 * シナリオ
 * ------------------------------------------------------------------ */

// 1. 合言葉が違うリクエストは処理しない
(function () {
  const env = setup();
  post(env, [textEvent('9/15 14:00 打合せ', USER)], 'wrong-token');
  check('不正トークン: 登録されない', liveEvents(env).length, 0);
  check('不正トークン: 返信しない', env.state.sent.length, 0);
})();

// 2. 個人トーク: 予定が登録され、内容が返信される
(function () {
  const env = setup();
  post(env, [textEvent('9/15 14:00 現場打合せ @現場事務所', USER)]);
  const evs = liveEvents(env);
  check('個人: 件数', evs.length, 1);
  check('個人: 件名', evs[0].title, '現場打合せ');
  check('個人: 場所', evs[0].location, '現場事務所');
  check('個人: 開始', evs[0].start.getHours() + ':' + evs[0].start.getMinutes(), '14:0');
  check('個人: 終日でない', evs[0].allDay, false);
  const r = replies(env)[0] || '';
  assertTrue('個人: 返信に日時が入る', r.includes('9/15(火) 14:00-15:00'));
  assertTrue('個人: 返信に件名が入る', r.includes('現場打合せ'));
  assertTrue('個人: 返信に場所が入る', r.includes('現場事務所'));
})();

// 3. 同じ webhookEventId の再送は無視する
(function () {
  const env = setup();
  post(env, [textEvent('9/15 14:00 打合せ', USER, 'dup-1')]);
  post(env, [textEvent('9/15 14:00 打合せ', USER, 'dup-1')]);
  check('再送: 二重登録しない', liveEvents(env).length, 1);
})();

// 4. グループ: 通常の投稿は拾って確認する（押すまで登録しない）
(function () {
  const env = setup();
  post(env, [textEvent('9/15 14:00から現場定例やります', GROUP)]);
  check('確認: この時点では登録しない', liveEvents(env).length, 0);
  const actions = lastConfirmActions(env);
  assertTrue('確認: 確認メッセージを送る', !!actions);
  assertTrue('確認: 内容を提示', (replies(env)[0] || '').includes('9/15(火) 14:00'));
  check('確認: ボタンは2つ', actions.length, 2);
  check('確認: ボタン名', actions.map((a) => a.label).join('/'), '登録/やめる');
  assertTrue('確認: postback data は300バイト以内',
    actions.every((a) => Buffer.byteLength(a.data, 'utf8') <= 300));

  // 「登録」を押す
  postPostback(env, actions[0].data, GROUP);
  check('確認: 押したら登録される', liveEvents(env).length, 1);
  check('確認: 件名', liveEvents(env)[0].title, '現場定例やります');
  assertTrue('確認: 登録完了を返信', (replies(env)[1] || '').includes('登録しました'));

  // 同じボタンをもう一度押しても二重登録しない
  postPostback(env, actions[0].data, GROUP);
  check('確認: 二重登録しない', liveEvents(env).length, 1);
  assertTrue('確認: 期限切れを案内', (replies(env)[2] || '').includes('期限切れ'));
})();

// 4b. 「やめる」を押した場合
(function () {
  const env = setup();
  post(env, [textEvent('明日 10:00 打合せしましょう', GROUP)]);
  const actions = lastConfirmActions(env);
  postPostback(env, actions[1].data, GROUP);
  check('やめる: 登録されない', liveEvents(env).length, 0);
  assertTrue('やめる: 応答', (replies(env)[1] || '').includes('登録しませんでした'));
  // 取り消した確認は「登録」を押しても復活しない
  postPostback(env, actions[0].data, GROUP);
  check('やめる: あとから登録されない', liveEvents(env).length, 0);
})();

// 4c. 確認を出したトーク以外からの応答は受け付けない
(function () {
  const env = setup();
  post(env, [textEvent('9/15 14:00 現場定例', GROUP)]);
  const actions = lastConfirmActions(env);
  postPostback(env, actions[0].data, USER);
  check('別トークからの応答: 登録されない', liveEvents(env).length, 0);
})();

// 4d. 日常会話（確からしさが足りないもの）には反応しない
(function () {
  const env = setup();
  const chatter = [
    '15日分の請求書送りました',
    '10時には着きます',
    '了解です！',
    '3日間ありがとうございました'
  ];
  chatter.forEach((textBody) => post(env, [textEvent(textBody, GROUP)]));
  check('雑談: 登録なし', liveEvents(env).length, 0);
  check('雑談: 返信なし', env.state.sent.length, 0);
})();

// 5. グループ: キーワード付きは確認なしで即登録。カレンダー振り分けも確認
(function () {
  const env = setup({ SOURCE_CALENDAR_MAP: JSON.stringify({ Cgroup456: 'genba@group.calendar.google.com' }) });
  post(env, [textEvent('予定 9/15 14:00 現場打合せ', GROUP)]);
  check('キーワード: 確認を挟まない', liveEvents(env, 'genba@group.calendar.google.com').length, 1);
  check('キーワード: 既定カレンダーには入らない', liveEvents(env, 'primary').length, 0);
  assertTrue('キーワード: 登録完了を返信', (replies(env)[0] || '').includes('登録しました'));
})();

// 5b. CONFIRM_BEFORE_CREATE で個人トークでも確認できる
(function () {
  const env = setup({ CONFIRM_BEFORE_CREATE: 'always' });
  post(env, [textEvent('9/15 14:00 打合せ', USER)]);
  check('always: 押すまで登録しない', liveEvents(env).length, 0);
  const actions = lastConfirmActions(env);
  postPostback(env, actions[0].data, USER);
  check('always: 押したら登録', liveEvents(env).length, 1);
})();

// 5c. GROUP_MIN_CONFIDENCE を下げると日付だけの投稿も拾う
(function () {
  const env = setup({ GROUP_MIN_CONFIDENCE: 'medium' });
  post(env, [textEvent('9/20 安全パトロール', GROUP)]);
  assertTrue('medium: 日付だけでも確認を出す', !!lastConfirmActions(env));
})();

// 6. 取消
(function () {
  const env = setup();
  post(env, [textEvent('9/15 14:00 打合せ', USER)]);
  check('取消前', liveEvents(env).length, 1);
  post(env, [textEvent('取消', USER)]);
  check('取消後', liveEvents(env).length, 0);
  assertTrue('取消: 返信内容', (replies(env)[1] || '').includes('取り消しました'));
  post(env, [textEvent('取消', USER)]);
  assertTrue('取消: 2回目は対象なし', (replies(env)[2] || '').includes('取り消せる登録がありません'));
})();

// 7. 一覧
(function () {
  const env = setup();
  post(env, [textEvent('明日 10:00 配筋検査', USER)]);
  post(env, [textEvent('一覧', USER)]);
  const r = replies(env)[1] || '';
  assertTrue('一覧: 件数表示', r.includes('1件'));
  assertTrue('一覧: 予定名', r.includes('配筋検査'));
})();

// 8. ID / ヘルプ
(function () {
  const env = setup();
  post(env, [textEvent('ID', GROUP)]);
  assertTrue('ID: グループIDを返す', (replies(env)[0] || '').includes('Cgroup456'));
  post(env, [textEvent('ヘルプ', GROUP)]);
  assertTrue('ヘルプ: 確認フローの説明', (replies(env)[1] || '').includes('登録しますか？'));
  assertTrue('ヘルプ: キーワード案内', (replies(env)[1] || '').includes('先頭に「予定」'));
})();

// 9. 許可リスト
(function () {
  const env = setup({ ALLOWED_SOURCE_IDS: 'Cother999' });
  post(env, [textEvent('9/15 14:00 打合せ', USER)]);
  check('許可リスト: 登録されない', liveEvents(env).length, 0);
  assertTrue('許可リスト: 拒否を返信', (replies(env)[0] || '').includes('許可されていません'));
})();

// 10. 複数行
(function () {
  const env = setup();
  post(env, [textEvent('9/15 10:00 配筋検査\n9/16 13:00 コンクリート打設', USER)]);
  const evs = liveEvents(env);
  check('複数行: 件数', evs.length, 2);
  assertTrue('複数行: 返信に件数', (replies(env)[0] || '').includes('2件 登録しました'));
  // 取消は直前の一括登録すべてを対象にする
  post(env, [textEvent('取消', USER)]);
  check('複数行: 一括取消', liveEvents(env).length, 0);
})();

// 11. 解析できないメッセージ（個人トーク）
(function () {
  const env = setup();
  post(env, [textEvent('お疲れ様です！', USER)]);
  check('解析不可: 登録されない', liveEvents(env).length, 0);
  assertTrue('解析不可: 書き方を案内', (replies(env)[0] || '').includes('日付を読み取れませんでした'));
})();

// 12. 終日・複数日
(function () {
  const env = setup();
  post(env, [textEvent('9/15-9/17 出張', USER)]);
  const ev = liveEvents(env)[0];
  check('終日: allDay', ev.allDay, true);
  check('終日: 終了日は排他的(9/18)', ev.end.getDate(), 18);
  assertTrue('終日: 返信表示', (replies(env)[0] || '').includes('9/15(火) 〜 9/17(木) 終日'));
})();

// 13. 友だち追加・グループ招待であいさつする
(function () {
  const env = setup();
  env.sandbox.doPost({
    parameter: { token: TOKEN },
    postData: { contents: JSON.stringify({ events: [{ type: 'follow', webhookEventId: 'f1', replyToken: 'rt', source: USER }] }) }
  });
  assertTrue('follow: 使い方を返す', (replies(env)[0] || '').includes('予定の登録のしかた'));
})();

// 14. 本文なし・壊れた JSON でも 200 を返す
(function () {
  const env = setup();
  const r1 = env.sandbox.doPost({ parameter: { token: TOKEN } });
  check('本文なし: ok', JSON.parse(r1.getContent()).ok, true);
  const r2 = env.sandbox.doPost({ parameter: { token: TOKEN }, postData: { contents: '{壊れた' } });
  check('不正JSON: 200を返す', JSON.parse(r2.getContent()).ok, true);
})();

// 15. 許可リストは招待・友だち追加の時点で効く
(function () {
  const env = setup({ ALLOWED_SOURCE_IDS: 'Cother999' });
  env.sandbox.doPost({
    parameter: { token: TOKEN },
    postData: { contents: JSON.stringify({ events: [{ type: 'join', webhookEventId: 'j1', replyToken: 'rt', source: GROUP }] }) }
  });
  const r = replies(env)[0] || '';
  assertTrue('許可リスト: 招待時に拒否', r.includes('許可されていません'));
  assertTrue('許可リスト: 追加用にIDを返す', r.includes('Cgroup456'));
})();

// 16. 取消の記録はロックを取ってから読み書きする
(function () {
  const env = setup();
  post(env, [textEvent('9/15 14:00 打合せ', USER)]);
  post(env, [textEvent('取消', USER)]);
  check('ロック: 登録と取消で取得', env.state.lockTaken, 2);
  check('ロック: 取得したぶんだけ解放', env.state.lockReleased, env.state.lockTaken);
})();

// 17. Webhook URL の案内
(function () {
  const env = setup();
  check('URL: 足す文字列を返す', env.sandbox.showWebhookUrl(), '?token=' + TOKEN);
  const logged = () => env.state.logs.map((l) => l[1]).join('\n');
  assertTrue('URL: デプロイ画面のURLを使うよう案内', logged().includes('デプロイを管理'));
  assertTrue('URL: 参考URLも出す', logged().includes('https://script.google.com/macros/s/AKfyTEST/exec?token=' + TOKEN));
  assertTrue('URL: テスト用URLの注意を出す', logged().includes('テスト用の URL には LINE から届きません'));

  // 未デプロイ
  const notDeployed = setup();
  notDeployed.state.webAppUrl = null;
  notDeployed.sandbox.showWebhookUrl();
  assertTrue('URL: 未デプロイを案内',
    notDeployed.state.logs.map((l) => l[1]).join('\n').includes('デプロイされていません'));

  const noToken = setup();
  noToken.state.props.delete('WEBHOOK_TOKEN');
  assertTrue('URL: 合言葉未設定を案内', noToken.sandbox.showWebhookUrl().includes('未設定'));
})();

// 18. 設定チェック
(function () {
  const env = setup();
  assertTrue('設定チェック: 正常', env.sandbox.checkConfiguration().includes('設定は正常です'));

  const bad = setup({ GROUP_MIN_CONFIDENCE: 'たかめ' });
  assertTrue('設定チェック: 閾値の誤りを検出',
    bad.sandbox.checkConfiguration().includes('GROUP_MIN_CONFIDENCE'));

  const bad2 = setup({ CONFIRM_BEFORE_CREATE: 'yes' });
  assertTrue('設定チェック: 確認設定の誤りを検出',
    bad2.sandbox.checkConfiguration().includes('CONFIRM_BEFORE_CREATE'));

  const noToken = setup();
  noToken.state.props.delete('LINE_CHANNEL_ACCESS_TOKEN');
  assertTrue('設定チェック: トークン未設定を検出',
    noToken.sandbox.checkConfiguration().includes('LINE_CHANNEL_ACCESS_TOKEN'));
})();

/* ------------------------------------------------------------------ *
 * 結果
 * ------------------------------------------------------------------ */
console.log(`成功: ${pass}  失敗: ${failures.length}`);
if (failures.length) {
  console.log('\n--- 失敗した項目 ---');
  failures.forEach((f) => console.log('  ' + f));
  process.exit(1);
}
console.log('すべて成功しました。');
