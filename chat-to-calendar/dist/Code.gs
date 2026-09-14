/**
 * chat-to-calendar — Google チャットの予定を Google カレンダーに自動登録する
 *
 * ★このファイルは src/*.gs を 1 つにまとめた自動生成ファイルです。
 *   中身を直すときは src/ 側を直して `node chat-to-calendar/tools/bundle.js` を実行してください。
 *
 * 【最初に直すのはここだけ】
 *   すぐ下の CONFIG_BASE の calendarId / spaces / dryRun
 *
 * 【エディタから実行する関数】
 *   checkSetup      … 設定と接続をまとめて点検する（最初にこれ）
 *   listMySpaces    … 参加中のチャットスペース一覧を出す
 *   previewOnly     … 登録せずに「何が拾われるか」だけ見る
 *   installTriggers … 15分ごとの自動実行を開始する
 *   removeTriggers  … 自動実行を止める
 *   resetState      … 読み込み位置をリセットする
 */

// ==========================================================================
// Config.gs
// ==========================================================================

/**
 * Config.gs — 設定。
 *
 * ここを直接書き換えても良いし、スクリプトプロパティ `CONFIG_OVERRIDES` に
 * JSON を入れて上書きすることもできる（コードを触らずに運用で調整したい場合）。
 * 例: {"calendarId":"genba@example.com","requireKeyword":false,"dryRun":true}
 */
var CONFIG_BASE = {
  // ---- 登録先カレンダー -----------------------------------------------------
  /** 'primary' = 実行ユーザーの自分のカレンダー。共有カレンダーの ID も指定可。 */
  calendarId: 'primary',
  timeZone: 'Asia/Tokyo',
  /** 予定のタイトルにつける接頭辞。空文字なら付けない。例: '[Chat] ' */
  eventTitlePrefix: '',
  /** 予定の説明欄に元メッセージと投稿者・リンクを残す */
  addSourceToDescription: true,
  /** 分単位のポップアップ通知。null なら既定のまま */
  reminderMinutes: null,
  /** 予定の色（1〜11、Google Calendar の colorId）。null なら既定色 */
  colorId: null,

  // ---- 取得対象の Google Chat スペース ---------------------------------------
  /**
   * 監視するスペース名の配列。空配列なら「自分が参加している全スペース」。
   * 例: ['spaces/AAAA1111', 'spaces/BBBB2222']
   */
  spaces: [],
  /** 除外するスペース名 */
  excludeSpaces: [],
  /** ダイレクトメッセージも対象にするか */
  includeDirectMessages: false,

  // ---- ポーリング -----------------------------------------------------------
  /** 時間主導トリガーの間隔（分）。1, 5, 10, 15, 30, 60 のいずれか */
  pollIntervalMinutes: 15,
  /** 初回実行時、何分前まで遡って読むか */
  initialLookbackMinutes: 24 * 60,
  /** 1 回の実行で 1 スペースあたり読むメッセージ数の上限 */
  maxMessagesPerSpace: 200,
  /** この表示名の投稿は無視する。例: ['通知Bot', '田中 太郎'] */
  ignoreSenders: [],

  // ---- 予定とみなす条件 -----------------------------------------------------
  /** true: キーワード（下記 keywords）を含むメッセージだけを対象にする */
  requireKeyword: true,
  /** Parser.DEFAULTS.keywords を置き換えたい場合に指定（null なら既定リスト） */
  keywords: null,
  /** 追加キーワード（既定リストに足す） */
  extraKeywords: [],
  /** この語を含むメッセージは無視する（null なら既定リスト） */
  ignoreKeywords: null,
  /** 既定の無視リストに足す語。例: ['日報', '週報'] */
  extraIgnoreKeywords: [],
  /**
   * キーワードをどの範囲で探すか。
   *   'segment' … 日時が書かれている行・文そのものにキーワードが必要（誤検出が少ない・推奨）
   *   'message' … メッセージのどこかにあればよい（拾い漏らしが少ない）
   */
  keywordScope: 'segment',
  /** 日付と時刻の両方がそろっているものだけ登録する（雑談の多いスペース向け） */
  requireDateAndTime: false,
  /** 「〜しました」「先ほど〜」のような報告・過去形の文は登録しない */
  ignorePastReports: true,
  defaultDurationMinutes: 60,
  allDayWhenNoTime: true,
  pmAssumeFrom: 1,
  pmAssumeTo: 5,
  maxEventsPerMessage: 5,
  skipPastMinutes: 120,
  defaultTitle: '打合せ',
  /** 「毎週月曜」などの繰り返し予定を作る。false なら初回の 1 件だけ登録する */
  allowRecurring: true,
  /** 繰り返しを何回分作るか */
  recurrenceCounts: { DAILY: 60, WEEKLY: 26, MONTHLY: 12, YEARLY: 5 },
  /** 同じ時間帯に同名の予定があれば登録しない（別メッセージで同じ予定が流れたとき用） */
  skipIfSimilarEventExists: true,

  // ---- 動作モード -----------------------------------------------------------
  /** true の場合はカレンダーに書き込まず、ログ出力だけ行う */
  dryRun: false,
  /** 予定を登録したら Chat のスレッドに返信して知らせる（ポーリング時） */
  notifyInChat: false,
  /** 登録結果をこのアドレスにメールで通知する。null なら通知しない */
  notifyEmail: null
};

/** スクリプトプロパティの上書きを反映した設定を返す。 */
function getConfig() {
  var cfg = {};
  var k;
  for (k in CONFIG_BASE) if (Object.prototype.hasOwnProperty.call(CONFIG_BASE, k)) cfg[k] = CONFIG_BASE[k];

  var raw = null;
  try {
    raw = PropertiesService.getScriptProperties().getProperty('CONFIG_OVERRIDES');
  } catch (err) {
    raw = null;
  }
  if (raw) {
    var override;
    try {
      override = JSON.parse(raw);
    } catch (err2) {
      throw new Error('スクリプトプロパティ CONFIG_OVERRIDES の JSON が壊れています: ' + err2);
    }
    for (k in override) if (Object.prototype.hasOwnProperty.call(override, k)) cfg[k] = override[k];
  }

  // Parser に渡すキーワード設定を組み立てる
  var keywords = cfg.keywords || Parser.DEFAULTS.keywords;
  if (cfg.extraKeywords && cfg.extraKeywords.length) {
    keywords = keywords.concat(cfg.extraKeywords);
  }
  cfg.keywords = keywords;
  var ignore = cfg.ignoreKeywords || Parser.DEFAULTS.ignoreKeywords;
  if (cfg.extraIgnoreKeywords && cfg.extraIgnoreKeywords.length) {
    ignore = ignore.concat(cfg.extraIgnoreKeywords);
  }
  cfg.ignoreKeywords = ignore;
  return cfg;
}

// ==========================================================================
// Parser.gs
// ==========================================================================

/**
 * Parser.gs
 *
 * Google Chat のメッセージ本文から「予定」（日付・時刻・件名・場所）を抽出する。
 * Apps Script 固有の API を一切使わない純粋な JavaScript なので、
 * Node.js からも読み込んでテストできる（test/run.js 参照）。
 *
 * 対応している書き方の例:
 *   9/20 10:00~12:00 A様邸 定例打合せ
 *   明日10時から現場打ち合わせ
 *   来週火曜 13時半から 施主打合せ @事務所
 *   2026年9月20日(土) 終日 現場清掃
 *   10/1~10/3 出張
 *   20日 9時 搬入
 */
var Parser = (function () {
  'use strict';

  var DAY_MS = 24 * 60 * 60 * 1000;
  var WEEKDAY_INDEX = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
  var RELATIVE_DAYS = {
    '本日': 0, '今日': 0, 'きょう': 0,
    '明日': 1, 'あした': 1, 'あす': 1, '翌日': 1,
    '明後日': 2, 'あさって': 2,
    '明々後日': 3, 'しあさって': 3
  };

  /** パーサー既定値。Config.gs から上書きされる。 */
  var DEFAULTS = {
    // 予定とみなすために本文へ含まれている必要のあるキーワード（requireKeyword=false なら不要）
    requireKeyword: true,
    keywords: [
      '打合せ', '打ち合わせ', '打合わせ', '打合', 'ミーティング', 'MTG', 'mtg', '会議', '定例',
      '現場', '現調', '現地調査', '検査', '立会', '立ち会い', '立会い', '点検', 'パトロール',
      '納品', '搬入', '搬出', '着工', '上棟', '引渡', '引き渡し', '竣工', '工事', '作業', '段取り',
      '見積', '契約', '訪問', '来社', '来店', '面談', '商談', '説明会', '打診',
      '集合', '出発', '出張', '研修', '講習', '朝礼', 'アポ', '予定', '施主', '確認会'
    ],
    // これらが含まれる行は予定として登録しない
    ignoreKeywords: ['中止', 'キャンセル', '延期', 'リスケ', '欠席', '見送り'],
    /**
     * キーワードをどの範囲で探すか。
     *   'segment' … 日時が書かれている行・文そのものにキーワードが必要（誤検出が少ない）
     *   'message' … メッセージのどこかにあればよい（拾い漏らしが少ない）
     */
    keywordScope: 'segment',
    /** 日付と時刻の両方がそろっているものだけ登録する（さらに厳しくしたいとき） */
    requireDateAndTime: false,
    /** 「〜しました」「先ほど〜」のような報告・過去形の文は予定として扱わない */
    ignorePastReports: true,
    defaultDurationMinutes: 60,
    allDayWhenNoTime: true,
    // 「3時」のように午前/午後の指定が無い場合、この範囲の時刻は午後とみなす（現場は早朝開始が多いので既定は 1〜5 時）
    pmAssumeFrom: 1,
    pmAssumeTo: 5,
    maxEventsPerMessage: 5,
    // 基準時刻より前に終わってしまう予定は登録しない（分）。all-day は日付単位で判定。
    skipPastMinutes: 120,
    // 基準日からこの日数より先の予定は誤検出とみなして捨てる
    maxFutureDays: 400,
    defaultTitle: '打合せ',
    maxTitleLength: 100,
    // 繰り返し予定を何回分まで作るか（無限に増やさないための上限）
    recurrenceCounts: { DAILY: 60, WEEKLY: 26, MONTHLY: 12, YEARLY: 5 }
  };

  // ---------------------------------------------------------------- utilities

  function extend(base, override) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (override) {
      for (k in override) if (Object.prototype.hasOwnProperty.call(override, k)) {
        if (override[k] !== undefined && override[k] !== null) out[k] = override[k];
      }
    }
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function repeatSpace(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ' ';
    return s;
  }

  function makeDate(y, m, d) {
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  /** 全角→半角、記号ゆれの正規化。 */
  function toHalfWidth(s) {
    return s.replace(/[！-～]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
  }

  function normalize(text) {
    if (text === null || text === undefined) return '';
    var s = String(text);
    s = s.replace(/\r\n?/g, '\n');
    s = toHalfWidth(s);
    s = s.replace(/　/g, ' ');
    s = s.replace(/[〜⁓∼]/g, '~');                     // 〜 ⁓ ∼
    s = s.replace(/[‐‑‒–—―−]/g, '-'); // ‐ – — −
    s = s.replace(/(\d)\s*ー\s*(\d)/g, '$1-$2');                 // 10ー12（長音記号）
    s = s.replace(/[ \t]+/g, ' ');
    return s;
  }

  // ------------------------------------------------------------- date parsing

  function inferYear(month, day, base) {
    var b = startOfDay(base);
    var cand = makeDate(b.getFullYear(), month, day);
    if (!cand) return null;
    var diffDays = (cand.getTime() - b.getTime()) / DAY_MS;
    if (diffDays < -180) return makeDate(b.getFullYear() + 1, month, day);
    if (diffDays > 300) return makeDate(b.getFullYear() - 1, month, day);
    return cand;
  }

  function resolveWeekday(prefix, weekdayChar, base) {
    var target = WEEKDAY_INDEX[weekdayChar];
    if (target === undefined) return null;
    var b = startOfDay(base);
    if (prefix) {
      var weeks = (prefix === '再来週') ? 2 : (prefix === '今週' ? 0 : 1);
      var mondayOffset = (b.getDay() + 6) % 7;          // 月曜起点の曜日インデックス
      var monday = addDays(b, -mondayOffset + 7 * weeks);
      return addDays(monday, (target + 6) % 7);
    }
    var diff = (target - b.getDay() + 7) % 7;
    if (diff === 0) diff = 7;                            // 「月曜」単独は次の月曜
    return addDays(b, diff);
  }

  function resolveDayOnly(day, base) {
    var b = startOfDay(base);
    var cand = makeDate(b.getFullYear(), b.getMonth() + 1, day);
    if (cand && cand.getTime() >= b.getTime()) return cand;
    var next = new Date(b.getFullYear(), b.getMonth() + 1, 1);
    return makeDate(next.getFullYear(), next.getMonth() + 1, day);
  }

  // 上から順に適用し、マッチした部分は以降のルールから隠す（マスクする）。
  var DATE_RULES = [
    { // 2026/9/20, 2026-09-20, 2026年9月20日
      re: /(\d{4})\s*[\/\-年]\s*(\d{1,2})\s*[\/\-月]\s*(\d{1,2})\s*日?/g,
      resolve: function (m) { return makeDate(+m[1], +m[2], +m[3]); }
    },
    { // 9/20, 9月20日
      re: /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g,
      resolve: function (m, base) { return inferYear(+m[1], +m[2], base); }
    },
    { // 明日 / 明後日 / 本日 …
      re: /(本日|今日|きょう|明日|あした|あす|翌日|明後日|あさって|明々後日|しあさって)/g,
      resolve: function (m, base) { return addDays(base, RELATIVE_DAYS[m[1]]); }
    },
    { // 来週火曜 / 今週の金曜日 / 月曜
      re: /(今週|来週|再来週|次週)?\s*(?:の)?\s*([日月火水木金土])曜日?/g,
      resolve: function (m, base) {
        var prefix = m[1] === '次週' ? '来週' : m[1];
        return resolveWeekday(prefix, m[2], base);
      }
    },
    { // 20日（単独）
      re: /(\d{1,2})\s*日(?!間|後|以内|程|中|数)/g,
      resolve: function (m, base) { return resolveDayOnly(+m[1], base); }
    }
  ];

  // ------------------------------------------------------------- time parsing

  var AM_MARKERS = /^(午前|朝|am|AM|Am)$/;
  var PM_MARKERS = /^(午後|夕方|夜|pm|PM|Pm)$/;

  var TIME_RULES = [
    { // 10:30 / 午後 3:00
      re: /(午前|午後|朝|夕方|夜|[aApP][mM])?\s*(\d{1,2})\s*:\s*([0-5]\d)/g,
      build: function (m) { return { marker: m[1], hour: +m[2], minute: +m[3] }; }
    },
    { // 10時 / 10時半 / 10時30分 / 午後3時
      re: /(午前|午後|朝|夕方|夜|[aApP][mM])?\s*(\d{1,2})\s*時(?!間)\s*(半|[0-5]?\d\s*分)?/g,
      build: function (m) {
        var minute = 0;
        if (m[3] === '半') minute = 30;
        else if (m[3]) minute = parseInt(m[3].replace(/[^\d]/g, ''), 10) || 0;
        return { marker: m[1], hour: +m[2], minute: minute };
      }
    },
    { // 正午
      re: /(正午)/g,
      build: function () { return { marker: null, hour: 12, minute: 0 }; }
    },
    { // 数字が無いときの目安（朝イチ・午後イチ・午前中 など）
      re: /(朝イチ|朝一|午前中|午後イチ|午後一|昼イチ|昼一|夕方|夜間|夜)/g,
      build: function (m) {
        switch (m[1]) {
          case '朝イチ': case '朝一': return { marker: '午前', hour: 8, minute: 0 };
          case '午前中': return { marker: '午前', hour: 9, minute: 0, durationMinutes: 180 };
          case '午後イチ': case '午後一': case '昼イチ': case '昼一': return { marker: '午後', hour: 13, minute: 0 };
          case '夕方': return { marker: '午後', hour: 17, minute: 0 };
          case '夜': case '夜間': return { marker: '午後', hour: 19, minute: 0 };
        }
        return null;
      }
    }
  ];

  // 繰り返し。曜日や日付は後段の DATE_RULES に残すため、この語だけを取り除く。
  var WEEKDAY_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  var RECURRENCE_RULES = [
    { re: /隔週/, freq: 'WEEKLY', interval: 2 },
    { re: /毎週|週次/, freq: 'WEEKLY', interval: 1 },
    { re: /毎月|月次/, freq: 'MONTHLY', interval: 1 },
    { re: /毎日/, freq: 'DAILY', interval: 1 },
    { re: /毎年/, freq: 'YEARLY', interval: 1 },
    { re: /平日/, freq: 'WEEKLY', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }
  ];

  function applyMeridiem(t, cfg) {
    var hour = t.hour;
    if (t.marker && PM_MARKERS.test(t.marker)) {
      if (hour < 12) hour += 12;
    } else if (t.marker && AM_MARKERS.test(t.marker)) {
      if (hour === 12) hour = 0;
    } else if (hour >= cfg.pmAssumeFrom && hour <= cfg.pmAssumeTo) {
      hour += 12;                                        // 「3時」→ 15:00
    }
    if (hour > 23 || hour < 0) return null;
    return { hour: hour, minute: t.minute, explicit: !!t.marker, durationMinutes: t.durationMinutes || null };
  }

  var RANGE_SEPARATOR = /^\s*(?:~|-|から|より|→|>|to|まで)\s*(?:まで)?\s*$/;

  // ------------------------------------------------------------------ helpers

  function collectMatches(work, rules, base) {
    var results = [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      rule.re.lastIndex = 0;
      var found = [];
      var m;
      while ((m = rule.re.exec(work)) !== null) {
        if (!m[0] || m[0].length === 0) { rule.re.lastIndex++; continue; }
        found.push({ index: m.index, end: m.index + m[0].length, match: m, rule: rule });
      }
      for (var j = 0; j < found.length; j++) {
        var item = found[j];
        var value = rule.resolve ? rule.resolve(item.match, base) : rule.build(item.match, base);
        if (value) results.push({ index: item.index, end: item.end, value: value, text: item.match[0] });
      }
      // このルールでマッチした範囲は以降のルールから隠す
      for (var k = 0; k < found.length; k++) {
        work = work.substring(0, found[k].index) + repeatSpace(found[k].end - found[k].index) + work.substring(found[k].end);
      }
    }
    results.sort(function (a, b) { return a.index - b.index; });
    return { matches: results, work: work };
  }

  function stripSpans(text, spans) {
    if (!spans.length) return text;
    var sorted = spans.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = '';
    var cursor = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i][0] > cursor) out += text.substring(cursor, sorted[i][0]);
      cursor = Math.max(cursor, sorted[i][1]);
    }
    out += text.substring(cursor);
    return out;
  }

  function cleanTitle(text, cfg) {
    var t = text;
    t = t.replace(/[（(]\s*[日月火水木金土]\s*[)）]/g, ' ');    // 残った (土)
    t = t.replace(/\s+/g, ' ');
    // 前後に残った助詞・記号を剥がす（「から現場打合せ」→「現場打合せ」）
    for (var i = 0; i < 8; i++) {
      var before = t;
      t = t.replace(/^[\s、。,.\-~:：\/|・*＊>＞\]\)】」]+/, '');
      t = t.replace(/^(から|まで|より|ごろ|頃|くらい|位|に|は|で|を|の|、)/, '');
      t = t.replace(/[\s、。,.\-~:：\/|・]+$/, '');
      t = t.replace(/(から|まで|より|ごろ|頃|くらい|位|には|に|は|が|を|へ)$/, '');
      // 末尾の定型句（「〜お願いします」「〜です」）を落とす
      t = t.replace(/[\s、]*(?:宜しく|よろしく)?お願い(?:いた)?します[。!！]*$/, '');
      t = t.replace(/(?:です|でした|ですね)[。!！]*$/, '');
      if (t === before) break;
    }
    t = t.replace(/^(予定|件名)[:：]?\s*/, '');
    t = t.trim();
    if (t.length > cfg.maxTitleLength) t = t.substring(0, cfg.maxTitleLength) + '…';
    return t;
  }

  function extractLocation(text) {
    var m = /(?:場所|会場|集合場所)\s*[:：]\s*([^\s、。]+)/.exec(text);
    if (m) return { value: m[1], span: [m.index, m.index + m[0].length] };
    m = /(?:^|\s)@([^\s、。]+)/.exec(text);
    if (m) {
      var offset = m[0].indexOf('@');
      return { value: m[1], span: [m.index + offset, m.index + m[0].length] };
    }
    return null;
  }

  // 「〜しました」「〜ておりました」のような報告文。予定ではなく実績なので登録しない。
  // 「9/25に変更になりました」のような予定変更の連絡は残したいので「なりました」は含めない。
  var PAST_REPORT_RE = /(?:しました|されました|できました|いたしました|ておりました|ていました|でした|済みです|完了です)\s*[。．.!！)）」]*$/;
  var PAST_MARKER_RE = /(先ほど|さきほど|先程|昨日|一昨日|過日)/;

  function isPastReport(text) {
    var t = String(text).trim();
    return PAST_REPORT_RE.test(t) || PAST_MARKER_RE.test(t);
  }

  function hasAny(text, words) {
    for (var i = 0; i < words.length; i++) {
      if (words[i] && text.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  /** 予定全体を n 日ずらす（繰り返しの開始日合わせ用）。 */
  function shiftEventByDays(event, n) {
    event.start = new Date(event.start.getTime() + n * DAY_MS);
    event.end = new Date(event.end.getTime() + n * DAY_MS);
    if (event.allDay) {
      event.startDate = ymd(event.start);
      event.endDateExclusive = ymd(event.end);
    }
  }

  // -------------------------------------------------------------- main parsing

  /**
   * 1 行を解析して予定候補を返す。予定として読めなければ null。
   * @param {string} line       正規化済みの 1 行
   * @param {Date}   base       相対日付（明日など）の基準となる日時 = メッセージ投稿日時
   * @param {Object} cfg        設定
   */
  function parseLine(line, base, cfg) {
    cfg = extend(DEFAULTS, cfg);
    var norm = line;
    if (!norm || !norm.trim()) return null;

    var work = norm;
    var spans = [];
    function consume(start, end) {
      if (end <= start) return;
      spans.push([start, end]);
      work = work.substring(0, start) + repeatSpace(end - start) + work.substring(end);
    }

    // 終日指定
    var allDay = false;
    var allDayMatch = /終日|一日中|1日中/.exec(work);
    if (allDayMatch) {
      allDay = true;
      consume(allDayMatch.index, allDayMatch.index + allDayMatch[0].length);
    }

    // 繰り返し（「毎週月曜」の「毎週」だけを取り除き、「月曜」は日付として解釈させる）
    var recurrence = null;
    for (var ri = 0; ri < RECURRENCE_RULES.length; ri++) {
      var rr = RECURRENCE_RULES[ri];
      var rm = rr.re.exec(work);
      if (rm) {
        recurrence = { freq: rr.freq, interval: rr.interval, byDay: rr.byDay ? rr.byDay.slice() : null };
        consume(rm.index, rm.index + rm[0].length);
        break;
      }
    }

    // 場所
    var location = null;
    var loc = extractLocation(work);
    if (loc) {
      location = loc.value;
      consume(loc.span[0], loc.span[1]);
    }

    // 日付
    var dateResult = collectMatches(work, DATE_RULES, base);
    var dates = dateResult.matches;
    for (var i = 0; i < dates.length; i++) consume(dates[i].index, dates[i].end);

    // 時刻（日付を隠した後の文字列に対して）
    var timeResult = collectMatches(work, TIME_RULES, base);
    var times = timeResult.matches;

    if (!dates.length && !times.length) return null;

    // 日付の範囲指定（10/1~10/3）
    var startDate = dates.length ? dates[0].value : startOfDay(base);
    var endDate = null;
    if (dates.length >= 2) {
      var betweenDates = work.substring(dates[0].end, dates[1].index);
      if (RANGE_SEPARATOR.test(betweenDates) && betweenDates.trim() !== '') {
        endDate = dates[1].value;
        consume(dates[0].end, dates[1].index);   // 「~」が件名に残らないようにする
      }
    }

    // 時刻の範囲指定（10:00~12:00 / 10時から12時）
    var startTime = null;
    var endTime = null;
    var durationMinutes = null;
    if (times.length) {
      startTime = applyMeridiem(times[0].value, cfg);
      if (times.length >= 2) {
        var betweenTimes = work.substring(times[0].end, times[1].index);
        if (RANGE_SEPARATOR.test(betweenTimes)) {
          endTime = applyMeridiem(times[1].value, cfg);
          consume(times[1].index, times[1].end);
          consume(times[0].end, times[1].index);
        }
      }
      // 「10時から30分」「10:00から1時間」のような所要時間
      if (!endTime) {
        var tail = work.substring(times[0].end, times[0].end + 12);
        var dm = /^\s*(?:から|~|-|、|で)?\s*(\d{1,3})\s*(分|時間)/.exec(tail);
        if (dm) {
          durationMinutes = (+dm[1]) * (dm[2] === '時間' ? 60 : 1);
          consume(times[0].end + dm.index, times[0].end + dm.index + dm[0].length);
        }
      }
      consume(times[0].index, times[0].end);
      if (!startTime) return null;
    }

    if (allDay) { startTime = null; endTime = null; }

    var event = { allDay: false, location: location || null };

    if (startTime) {
      var s = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), startTime.hour, startTime.minute);
      var e;
      if (endTime) {
        var endBase = endDate || startDate;
        e = new Date(endBase.getFullYear(), endBase.getMonth(), endBase.getDate(), endTime.hour, endTime.minute);
        if (e.getTime() <= s.getTime()) e = new Date(e.getTime() + 12 * 60 * 60 * 1000);   // 10時~1時
        if (e.getTime() <= s.getTime()) e = new Date(e.getTime() + 12 * 60 * 60 * 1000);   // 日跨ぎ
      } else {
        var minutes = durationMinutes || startTime.durationMinutes || cfg.defaultDurationMinutes;
        e = new Date(s.getTime() + minutes * 60 * 1000);
      }
      event.start = s;
      event.end = e;
    } else {
      if (!dates.length) return null;                    // 時刻も日付も無い
      if (!cfg.allDayWhenNoTime) return null;
      event.allDay = true;
      event.startDate = ymd(startDate);
      event.endDateExclusive = ymd(addDays(endDate || startDate, 1));
      event.start = startDate;
      event.end = addDays(endDate || startDate, 1);
    }

    if (recurrence) {
      // 曜日指定（平日など）に合わない開始日なら、最初に該当する日まで進める
      if (recurrence.byDay && recurrence.byDay.length) {
        for (var g = 0; g < 7 && recurrence.byDay.indexOf(WEEKDAY_CODE[event.start.getDay()]) === -1; g++) {
          shiftEventByDays(event, 1);
        }
      } else if (recurrence.freq === 'WEEKLY') {
        recurrence.byDay = [WEEKDAY_CODE[event.start.getDay()]];
      }
      if (recurrence.freq === 'MONTHLY') recurrence.byMonthDay = event.start.getDate();
      recurrence.count = (cfg.recurrenceCounts && cfg.recurrenceCounts[recurrence.freq]) || 26;
      event.recurrence = recurrence;
    }

    // 未来すぎる / 過ぎた予定は捨てる
    var horizon = addDays(startOfDay(base), cfg.maxFutureDays);
    if (event.start.getTime() > horizon.getTime()) return null;
    if (event.allDay) {
      if (event.end.getTime() <= startOfDay(base).getTime()) return null;
    } else if (event.end.getTime() < base.getTime() - cfg.skipPastMinutes * 60 * 1000) {
      return null;
    }

    var title = cleanTitle(stripSpans(norm, spans), cfg);
    event.title = title;
    event.rawLine = norm.trim();
    event.hasDate = dates.length > 0;
    event.hasTime = !!startTime;
    event.score = (event.hasDate ? 2 : 0) + (event.hasTime ? 2 : 0) + (title ? 1 : 0);
    return event;
  }

  /**
   * メッセージ全体を解析して予定候補の配列を返す。
   * @param {string} text    メッセージ本文
   * @param {Date}   base    メッセージの投稿日時（相対日付の基準）
   * @param {Object} cfg     設定
   * @return {{events: Array, skipped: string}}
   */
  function parseMessage(text, base, cfg) {
    cfg = extend(DEFAULTS, cfg);
    base = base || new Date();
    var norm = normalize(text);
    if (!norm.trim()) return { events: [], skipped: 'empty' };

    if (!cfg.explicit && hasAny(norm, cfg.ignoreKeywords)) return { events: [], skipped: 'ignoreKeyword' };

    // キーワード判定をメッセージ全体で行うモードのときだけ、ここで一度に判定する
    var messageHasKeyword = !cfg.requireKeyword || cfg.explicit ||
      (cfg.keywordScope === 'message' && hasAny(norm, cfg.keywords));

    // 行に加えて「。」でも区切る（「3時間かかります。明日 搬入します」→ 件名を「搬入します」にするため）
    var lines = [];
    norm.split('\n').forEach(function (line) {
      var parts = line.indexOf('。') === -1 ? [line] : line.split('。');
      parts.forEach(function (part) { if (part.trim()) lines.push(part); });
    });
    var events = [];
    var seen = {};
    var skipReason = null;
    for (var i = 0; i < lines.length; i++) {
      if (!cfg.explicit && cfg.ignorePastReports && isPastReport(lines[i])) {
        skipReason = skipReason || 'pastReport';
        continue;
      }
      var ev = parseLine(lines[i], base, cfg);
      if (!ev) continue;
      if (!messageHasKeyword && !hasAny(lines[i], cfg.keywords)) {
        skipReason = skipReason || 'noKeyword';
        continue;
      }
      if (cfg.requireDateAndTime && !(ev.hasDate && ev.hasTime)) {
        skipReason = skipReason || 'needDateAndTime';
        continue;
      }
      if (!ev.title) ev.title = cfg.defaultTitle;
      var key = ev.title + '@' + ev.start.getTime() + '@' + ev.end.getTime();
      if (seen[key]) continue;
      seen[key] = true;
      events.push(ev);
      if (events.length >= cfg.maxEventsPerMessage) break;
    }
    if (!events.length) return { events: [], skipped: skipReason || 'noSchedule' };
    return { events: events, skipped: null };
  }

  /** ログ用の 1 行表現。 */
  var FREQ_LABEL = { DAILY: '毎日', WEEKLY: '毎週', MONTHLY: '毎月', YEARLY: '毎年' };

  function recurrenceLabel(ev) {
    if (!ev.recurrence) return '';
    var label = FREQ_LABEL[ev.recurrence.freq] || '繰り返し';
    if (ev.recurrence.interval === 2 && ev.recurrence.freq === 'WEEKLY') label = '隔週';
    return ' [' + label + '×' + ev.recurrence.count + ']';
  }

  function describe(ev) {
    if (ev.allDay) {
      return '[終日] ' + ev.startDate + (ev.endDateExclusive ? ' ~ ' + ev.endDateExclusive : '') +
        ' ' + ev.title + recurrenceLabel(ev);
    }
    return ymd(ev.start) + ' ' + pad2(ev.start.getHours()) + ':' + pad2(ev.start.getMinutes()) +
      '-' + pad2(ev.end.getHours()) + ':' + pad2(ev.end.getMinutes()) + ' ' + ev.title +
      (ev.location ? ' @' + ev.location : '') + recurrenceLabel(ev);
  }

  return {
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    parseLine: parseLine,
    parseMessage: parseMessage,
    describe: describe,
    ymd: ymd
  };
})();

// Node.js からテストするためのエクスポート（Apps Script 上では無視される）
if (typeof module !== 'undefined' && module.exports) { module.exports = Parser; }

// ==========================================================================
// Store.gs
// ==========================================================================

/**
 * Store.gs — 実行状態の保存（スクリプトプロパティ）。
 *
 * - スペースごとの「どこまで読んだか」(createTime のカーソル)
 * - 処理済みメッセージ ID（二重登録の防止。カレンダー側の extendedProperties と二段構え）
 */
var Store = (function () {
  'use strict';

  var CURSOR_PREFIX = 'cursor:';
  var PROCESSED_KEY = 'processedMessages';
  var PROCESSED_MAX = 1500;
  var PROCESSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function props() { return PropertiesService.getScriptProperties(); }

  function getCursor(spaceName) {
    return props().getProperty(CURSOR_PREFIX + spaceName) || null;
  }

  function setCursor(spaceName, rfc3339) {
    if (!rfc3339) return;
    props().setProperty(CURSOR_PREFIX + spaceName, rfc3339);
  }

  function loadProcessed() {
    var raw = props().getProperty(PROCESSED_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch (err) {
      return {};
    }
  }

  function saveProcessed(map) {
    var keys = Object.keys(map);
    var now = Date.now();
    // 古いものを捨てる
    var kept = keys.filter(function (k) { return now - map[k] < PROCESSED_TTL_MS; });
    if (kept.length > PROCESSED_MAX) {
      kept.sort(function (a, b) { return map[b] - map[a]; });
      kept = kept.slice(0, PROCESSED_MAX);
    }
    var out = {};
    kept.forEach(function (k) { out[k] = map[k]; });
    props().setProperty(PROCESSED_KEY, JSON.stringify(out));
  }

  function isProcessed(messageName) {
    return Object.prototype.hasOwnProperty.call(loadProcessed(), messageName);
  }

  function markProcessed(messageNames) {
    if (!messageNames || !messageNames.length) return;
    var map = loadProcessed();
    var now = Date.now();
    messageNames.forEach(function (name) { map[name] = now; });
    saveProcessed(map);
  }

  /** 状態を全部消す（再取り込みしたいとき用） */
  function reset() {
    var all = props().getProperties();
    var toDelete = Object.keys(all).filter(function (k) {
      return k.indexOf(CURSOR_PREFIX) === 0 || k === PROCESSED_KEY;
    });
    toDelete.forEach(function (k) { props().deleteProperty(k); });
    return toDelete.length;
  }

  return {
    getCursor: getCursor,
    setCursor: setCursor,
    isProcessed: isProcessed,
    markProcessed: markProcessed,
    reset: reset
  };
})();

// ==========================================================================
// ChatSource.gs
// ==========================================================================

/**
 * ChatSource.gs — Google Chat からメッセージを読む / スペースに返信する。
 *
 * Apps Script の拡張サービス「Chat API」(識別子 Chat) が有効ならそれを使い、
 * 無効な場合は UrlFetchApp で REST API を直接叩く。どちらでも動くようにしてある。
 */
var ChatSource = (function () {
  'use strict';

  var BASE_URL = 'https://chat.googleapis.com/v1/';

  function advancedServiceAvailable() {
    return (typeof Chat !== 'undefined') && Chat && Chat.Spaces;
  }

  function restCall(path, params, method, payload) {
    var url = BASE_URL + path;
    var query = [];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] === undefined || params[k] === null || params[k] === '') return;
        query.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      });
    }
    if (query.length) url += '?' + query.join('&');

    var options = {
      method: method || 'get',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    };
    if (payload) {
      options.contentType = 'application/json; charset=utf-8';
      options.payload = JSON.stringify(payload);
    }
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var body = res.getContentText();
    if (code >= 300) {
      throw new Error('Chat API エラー (' + code + '): ' + body);
    }
    return body ? JSON.parse(body) : {};
  }

  /** 自分が参加しているスペースの一覧。 */
  function listSpaces(cfg) {
    var spaces = [];
    var pageToken = null;
    var filter = cfg.includeDirectMessages ? '' : 'spaceType = "SPACE"';
    do {
      var params = { pageSize: 100 };
      if (pageToken) params.pageToken = pageToken;
      if (filter) params.filter = filter;
      var res;
      if (advancedServiceAvailable()) {
        res = Chat.Spaces.list(params);
      } else {
        res = restCall('spaces', params);
      }
      (res.spaces || []).forEach(function (s) { spaces.push(s); });
      pageToken = res.nextPageToken;
    } while (pageToken);
    return spaces;
  }

  /** 設定に従って監視対象のスペース名を決める。 */
  function resolveTargetSpaces(cfg) {
    var names;
    if (cfg.spaces && cfg.spaces.length) {
      names = cfg.spaces.slice();
    } else {
      names = listSpaces(cfg).map(function (s) { return s.name; });
    }
    if (cfg.excludeSpaces && cfg.excludeSpaces.length) {
      names = names.filter(function (n) { return cfg.excludeSpaces.indexOf(n) === -1; });
    }
    return names;
  }

  /**
   * 指定スペースの、cursor（RFC3339）より後のメッセージを古い順に返す。
   */
  function listMessagesSince(spaceName, cursorRfc3339, cfg) {
    var messages = [];
    var pageToken = null;
    var filter = cursorRfc3339 ? 'createTime > "' + cursorRfc3339 + '"' : '';
    do {
      var params = { pageSize: 100, orderBy: 'createTime asc', showDeleted: false };
      if (pageToken) params.pageToken = pageToken;
      if (filter) params.filter = filter;
      var res;
      if (advancedServiceAvailable()) {
        res = Chat.Spaces.Messages.list(spaceName, params);
      } else {
        res = restCall(spaceName + '/messages', params);
      }
      (res.messages || []).forEach(function (m) { messages.push(m); });
      pageToken = res.nextPageToken;
    } while (pageToken && messages.length < cfg.maxMessagesPerSpace);

    if (messages.length > cfg.maxMessagesPerSpace) {
      messages = messages.slice(0, cfg.maxMessagesPerSpace);
    }
    return messages;
  }

  /** スペース（スレッド）にメッセージを投稿する。 */
  function postMessage(spaceName, text, threadName) {
    var payload = { text: text };
    var params = {};
    if (threadName) {
      payload.thread = { name: threadName };
      params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
    }
    if (advancedServiceAvailable()) {
      return Chat.Spaces.Messages.create(payload, spaceName, params);
    }
    return restCall(spaceName + '/messages', params, 'post', payload);
  }

  /** spaces/AAA/messages/BBB → Chat のメッセージへのリンク */
  function buildPermalink(messageName) {
    if (!messageName) return null;
    var m = /^spaces\/([^\/]+)\/messages\/(.+)$/.exec(messageName);
    if (!m) return null;
    return 'https://chat.google.com/room/' + m[1] + '/' + m[2];
  }

  /**
   * メッセージ本文。@メンション（Bot・人ともに）は取り除く。
   * 「@事務所」のような場所指定は annotations に含まれないので残る。
   */
  function messageText(message) {
    if (!message) return '';
    var text = message.text || message.argumentText || '';
    var annotations = message.annotations || [];
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      if (a.type !== 'USER_MENTION' || !a.userMention || !a.userMention.user) continue;
      var displayName = a.userMention.user.displayName;
      if (!displayName) continue;
      text = text.split('@' + displayName).join(' ');
    }
    if (!text.trim() && message.argumentText) text = message.argumentText;
    return text.trim();
  }

  return {
    listSpaces: listSpaces,
    resolveTargetSpaces: resolveTargetSpaces,
    listMessagesSince: listMessagesSince,
    postMessage: postMessage,
    buildPermalink: buildPermalink,
    messageText: messageText
  };
})();

// ==========================================================================
// CalendarSync.gs
// ==========================================================================

/**
 * CalendarSync.gs — 抽出した予定を Google カレンダーに登録する。
 *
 * 拡張サービス「Calendar API」(識別子 Calendar) を使う。
 * 二重登録を防ぐため、作成した予定には extendedProperties.private.chatMessage として
 * 元メッセージの ID を埋め込み、登録前に同じ ID の予定が無いか検索する。
 */
var CalendarSync = (function () {
  'use strict';

  var SOURCE_TAG = 'chat-to-calendar';

  function requireCalendarService() {
    if (typeof Calendar === 'undefined' || !Calendar || !Calendar.Events) {
      throw new Error('拡張サービス「Calendar API」が有効になっていません。'
        + 'Apps Script エディタの「サービス」から Calendar API (v3) を追加してください。');
    }
  }

  function rfc3339(date, timeZone) {
    return Utilities.formatDate(date, timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }

  /** すでに同じメッセージから作った予定があるか */
  function findExisting(cfg, messageName) {
    requireCalendarService();
    var res = Calendar.Events.list(cfg.calendarId, {
      privateExtendedProperty: 'chatMessage=' + messageName,
      maxResults: 5,
      showDeleted: false
    });
    return (res.items && res.items.length) ? res.items[0] : null;
  }

  /** Parser の recurrence を Calendar API の RRULE に変換する。 */
  function buildRecurrence(event, cfg) {
    if (!event.recurrence || cfg.allowRecurring === false) return null;
    var r = event.recurrence;
    var parts = ['FREQ=' + r.freq];
    if (r.interval && r.interval > 1) parts.push('INTERVAL=' + r.interval);
    if (r.byDay && r.byDay.length) parts.push('BYDAY=' + r.byDay.join(','));
    if (r.byMonthDay) parts.push('BYMONTHDAY=' + r.byMonthDay);
    if (r.count) parts.push('COUNT=' + r.count);
    return ['RRULE:' + parts.join(';')];
  }

  /**
   * 同じ時間帯に同じ件名の予定がすでにあるか（別のメッセージで同じ予定が二度流れた場合の保険）。
   */
  function findSimilarEvent(cfg, event, summary) {
    var res = Calendar.Events.list(cfg.calendarId, {
      timeMin: rfc3339(new Date(event.start.getTime() - 60 * 1000), cfg.timeZone),
      timeMax: rfc3339(new Date(event.end.getTime() + 60 * 1000), cfg.timeZone),
      singleEvents: true,
      maxResults: 50,
      showDeleted: false
    });
    var items = res.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].summary !== summary) continue;
      var start = items[i].start || {};
      if (event.allDay) {
        if (start.date === event.startDate) return items[i];
      } else if (start.dateTime) {
        var existing = new Date(start.dateTime);
        if (Math.abs(existing.getTime() - event.start.getTime()) < 60 * 1000) return items[i];
      }
    }
    return null;
  }

  function buildDescription(cfg, ctx) {
    if (!cfg.addSourceToDescription) return undefined;
    var lines = [];
    if (ctx.messageText) lines.push(ctx.messageText);
    lines.push('');
    lines.push('--- Google Chat から自動登録 ---');
    if (ctx.senderName) lines.push('投稿者: ' + ctx.senderName);
    if (ctx.spaceDisplayName) lines.push('スペース: ' + ctx.spaceDisplayName);
    if (ctx.permalink) lines.push('元メッセージ: ' + ctx.permalink);
    return lines.join('\n');
  }

  /**
   * 予定を 1 件登録する。すでに登録済みなら null を返す。
   * @param {Object} event Parser が返した予定
   * @param {Object} ctx   {messageName, messageText, senderName, spaceName, spaceDisplayName, permalink}
   * @param {Object} cfg   設定
   */
  function createEvent(event, ctx, cfg) {
    if (!cfg.dryRun) requireCalendarService();

    if (!cfg.dryRun && ctx.messageName) {
      var existing = findExisting(cfg, ctx.messageName);
      if (existing) {
        // 同じメッセージから複数の予定を作る場合があるので、件名と開始が一致するものだけ重複扱いにする
        var sameTitle = existing.summary === (cfg.eventTitlePrefix || '') + event.title;
        if (sameTitle) return null;
      }
    }

    var summary = (cfg.eventTitlePrefix || '') + event.title;

    if (!cfg.dryRun && cfg.skipIfSimilarEventExists !== false && findSimilarEvent(cfg, event, summary)) {
      Logger.log('同じ時間帯に同名の予定があるためスキップ: ' + summary);
      return null;
    }

    var resource = {
      summary: summary,
      description: buildDescription(cfg, ctx),
      extendedProperties: {
        private: {
          chatMessage: ctx.messageName || '',
          source: SOURCE_TAG
        }
      }
    };
    var recurrence = buildRecurrence(event, cfg);
    if (recurrence) resource.recurrence = recurrence;
    if (event.location) resource.location = event.location;
    if (cfg.colorId) resource.colorId = String(cfg.colorId);
    if (cfg.reminderMinutes !== null && cfg.reminderMinutes !== undefined) {
      resource.reminders = {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: cfg.reminderMinutes }]
      };
    }

    if (event.allDay) {
      resource.start = { date: event.startDate };
      resource.end = { date: event.endDateExclusive };
    } else {
      resource.start = { dateTime: rfc3339(event.start, cfg.timeZone), timeZone: cfg.timeZone };
      resource.end = { dateTime: rfc3339(event.end, cfg.timeZone), timeZone: cfg.timeZone };
    }

    if (cfg.dryRun) {
      Logger.log('[dryRun] 登録スキップ: ' + Parser.describe(event));
      return { htmlLink: null, summary: summary, dryRun: true };
    }

    return Calendar.Events.insert(resource, cfg.calendarId);
  }

  /** chat-to-calendar が作った予定をまとめて消す（試行錯誤のあと片付け用）。 */
  function deleteCreatedEvents(cfg, fromDate, toDate) {
    requireCalendarService();
    var res = Calendar.Events.list(cfg.calendarId, {
      privateExtendedProperty: 'source=' + SOURCE_TAG,
      timeMin: rfc3339(fromDate, cfg.timeZone),
      timeMax: rfc3339(toDate, cfg.timeZone),
      maxResults: 250,
      showDeleted: false
    });
    var items = res.items || [];
    items.forEach(function (item) { Calendar.Events.remove(cfg.calendarId, item.id); });
    return items.length;
  }

  return {
    createEvent: createEvent,
    findExisting: findExisting,
    findSimilarEvent: findSimilarEvent,
    buildRecurrence: buildRecurrence,
    deleteCreatedEvents: deleteCreatedEvents,
    SOURCE_TAG: SOURCE_TAG
  };
})();

// ==========================================================================
// Main.gs
// ==========================================================================

/**
 * Main.gs — エントリポイント。
 *
 * 使い方は 2 通り（両方同時に使える）:
 *
 *  1) 定期ポーリング（自動で拾う）
 *     installTriggers() を 1 度実行しておくと、pollIntervalMinutes ごとに syncNow() が動き、
 *     監視対象スペースの新着メッセージから予定を拾ってカレンダーに登録する。
 *
 *  2) Chat アプリ（Bot にメンションして登録）
 *     スペースで「@予定Bot 明日10時から現場打合せ」のようにメンションすると onMessage() が呼ばれ、
 *     その場で予定を作って結果をスレッドに返す。
 */

// ------------------------------------------------------------------ ポーリング

/** 監視対象スペースの新着メッセージを取り込む（時間主導トリガーから呼ばれる）。 */
function syncNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('前回の実行が終わっていないためスキップしました。');
    return;
  }
  try {
    var cfg = getConfig();
    var report = pollSpaces_(cfg, false);
    Logger.log(formatReport_(report));
    if (cfg.notifyEmail && report.created.length) {
      MailApp.sendEmail(cfg.notifyEmail, 'Chat から予定を登録しました (' + report.created.length + '件)', formatReport_(report));
    }
    return report;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 登録はせずに、いま何が拾われるかだけログに出す。
 * 取り込み位置（カーソル）も進めないので、設定の試運転に使える。
 */
function previewOnly() {
  var cfg = getConfig();
  cfg.dryRun = true;
  var report = pollSpaces_(cfg, true);
  Logger.log(formatReport_(report));
  return report;
}

function pollSpaces_(cfg, preview) {
  var report = { created: [], skipped: [], errors: [], spaces: 0, messages: 0 };
  var spaceNames;
  try {
    spaceNames = ChatSource.resolveTargetSpaces(cfg);
  } catch (err) {
    report.errors.push('スペース一覧の取得に失敗: ' + err);
    return report;
  }

  var defaultCursor = rfc3339_(new Date(Date.now() - cfg.initialLookbackMinutes * 60 * 1000), cfg.timeZone);

  for (var i = 0; i < spaceNames.length; i++) {
    var spaceName = spaceNames[i];
    report.spaces++;
    try {
      var cursor = Store.getCursor(spaceName) || defaultCursor;
      var messages = ChatSource.listMessagesSince(spaceName, cursor, cfg);
      report.messages += messages.length;
      var processed = [];
      var latestCreateTime = null;

      for (var j = 0; j < messages.length; j++) {
        var message = messages[j];
        latestCreateTime = message.createTime || latestCreateTime;
        var outcome = handleMessage_(message, cfg, spaceName);
        if (outcome.created.length) {
          outcome.created.forEach(function (c) { report.created.push(c); });
          processed.push(message.name);
        } else if (outcome.skipped) {
          report.skipped.push(outcome.skipped);
        }
      }

      if (!preview) {
        if (processed.length) Store.markProcessed(processed);
        if (latestCreateTime) Store.setCursor(spaceName, latestCreateTime);
      }
    } catch (err) {
      report.errors.push(spaceName + ': ' + err);
    }
  }
  return report;
}

/** 1 メッセージを処理して、作成した予定の一覧を返す。 */
function handleMessage_(message, cfg, spaceName) {
  var result = { created: [], skipped: null };

  if (message.sender && message.sender.type === 'BOT') {
    return result;                                       // Bot の投稿は対象外
  }
  var senderName = (message.sender && message.sender.displayName) || '';
  if (cfg.ignoreSenders && cfg.ignoreSenders.indexOf(senderName) !== -1) {
    return result;
  }
  if (message.name && Store.isProcessed(message.name)) {
    return result;                                       // 取り込み済み
  }

  var text = ChatSource.messageText(message);
  if (!text) return result;

  var base = parseRfc3339_(message.createTime) || new Date();
  var parsed = Parser.parseMessage(text, base, cfg);
  if (!parsed.events.length) {
    result.skipped = truncate_(text, 40) + ' (' + parsed.skipped + ')';
    return result;
  }

  var ctx = {
    messageName: message.name,
    messageText: truncate_(text, 900),
    senderName: senderName,
    spaceName: spaceName || (message.space && message.space.name),
    spaceDisplayName: message.space && message.space.displayName,
    permalink: ChatSource.buildPermalink(message.name)
  };

  for (var i = 0; i < parsed.events.length; i++) {
    var event = parsed.events[i];
    try {
      var created = CalendarSync.createEvent(event, ctx, cfg);
      if (created) {
        result.created.push({
          summary: created.summary || event.title,
          when: Parser.describe(event),
          link: created.htmlLink || null,
          space: ctx.spaceDisplayName || ctx.spaceName,
          sender: senderName
        });
      }
    } catch (err) {
      throw new Error('カレンダー登録に失敗 (' + Parser.describe(event) + '): ' + err);
    }
  }

  if (result.created.length && cfg.notifyInChat && !cfg.dryRun) {
    try {
      var lines = result.created.map(function (c) { return '・' + c.when; });
      ChatSource.postMessage(ctx.spaceName,
        '📅 カレンダーに登録しました\n' + lines.join('\n'),
        message.thread && message.thread.name);
    } catch (err) {
      Logger.log('Chat への通知に失敗: ' + err);
    }
  }
  return result;
}

// ---------------------------------------------------------------- Chat アプリ

/** Chat アプリがメンションされたときに呼ばれる。 */
function onMessage(event) {
  var cfg = getConfig();
  cfg.requireKeyword = false;     // 直接呼ばれているのでキーワード判定は不要
  cfg.explicit = true;

  var message = event.message || {};
  var text = message.argumentText || message.text || '';
  var space = (event.space && event.space.name) || (message.space && message.space.name);

  if (!text.trim() || /^(help|ヘルプ|使い方)$/i.test(text.trim())) {
    return { text: helpText_() };
  }

  var base = parseRfc3339_(message.createTime) || new Date();
  var parsed = Parser.parseMessage(text, base, cfg);
  if (!parsed.events.length) {
    return { text: '予定として読み取れませんでした。\n例) @' + appName_() + ' 明日10時から現場打合せ\n' + helpText_() };
  }

  var ctx = {
    messageName: message.name,
    messageText: truncate_(text, 900),
    senderName: (message.sender && message.sender.displayName) || (event.user && event.user.displayName) || '',
    spaceName: space,
    spaceDisplayName: (event.space && event.space.displayName) || '',
    permalink: ChatSource.buildPermalink(message.name)
  };

  var lines = [];
  for (var i = 0; i < parsed.events.length; i++) {
    var ev = parsed.events[i];
    try {
      var created = CalendarSync.createEvent(ev, ctx, cfg);
      if (created) {
        lines.push('・' + Parser.describe(ev) + (created.htmlLink ? '\n  ' + created.htmlLink : ''));
      } else {
        lines.push('・' + Parser.describe(ev) + '（登録済み）');
      }
    } catch (err) {
      lines.push('・' + Parser.describe(ev) + ' → 登録に失敗しました: ' + err);
    }
  }
  if (message.name) Store.markProcessed([message.name]);
  return { text: '📅 カレンダーに登録しました\n' + lines.join('\n') };
}

function onAddedToSpace(event) {
  return { text: 'こんにちは。予定を書いてメンションしてください。\n' + helpText_() };
}

function onRemovedFromSpace(event) {
  Logger.log('スペースから削除されました: ' + (event.space && event.space.name));
}

function helpText_() {
  return [
    '【書き方の例】',
    '  9/20 10:00~12:00 A様邸 定例打合せ',
    '  明日10時から現場打ち合わせ',
    '  来週火曜 13時半から 施主打合せ @事務所',
    '  10/1~10/3 出張',
    '  2026年9月20日 終日 現場清掃'
  ].join('\n');
}

function appName_() {
  return '予定登録';
}

// -------------------------------------------------------------- トリガー管理

/** 定期ポーリングのトリガーを作る（初回に 1 度だけ実行する）。 */
function installTriggers() {
  var cfg = getConfig();
  removeTriggers();
  var minutes = cfg.pollIntervalMinutes;
  var builder = ScriptApp.newTrigger('syncNow').timeBased();
  if (minutes >= 60) {
    builder.everyHours(Math.max(1, Math.round(minutes / 60))).create();
  } else {
    var allowed = [1, 5, 10, 15, 30];
    if (allowed.indexOf(minutes) === -1) {
      throw new Error('pollIntervalMinutes は 1 / 5 / 10 / 15 / 30 / 60 のいずれかにしてください（現在: ' + minutes + '）');
    }
    builder.everyMinutes(minutes).create();
  }
  Logger.log(minutes + ' 分ごとに syncNow() を実行するトリガーを作成しました。');
}

/** ポーリングのトリガーを全部削除する。 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNow') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  if (removed) Logger.log(removed + ' 件のトリガーを削除しました。');
  return removed;
}

/**
 * 設定と接続まわりをまとめて点検する。導入時とトラブル時に最初に実行する。
 */
function checkSetup() {
  var lines = ['===== chat-to-calendar セットアップ点検 ====='];
  var cfg;
  try {
    cfg = getConfig();
    lines.push('✅ 設定の読み込み OK');
  } catch (err) {
    lines.push('❌ 設定エラー: ' + err);
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  var scriptTz = Session.getScriptTimeZone();
  lines.push((scriptTz === cfg.timeZone ? '✅' : '⚠️') +
    ' スクリプトのタイムゾーン: ' + scriptTz + '（設定: ' + cfg.timeZone + '）');

  try {
    if (typeof Calendar === 'undefined' || !Calendar.Events) {
      throw new Error('拡張サービス「Calendar API」が追加されていません');
    }
    Calendar.Events.list(cfg.calendarId, { maxResults: 1, timeMin: rfc3339_(new Date(), cfg.timeZone) });
    lines.push('✅ カレンダー「' + cfg.calendarId + '」にアクセスできます');
  } catch (err) {
    lines.push('❌ カレンダー: ' + err);
  }

  try {
    var spaces = ChatSource.listSpaces(cfg);
    lines.push('✅ Google Chat に接続できます（参加スペース ' + spaces.length + ' 件）');
    var targets = ChatSource.resolveTargetSpaces(cfg);
    lines.push('　  監視対象: ' + targets.length + ' スペース' +
      ((cfg.spaces && cfg.spaces.length) ? '（設定で指定）' : '（参加中の全スペース）'));
    if (!targets.length) lines.push('⚠️ 監視対象が 0 件です。スペースに参加しているか確認してください');
  } catch (err) {
    lines.push('❌ Google Chat: ' + err);
  }

  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'syncNow';
  });
  lines.push((triggers.length ? '✅' : '⚠️') + ' 自動実行トリガー: ' + triggers.length + ' 件' +
    (triggers.length ? '（' + cfg.pollIntervalMinutes + ' 分間隔）' : '（installTriggers を実行してください）'));

  lines.push(cfg.dryRun
    ? '⚠️ dryRun=true のためカレンダーには書き込みません（試運転モード）'
    : '✅ 本番モード（dryRun=false）');
  lines.push('　  キーワード判定: ' + (cfg.requireKeyword ? 'あり（' + cfg.keywords.length + ' 語）' : 'なし（日時があれば登録）'));
  lines.push('　  繰り返し予定: ' + (cfg.allowRecurring === false ? '作らない' : '作る'));

  try {
    var t = Tests.run();
    lines.push((t.failures.length ? '❌' : '✅') + ' 読み取りルールのテスト ' + t.passed + '/' + t.total);
    t.failures.forEach(function (f) { lines.push('　  ' + f); });
  } catch (err) {
    lines.push('⚠️ テストを実行できませんでした: ' + err);
  }

  lines.push('--- 次の一手: previewOnly() で実際のメッセージから何が拾われるか確認 ---');
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** 取り込み位置と処理済み記録を消す（最初から読み直したいとき）。 */
function resetState() {
  var n = Store.reset();
  Logger.log(n + ' 件の状態を削除しました。次回実行は initialLookbackMinutes 分前から読み直します。');
}

/** 監視できるスペースの一覧をログに出す（spaces 設定を書くとき用）。 */
function listMySpaces() {
  var cfg = getConfig();
  var spaces = ChatSource.listSpaces(cfg);
  spaces.forEach(function (s) {
    Logger.log(s.name + '\t' + (s.displayName || '(DM)') + '\t' + (s.spaceType || s.type || ''));
  });
  Logger.log('合計 ' + spaces.length + ' スペース');
  return spaces;
}

// ---------------------------------------------------------------- ユーティリティ

function rfc3339_(date, timeZone) {
  return Utilities.formatDate(date, timeZone || 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function parseRfc3339_(value) {
  if (!value) return null;
  // "2026-09-13T01:02:03.456789Z" のように秒の小数が 3 桁を超えることがあるので丸める
  var normalized = String(value).replace(/\.(\d{3})\d+/, '.$1');
  var d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

function truncate_(text, max) {
  var s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.substring(0, max) + '…' : s;
}

function formatReport_(report) {
  var lines = [];
  lines.push('スペース: ' + report.spaces + ' / 新着メッセージ: ' + report.messages +
    ' / 登録: ' + report.created.length);
  report.created.forEach(function (c) {
    lines.push('  ✅ ' + c.when + ' [' + (c.space || '') + ' / ' + (c.sender || '') + ']');
  });
  if (report.skipped.length) {
    lines.push('  -- 予定として拾わなかったメッセージ: ' + report.skipped.length + ' 件');
    report.skipped.slice(0, 20).forEach(function (s) { lines.push('     ・' + s); });
  }
  report.errors.forEach(function (e) { lines.push('  ⚠️ ' + e); });
  return lines.join('\n');
}

// ==========================================================================
// Tests.gs
// ==========================================================================

/**
 * Tests.gs — Parser のテスト。
 *
 * Apps Script 上では runParserTests() を実行するとログに結果が出る。
 * ローカルでは `node chat-to-calendar/test/run.js` で同じテストが走る。
 *
 * 基準日時はすべて 2026-09-13(日) 09:00 とする。
 */
var Tests = (function () {
  'use strict';

  var BASE = new Date(2026, 8, 13, 9, 0);   // 2026-09-13(日) 09:00

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmt(ev) {
    if (ev.allDay) return ev.startDate + '..' + ev.endDateExclusive;
    function f(d) {
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    return f(ev.start) + '..' + f(ev.end);
  }

  /** 繰り返し設定を比較用の短い文字列にする。 */
  function recurStr(ev) {
    if (!ev.recurrence) return '';
    var r = ev.recurrence;
    return r.freq + '/' + r.interval + '/' + ((r.byDay || []).join(',')) + (r.byMonthDay ? '/' + r.byMonthDay : '');
  }

  var CASES = [
    {
      name: '日付+時刻レンジ+件名',
      text: '9/20 10:00~12:00 A様邸 定例打合せ',
      expect: [{ when: '2026-09-20 10:00..2026-09-20 12:00', title: 'A様邸 定例打合せ' }]
    },
    {
      name: '相対日付+「10時から」',
      text: '明日10時から現場打ち合わせ',
      expect: [{ when: '2026-09-14 10:00..2026-09-14 11:00', title: '現場打ち合わせ' }]
    },
    {
      name: '来週+曜日+時刻半+場所',
      text: '来週火曜 13時半から 施主打合せ @事務所',
      expect: [{ when: '2026-09-15 13:30..2026-09-15 14:30', title: '施主打合せ', location: '事務所' }]
    },
    {
      name: '和暦式の年月日+曜日カッコ+終日',
      text: '2026年9月20日(土) 終日 現場清掃',
      expect: [{ when: '2026-09-20..2026-09-21', title: '現場清掃' }]
    },
    {
      name: '日付レンジ（複数日の終日予定）',
      text: '10/1~10/3 出張',
      expect: [{ when: '2026-10-01..2026-10-04', title: '出張' }]
    },
    {
      name: '日のみ+時刻',
      text: '20日 9時 搬入',
      expect: [{ when: '2026-09-20 09:00..2026-09-20 10:00', title: '搬入' }]
    },
    {
      name: '全角数字と午後の推定（3時→15時）',
      text: '３時から会議です',
      expect: [{ when: '2026-09-13 15:00..2026-09-13 16:00', title: '会議' }]
    },
    {
      name: '午前指定は午後に倒さない',
      text: '午前9時から朝礼',
      expect: [{ when: '2026-09-13 09:00..2026-09-13 10:00', title: '朝礼' }]
    },
    {
      name: 'ハイフンの時刻レンジ',
      text: '9/25 15:00-16:30 B現場 検査立会',
      expect: [{ when: '2026-09-25 15:00..2026-09-25 16:30', title: 'B現場 検査立会' }]
    },
    {
      name: '複数行から複数の予定',
      text: '来週の予定です\n9/22 13:00 事務所で定例打合せ\n9/24 10:00 C様邸 検査',
      expect: [
        { when: '2026-09-22 13:00..2026-09-22 14:00', title: '事務所で定例打合せ' },
        { when: '2026-09-24 10:00..2026-09-24 11:00', title: 'C様邸 検査' }
      ]
    },
    {
      name: '「3時間」は時刻として拾わない',
      text: '3時間かかります。明日 搬入します',
      expect: [{ when: '2026-09-14..2026-09-15', title: '搬入します' }]
    },
    {
      name: '「今週の金曜」',
      text: '今週の金曜 14時 定例',
      expect: [{ when: '2026-09-11 14:00..2026-09-11 15:00', title: '定例' }],
      note: '基準日(日)から見た今週の金曜は 9/11。過去なので登録対象外になる',
      expectEmpty: true
    },
    {
      name: '本日+「15時より」',
      text: '本日15時より 現場定例',
      expect: [{ when: '2026-09-13 15:00..2026-09-13 16:00', title: '現場定例' }]
    },
    {
      name: '場所ラベル',
      text: '9/30 10:00 安全パトロール 場所:現場事務所',
      expect: [{ when: '2026-09-30 10:00..2026-09-30 11:00', title: '安全パトロール', location: '現場事務所' }]
    },
    {
      name: '年跨ぎの日付レンジ',
      text: '12/28~1/5 冬季休暇',
      cfg: { requireKeyword: false },
      expect: [{ when: '2026-12-28..2027-01-06', title: '冬季休暇' }]
    },
    {
      name: '日付レンジの区切りが件名に残らない',
      text: '念のため再送: 10/1~10/3 出張します',
      expect: [{ when: '2026-10-01..2026-10-04', title: '念のため再送: 出張します' }]
    },
    {
      name: '時刻だけなら当日扱い',
      text: 'ミーティングは9:30から',
      expect: [{ when: '2026-09-13 09:30..2026-09-13 10:30', title: 'ミーティング' }]
    },
    { name: '予定でない雑談は無視', text: 'お疲れ様です。了解しました。', expectEmpty: true },
    {
      name: '報告（〜しておりました）は登録しない',
      text: '先ほどAmazonで配達状況確認したところ、9/14に納品予定になっておりました',
      expectEmpty: true
    },
    {
      name: '完了報告は登録しない',
      text: 'ガス屋さんと空調屋さんは、朝に配管の墨出しをしました。',
      expectEmpty: true
    },
    {
      name: 'キーワードは日時と同じ文に必要（別の話題に引きずられない）',
      text: '作業予定の件です。給与計算に進めないため、17時までに申請をお願いします',
      expectEmpty: true
    },
    {
      name: '手順の説明文を予定にしない',
      text: '毎週 AnyONE に案件を登録しておけば、8:20 に案件一覧へ自動で行が足されます',
      expectEmpty: true
    },
    {
      name: 'keywordScope=message なら文をまたいで拾う',
      text: '打合せの件です。\n9/22 13:00 事務所',
      cfg: { keywordScope: 'message' },
      expect: [{ when: '2026-09-22 13:00..2026-09-22 14:00', title: '事務所' }]
    },
    {
      name: 'requireDateAndTime=true なら終日予定は作らない',
      text: '9/28 上棟',
      cfg: { requireDateAndTime: true },
      expectEmpty: true
    },
    { name: '中止・延期の連絡は登録しない', text: '9/20の打合せは中止です', expectEmpty: true },
    { name: '過去の日付は登録しない', text: '9/1 10:00 打合せ', expectEmpty: true },
    { name: 'キーワードが無ければ拾わない', text: '9/20 10:00 よろしく', expectEmpty: true },
    {
      name: 'requireKeyword=false なら拾う',
      text: '9/20 10:00 よろしく',
      cfg: { requireKeyword: false },
      expect: [{ when: '2026-09-20 10:00..2026-09-20 11:00', title: 'よろしく' }]
    },
    {
      name: '末尾の定型句は件名から落とす',
      text: 'おはようございます。9/20 10:00~12:00 A様邸 定例打合せ よろしくお願いします',
      expect: [{ when: '2026-09-20 10:00..2026-09-20 12:00', title: 'A様邸 定例打合せ' }]
    },
    {
      name: '毎週の繰り返し',
      text: '毎週月曜 10時 定例会議',
      expect: [{ when: '2026-09-14 10:00..2026-09-14 11:00', title: '定例会議', recur: 'WEEKLY/1/MO' }]
    },
    {
      name: '隔週の繰り返し',
      text: '隔週火曜 13時 現場定例',
      expect: [{ when: '2026-09-15 13:00..2026-09-15 14:00', title: '現場定例', recur: 'WEEKLY/2/TU' }]
    },
    {
      name: '毎月◯日の繰り返し',
      text: '毎月15日 9時 安全パトロール',
      expect: [{ when: '2026-09-15 09:00..2026-09-15 10:00', title: '安全パトロール', recur: 'MONTHLY/1//15' }]
    },
    {
      name: '平日の繰り返しは開始日を平日まで送る',
      text: '平日 8時 朝礼',
      expect: [{ when: '2026-09-14 08:00..2026-09-14 09:00', title: '朝礼', recur: 'WEEKLY/1/MO,TU,WE,TH,FR' }]
    },
    {
      name: '午後イチ',
      text: '明日 午後イチ 打合せ',
      expect: [{ when: '2026-09-14 13:00..2026-09-14 14:00', title: '打合せ' }]
    },
    {
      name: '朝イチ',
      text: '明日 朝イチで 現場確認',
      expect: [{ when: '2026-09-14 08:00..2026-09-14 09:00', title: '現場確認' }]
    },
    {
      name: '午前中は 9:00-12:00',
      text: '明日 午前中 検査',
      expect: [{ when: '2026-09-14 09:00..2026-09-14 12:00', title: '検査' }]
    },
    {
      name: '所要時間（分）',
      text: '9/20 10時から30分 打合せ',
      expect: [{ when: '2026-09-20 10:00..2026-09-20 10:30', title: '打合せ' }]
    },
    {
      name: '所要時間（時間）',
      text: '9/20 10:00から1時間 現場打合せ',
      expect: [{ when: '2026-09-20 10:00..2026-09-20 11:00', title: '現場打合せ' }]
    },
    {
      name: '日付だけなら終日予定',
      text: '9/28 上棟',
      expect: [{ when: '2026-09-28..2026-09-29', title: '上棟' }]
    }
  ];

  function runCase(testCase) {
    var cfg = testCase.cfg || {};
    var result = Parser.parseMessage(testCase.text, BASE, cfg);
    var events = result.events;

    if (testCase.expectEmpty) {
      if (events.length === 0) return { ok: true };
      return { ok: false, message: '予定が作られないはずが ' + events.length + ' 件: ' + events.map(fmt).join(', ') };
    }

    var expected = testCase.expect || [];
    if (events.length !== expected.length) {
      return { ok: false, message: '件数が違う。期待 ' + expected.length + ' / 実際 ' + events.length +
        ' [' + events.map(function (e) { return fmt(e) + ' ' + e.title; }).join(' | ') + ']' };
    }
    for (var i = 0; i < expected.length; i++) {
      var actualWhen = fmt(events[i]);
      if (actualWhen !== expected[i].when) {
        return { ok: false, message: '[' + i + '] 日時が違う。期待 ' + expected[i].when + ' / 実際 ' + actualWhen };
      }
      if (expected[i].title !== undefined && events[i].title !== expected[i].title) {
        return { ok: false, message: '[' + i + '] 件名が違う。期待 "' + expected[i].title + '" / 実際 "' + events[i].title + '"' };
      }
      if (expected[i].location !== undefined && events[i].location !== expected[i].location) {
        return { ok: false, message: '[' + i + '] 場所が違う。期待 "' + expected[i].location + '" / 実際 "' + events[i].location + '"' };
      }
      var expectedRecur = expected[i].recur || '';
      if (recurStr(events[i]) !== expectedRecur) {
        return { ok: false, message: '[' + i + '] 繰り返しが違う。期待 "' + expectedRecur + '" / 実際 "' + recurStr(events[i]) + '"' };
      }
    }
    return { ok: true };
  }

  function run() {
    var passed = 0;
    var failures = [];
    var lines = [];
    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i];
      var r;
      try {
        r = runCase(c);
      } catch (err) {
        r = { ok: false, message: '例外: ' + err };
      }
      if (r.ok) {
        passed++;
        lines.push('  ✅ ' + c.name);
      } else {
        failures.push(c.name + ' — ' + r.message);
        lines.push('  ❌ ' + c.name + ' — ' + r.message);
      }
    }
    lines.push('');
    lines.push(passed + '/' + CASES.length + ' 件成功');
    return { passed: passed, total: CASES.length, failures: failures, text: lines.join('\n') };
  }

  return { BASE: BASE, CASES: CASES, run: run, fmt: fmt };
})();

/** Apps Script エディタから実行するテストランナー。 */
function runParserTests() {
  var result = Tests.run();
  Logger.log(result.text);
  if (result.failures.length) throw new Error(result.failures.length + ' 件のテストが失敗しました');
  return result;
}

if (typeof module !== 'undefined' && module.exports) { module.exports = Tests; }

