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

    var messageHasKeyword = !cfg.requireKeyword || cfg.explicit || hasAny(norm, cfg.keywords);

    // 行に加えて「。」でも区切る（「3時間かかります。明日 搬入します」→ 件名を「搬入します」にするため）
    var lines = [];
    norm.split('\n').forEach(function (line) {
      var parts = line.indexOf('。') === -1 ? [line] : line.split('。');
      parts.forEach(function (part) { if (part.trim()) lines.push(part); });
    });
    var events = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
      var ev = parseLine(lines[i], base, cfg);
      if (!ev) continue;
      if (!messageHasKeyword && !hasAny(lines[i], cfg.keywords)) continue;
      if (!ev.title) ev.title = cfg.defaultTitle;
      var key = ev.title + '@' + ev.start.getTime() + '@' + ev.end.getTime();
      if (seen[key]) continue;
      seen[key] = true;
      events.push(ev);
      if (events.length >= cfg.maxEventsPerMessage) break;
    }
    if (!events.length) return { events: [], skipped: messageHasKeyword ? 'noSchedule' : 'noKeyword' };
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
