/**
 * LINE → Google カレンダー 予定取込 Bot（1ファイル版）
 *
 * このファイルは src/*.gs を結合した自動生成物です。
 * 直接編集せず、src/ を直してから `node tools/build-single.js` で作り直してください。
 *
 * 使い方は README.md を参照。
 */

/* ================================================================== *
 * Parser.gs
 * ================================================================== */

/**
 * Parser.gs
 * LINE に投稿された日本語テキストから予定（日時・件名・場所）を抽出する。
 *
 * 外部依存なしの純粋関数のみで構成しているため、GAS 上でもローカル（Node）でも
 * 同じコードをそのままテストできる。test/run.js を参照。
 */

/** 解析パラメータ。運用に合わせて調整する。 */
var PARSER_CONFIG = {
  // 終了時刻の指定がないときに確保する時間（分）
  defaultDurationMinutes: 60,
  // 「2時」のように午前／午後の指定がない場合、この時刻以下は午後とみなす。
  // 建設現場の朝礼（8時）を誤変換しないよう既定は 6。
  pmShiftMaxHour: 6,
  // 日付がなく時刻だけ書かれていた場合に当日（過ぎていれば翌日）とみなすか
  assumeTodayWhenDateOmitted: true
};

var WEEKDAY_INDEX = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
var WEEKDAY_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

/* ------------------------------------------------------------------ *
 * 正規化
 * ------------------------------------------------------------------ */

/**
 * 全角→半角などの正規化を行う。
 * 置換はすべて 1 文字 → 1 文字に限定しているため、正規化後の文字位置は
 * 元テキストの文字位置と完全に一致する。件名を元テキストから切り出すために重要。
 * （「ー」（長音記号）は "コーナー" 等を壊すため変換しない）
 */
function normalizeForParse_(text) {
  var s = String(text == null ? '' : text);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0); // 全角ASCII → 半角ASCII
    } else if (code === 0x3000) {
      out += ' '; // 全角スペース
    } else if (code === 0x301c || code === 0x2212 || code === 0x2013 || code === 0x2014) {
      out += '-'; // 〜 − – —
    } else {
      out += s[i];
    }
  }
  return out.replace(/~/g, '-'); // ～ は上の変換で ~ になっている
}

/* ------------------------------------------------------------------ *
 * 消費済み範囲の管理
 * ------------------------------------------------------------------ */

/**
 * マッチの範囲を返す。正規表現の先頭・末尾の \s* が前後の空白まで拾ってしまうと
 * 候補どうしの開始位置がずれて優先順位の比較が壊れるため、空白を除いた範囲に揃える。
 */
function rangeOf_(m) {
  var lead = /^\s*/.exec(m[0])[0].length;
  var trail = /\s*$/.exec(m[0])[0].length;
  return { start: m.index + lead, end: m.index + m[0].length - trail };
}

function markConsumed_(consumed, start, end) {
  consumed.push([start, end]);
}

function overlapsAny_(start, end, consumed) {
  for (var i = 0; i < consumed.length; i++) {
    if (start < consumed[i][1] && consumed[i][0] < end) return true;
  }
  return false;
}

/** 重なりのない候補を、位置が早く・より具体的なものから貪欲に選ぶ。 */
function pickNonOverlapping_(candidates) {
  var sorted = candidates.slice().sort(function (a, b) {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (b.end - b.start) - (a.end - a.start);
  });
  var picked = [];
  for (var i = 0; i < sorted.length; i++) {
    var c = sorted[i];
    var clash = false;
    for (var j = 0; j < picked.length; j++) {
      if (c.start < picked[j].end && picked[j].start < c.end) { clash = true; break; }
    }
    if (!clash) picked.push(c);
  }
  return picked.sort(function (a, b) { return a.start - b.start; });
}

/* ------------------------------------------------------------------ *
 * 日付
 * ------------------------------------------------------------------ */

function isRealDate_(y, m, d) {
  if (!(m >= 1 && m <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  var probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays_(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** 年の指定がない月日について、基準日に最も近い年を選ぶ（未来寄り）。 */
function inferYear_(month, day, base) {
  var today = startOfDay_(base);
  var candidates = [base.getFullYear() - 1, base.getFullYear(), base.getFullYear() + 1];
  var best = null;
  for (var i = 0; i < candidates.length; i++) {
    var y = candidates[i];
    if (!isRealDate_(y, month, day)) continue;
    var diff = Math.round((new Date(y, month - 1, day) - today) / 86400000);
    // 60日より前は「過ぎた予定」ではなく翌年の予定とみなす
    var score = diff >= -60 ? diff : diff + 100000;
    if (best === null || score < best.score) best = { y: y, score: score };
  }
  return best ? best.y : base.getFullYear();
}

/** 週の始まり（月曜）を返す。 */
function startOfWeek_(base) {
  var d = startOfDay_(base);
  var shift = (d.getDay() + 6) % 7; // 月曜=0
  return addDays_(d, -shift);
}

var PAREN_WEEKDAY = '(?:\\s*\\(\\s*[日月火水木金土](?:曜日?)?\\s*\\))?';

function dateCandidates_(norm, base) {
  var list = [];
  var m, re;

  function add(match, priority, resolve) {
    var r = rangeOf_(match);
    list.push({ start: r.start, end: r.end, priority: priority, resolve: resolve });
  }

  // 2026/9/15, 2026年9月15日, 2026-09-15
  re = new RegExp('(\\d{4})\\s*[\\/\\-年]\\s*(\\d{1,2})\\s*[\\/\\-月]\\s*(\\d{1,2})\\s*日?' + PAREN_WEEKDAY, 'g');
  while ((m = re.exec(norm)) !== null) {
    var y1 = +m[1], mo1 = +m[2], d1 = +m[3];
    if (!isRealDate_(y1, mo1, d1)) continue;
    add(m, 6, (function (y, mo, d) {
      return function () { return new Date(y, mo - 1, d); };
    })(y1, mo1, d1));
  }

  // 9月15日（漢字表記なので誤検出しにくい）
  re = new RegExp('(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日' + PAREN_WEEKDAY, 'g');
  while ((m = re.exec(norm)) !== null) {
    var mo2 = +m[1], d2 = +m[2];
    if (!(mo2 >= 1 && mo2 <= 12) || !(d2 >= 1 && d2 <= 31)) continue;
    add(m, 5, (function (mo, d) {
      return function (b) { return new Date(inferYear_(mo, d, b), mo - 1, d); };
    })(mo2, d2));
  }

  // 9/15
  re = new RegExp('(?<![\\d:])(\\d{1,2})\\s*\\/\\s*(\\d{1,2})(?![\\d:])' + PAREN_WEEKDAY, 'g');
  while ((m = re.exec(norm)) !== null) {
    var mo3 = +m[1], d3 = +m[2];
    if (!(mo3 >= 1 && mo3 <= 12) || !(d3 >= 1 && d3 <= 31)) continue;
    add(m, 4, (function (mo, d) {
      return function (b) { return new Date(inferYear_(mo, d, b), mo - 1, d); };
    })(mo3, d3));
  }

  // 今日／明日／明後日 など
  var RELATIVE = {
    '今日': 0, '本日': 0, 'きょう': 0,
    '明日': 1, 'あした': 1, 'あす': 1,
    '明後日': 2, 'あさって': 2,
    '明々後日': 3, 'しあさって': 3,
    '昨日': -1, 'きのう': -1
  };
  re = /(今日|本日|きょう|明後日|明々後日|明日|あした|あす|あさって|しあさって|昨日|きのう)/g;
  while ((m = re.exec(norm)) !== null) {
    add(m, 5, (function (offset) {
      return function (b) { return addDays_(startOfDay_(b), offset); };
    })(RELATIVE[m[1]]));
  }

  // 今週月曜／来週の金曜日／再来週水曜
  re = /(今週|来週|再来週)\s*の?\s*([日月火水木金土])\s*曜日?/g;
  while ((m = re.exec(norm)) !== null) {
    var weekOffset = m[1] === '今週' ? 0 : (m[1] === '来週' ? 1 : 2);
    add(m, 5, (function (wo, wd) {
      return function (b) {
        var monday = addDays_(startOfWeek_(b), wo * 7);
        return addDays_(monday, (wd + 6) % 7); // 月曜=0 起点に並べ替え
      };
    })(weekOffset, WEEKDAY_INDEX[m[2]]));
  }

  // 月曜日（単独）— 今日を含む直近のその曜日
  re = /(?:今週|来週|再来週)?\s*の?\s*([日月火水木金土])\s*曜日?/g;
  while ((m = re.exec(norm)) !== null) {
    add(m, 3, (function (wd) {
      return function (b) {
        var today = startOfDay_(b);
        return addDays_(today, (wd - today.getDay() + 7) % 7);
      };
    })(WEEKDAY_INDEX[m[1]]));
  }

  // 15日（日のみ）— 今月、過ぎていれば翌月。「3日間」は除外。
  re = /(?<![\d\/])(\d{1,2})\s*日(?![間後前])/g;
  while ((m = re.exec(norm)) !== null) {
    var dd = +m[1];
    if (!(dd >= 1 && dd <= 31)) continue;
    add(m, 2, (function (d) {
      return function (b) {
        var today = startOfDay_(b);
        var y = today.getFullYear(), mo = today.getMonth();
        if (d < today.getDate()) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
        if (!isRealDate_(y, mo + 1, d)) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
        return new Date(y, mo, d);
      };
    })(dd));
  }

  return list;
}

/** 日付を 1〜2 個（範囲）抽出する。 */
function extractDates_(norm, base, consumed) {
  var cands = dateCandidates_(norm, base).filter(function (c) {
    return !overlapsAny_(c.start, c.end, consumed);
  });
  var picked = pickNonOverlapping_(cands);
  if (!picked.length) return [];

  var dates = [{
    date: picked[0].resolve(base), start: picked[0].start, end: picked[0].end,
    // 優先度 4 以上 = 年月日・月日・相対語・週＋曜日。それ未満は「15日」「月曜」だけの弱い手がかり
    strength: picked[0].priority >= 4 ? 'strong' : 'weak'
  }];
  markConsumed_(consumed, picked[0].start, picked[0].end);

  if (picked.length > 1) {
    var gap = norm.substring(picked[0].end, picked[1].start);
    if (/^\s*(?:-|から|より)\s*$/.test(gap)) {
      dates.push({
        date: picked[1].resolve(base), start: picked[1].start, end: picked[1].end,
        strength: picked[1].priority >= 4 ? 'strong' : 'weak'
      });
      markConsumed_(consumed, picked[0].end, picked[1].end);
    }
  }
  return dates;
}

/* ------------------------------------------------------------------ *
 * 時刻
 * ------------------------------------------------------------------ */

var MERIDIEM = '(午前|午後|AM|PM|am|pm|朝|昼|夕方|夜|深夜)?';

function resolveHour_(hour, meridiem, cfg) {
  var h = hour;
  var mer = meridiem ? String(meridiem).toLowerCase() : '';
  if (mer === '午前' || mer === 'am' || mer === '朝') {
    if (h === 12) h = 0;
  } else if (mer === '午後' || mer === 'pm' || mer === '夕方' || mer === '夜' || mer === '昼') {
    if (h < 12) h += 12;
  } else if (mer === '深夜') {
    // 深夜1時 = 01:00 のまま扱う
  } else if (h >= 1 && h <= cfg.pmShiftMaxHour) {
    h += 12; // 午前／午後の指定がない一桁台は午後とみなす
  }
  return h;
}

function timeCandidates_(norm) {
  var list = [];
  var m, re;

  function add(match, priority, hour, minute, meridiem) {
    var r = rangeOf_(match);
    list.push({
      start: r.start, end: r.end, priority: priority,
      hour: hour, minute: minute, meridiem: meridiem || '',
      explicitMeridiem: !!meridiem
    });
  }

  // 14:30 / 14時30分
  re = new RegExp(MERIDIEM + '\\s*(\\d{1,2})\\s*(?::|時)\\s*(\\d{1,2})\\s*分?', 'g');
  while ((m = re.exec(norm)) !== null) {
    var h1 = +m[2], mi1 = +m[3];
    if (h1 > 24 || mi1 > 59) continue;
    add(m, 3, h1, mi1, m[1]);
  }

  // 14時半
  re = new RegExp(MERIDIEM + '\\s*(\\d{1,2})\\s*時\\s*半', 'g');
  while ((m = re.exec(norm)) !== null) {
    var h2 = +m[2];
    if (h2 > 24) continue;
    add(m, 3, h2, 30, m[1]);
  }

  // 14時
  re = new RegExp(MERIDIEM + '\\s*(\\d{1,2})\\s*時', 'g');
  while ((m = re.exec(norm)) !== null) {
    var h3 = +m[2];
    if (h3 > 24) continue;
    add(m, 2, h3, 0, m[1]);
  }

  return list;
}

/** 時刻を 1〜2 個（開始／終了）抽出する。 */
function extractTimes_(norm, consumed, cfg) {
  var cands = timeCandidates_(norm).filter(function (c) {
    return !overlapsAny_(c.start, c.end, consumed);
  });
  var picked = pickNonOverlapping_(cands);
  if (!picked.length) return [];

  var times = [picked[0]];
  markConsumed_(consumed, picked[0].start, picked[0].end);

  if (picked.length > 1) {
    var gap = norm.substring(picked[0].end, picked[1].start);
    if (/^\s*(?:-|から|より)\s*$/.test(gap)) {
      times.push(picked[1]);
      markConsumed_(consumed, picked[0].end, picked[1].end);
      // 続く「まで」も件名から取り除く
      var tail = /^\s*まで/.exec(norm.substring(picked[1].end));
      if (tail) markConsumed_(consumed, picked[1].end, picked[1].end + tail[0].length);
    }
  } else {
    var fromTail = /^\s*(?:から|より)/.exec(norm.substring(picked[0].end));
    if (fromTail) markConsumed_(consumed, picked[0].end, picked[0].end + fromTail[0].length);
  }
  return times;
}

/* ------------------------------------------------------------------ *
 * 場所・終日
 * ------------------------------------------------------------------ */

function extractLocation_(norm, consumed) {
  var m = /(?:場所|会場)\s*[:：]\s*([^\n]+)/.exec(norm);
  if (m) {
    markConsumed_(consumed, m.index, m.index + m[0].length);
    return m[1].trim();
  }
  m = /(?:^|[\s\n])@\s*([^\n]+)/.exec(norm);
  if (m) {
    var at = norm.indexOf('@', m.index);
    markConsumed_(consumed, at, at + (m[0].length - (at - m.index)));
    return m[1].trim();
  }
  return '';
}

function extractAllDayMarker_(norm, consumed) {
  var m = /(終日|全日|一日中|1日中)/.exec(norm);
  if (!m) return false;
  markConsumed_(consumed, m.index, m.index + m[0].length);
  return true;
}

/* ------------------------------------------------------------------ *
 * 件名
 * ------------------------------------------------------------------ */

var TITLE_PARTICLES = '(?:には|では|とは|から|まで|より|に|は|が|を|で|へ|と|や|の|も)';

function isHiragana_(ch) {
  if (!ch) return false;
  var c = ch.charCodeAt(0);
  return c >= 0x3041 && c <= 0x309f;
}

/**
 * 取り除いた日時の直後に残る助詞を落とす。
 * ただし助詞の次が平仮名なら語の一部の可能性が高いので残す
 * （例:「9/15はつり工事」の「は」を削って「つり工事」にしない）。
 */
function stripHeadParticle_(text) {
  var m = new RegExp('^([\\s]*)' + TITLE_PARTICLES).exec(text);
  if (!m) return text;
  var rest = text.substring(m[0].length);
  if (isHiragana_(rest.charAt(0))) return text;
  return m[1] + rest;
}

/** 取り除いた日時の直前に残る助詞を落とす（例:「会議は 9/15」→「会議」）。 */
function stripTailParticle_(text) {
  var m = new RegExp(TITLE_PARTICLES + '([\\s]*)$').exec(text);
  if (!m) return text;
  var head = text.substring(0, m.index);
  if (!head.replace(/\s/g, '')) return text; // 助詞だけの断片は触らない
  return head + m[1];
}

/** 重なりのある範囲を統合して昇順に並べる。 */
function mergeRanges_(ranges) {
  var sorted = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
  var merged = [];
  for (var i = 0; i < sorted.length; i++) {
    var last = merged[merged.length - 1];
    if (last && sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else merged.push([sorted[i][0], sorted[i][1]]);
  }
  return merged;
}

/** 日時・場所として消費した部分を元テキストから取り除き、件名を組み立てる。 */
function buildTitle_(raw, consumed) {
  var ranges = mergeRanges_(consumed);
  var segments = [];
  var cursor = 0;
  for (var i = 0; i < ranges.length; i++) {
    segments.push({ text: raw.substring(cursor, ranges[i][0]), hasBefore: i > 0, hasAfter: true });
    cursor = ranges[i][1];
  }
  segments.push({ text: raw.substring(cursor), hasBefore: ranges.length > 0, hasAfter: false });

  var parts = [];
  for (i = 0; i < segments.length; i++) {
    var text = segments[i].text;
    if (segments[i].hasBefore) text = stripHeadParticle_(text);
    if (segments[i].hasAfter) text = stripTailParticle_(text);
    parts.push(text);
  }
  return cleanupTitle_(parts.join(''));
}

function cleanupTitle_(s) {
  var t = String(s).replace(/[\s　]+/g, ' ').trim();
  // 助詞の除去は buildTitle_ が位置を見て行うため、ここでは記号だけを落とす
  t = t.replace(/^[\s\-–—:：,、。・|]+/, '').replace(/[\s\-–—:：,、。・|]+$/, '');
  return t.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * エントリポイント
 * ------------------------------------------------------------------ */

/**
 * 1 件分のテキストを解析する。
 * @param {string} text 解析対象
 * @param {Date=} now 基準日時（省略時は現在時刻）
 * @param {Object=} options PARSER_CONFIG の一部を上書き
 * @return {?Object} {title, start, end, allDay, location, matched} / 解析できなければ null
 */
function parseSchedule(text, now, options) {
  var cfg = {};
  var key;
  for (key in PARSER_CONFIG) cfg[key] = PARSER_CONFIG[key];
  if (options) for (key in options) cfg[key] = options[key];

  var base = now ? new Date(now.getTime()) : new Date();
  var raw = String(text == null ? '' : text);
  var norm = normalizeForParse_(raw);
  var consumed = [];

  var location = extractLocation_(norm, consumed);
  var allDayMarked = extractAllDayMarker_(norm, consumed);
  var dates = extractDates_(norm, base, consumed);
  var times = extractTimes_(norm, consumed, cfg);

  if (!dates.length && !times.length) return null;
  if (!dates.length && !cfg.assumeTodayWhenDateOmitted) return null;

  var day0, day1;
  if (dates.length) {
    day0 = dates[0].date;
    day1 = dates.length > 1 ? dates[1].date : null;
  } else {
    day0 = startOfDay_(base);
    day1 = null;
  }

  var start, end, allDay;

  if (allDayMarked || !times.length) {
    allDay = true;
    start = startOfDay_(day0);
    end = addDays_(startOfDay_(day1 || day0), 1); // Google カレンダーの終日は終了日が排他的
  } else {
    allDay = false;
    var sh = resolveHour_(times[0].hour, times[0].meridiem, cfg);
    var startDay = startOfDay_(day0);
    if (sh >= 24) { startDay = addDays_(startDay, 1); sh -= 24; }
    start = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate(), sh, times[0].minute);

    // 日付だけ省略された場合、当日の指定時刻を過ぎていれば翌日とみなす
    if (!dates.length && cfg.assumeTodayWhenDateOmitted && start.getTime() < base.getTime()) {
      start = addDays_(start, 1);
    }

    if (times.length > 1) {
      var eh = resolveHour_(times[1].hour, times[1].meridiem, cfg);
      var endDay = startOfDay_(day1 || start);
      if (eh >= 24) { endDay = addDays_(endDay, 1); eh -= 24; }
      end = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate(), eh, times[1].minute);
      if (end.getTime() <= start.getTime() && !times[1].explicitMeridiem && times[1].hour < 12) {
        end = new Date(end.getTime() + 12 * 3600000); // 「午後1時-3時」の 3時 を 15時 と解釈
      }
      if (end.getTime() <= start.getTime()) end = addDays_(end, 1);
    } else {
      end = new Date(start.getTime() + cfg.defaultDurationMinutes * 60000);
    }
  }

  var title = buildTitle_(raw, consumed);
  return {
    title: title || '予定',
    start: start,
    end: end,
    allDay: allDay,
    location: location,
    hasExplicitTitle: !!title,
    confidence: judgeConfidence_(dates, times.length > 0, allDayMarked),
    source: raw.trim()
  };
}

/**
 * 「これは予定の告知か、ただの会話か」の目安。
 * キーワードなしで投稿を拾うとき、どこから反応するかの閾値に使う。
 *   high   … 明示的な日付があり、時刻または終日の指定もある（例: 9/15 14:00 打合せ）
 *   medium … 明示的な日付だけ、または「15日」「月曜」＋時刻
 *   low    … 時刻だけ、または「15日」「月曜」だけ
 */
function judgeConfidence_(dates, hasTime, allDayMarked) {
  var strength = dates.length ? dates[0].strength : 'none';
  if (strength === 'strong' && (hasTime || allDayMarked)) return 'high';
  if (strength === 'strong' || (strength === 'weak' && hasTime)) return 'medium';
  return 'low';
}

/**
 * メッセージ全体を解析する。複数行それぞれが独立した予定になっている場合は
 * 行ごとに分割して複数件を返す。
 * @return {Array<Object>}
 */
function parseSchedules(text, now, options) {
  var raw = String(text == null ? '' : text);
  var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });

  if (lines.length > 1) {
    var perLine = [];
    for (var i = 0; i < lines.length; i++) {
      var parsed = parseSchedule(lines[i], now, options);
      if (parsed) perLine.push(parsed);
    }
    // 2 行以上が独立した予定として成立するときだけ複数件とみなす
    if (perLine.length >= 2) return perLine;
  }

  var whole = parseSchedule(raw, now, options);
  return whole ? [whole] : [];
}

/* Node からテストできるようにエクスポートする（GAS では module が未定義なので無視される） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSchedule: parseSchedule,
    parseSchedules: parseSchedules,
    normalizeForParse_: normalizeForParse_,
    PARSER_CONFIG: PARSER_CONFIG
  };
}

/* ================================================================== *
 * Config.gs
 * ================================================================== */

/**
 * Config.gs
 * スクリプトプロパティから設定を読み出す。
 * 値はすべて「プロジェクトの設定 > スクリプト プロパティ」で登録する（コードに直接書かない）。
 */

var PROP = {
  ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN', // 必須: Messaging API のチャネルアクセストークン
  WEBHOOK_TOKEN: 'WEBHOOK_TOKEN',            // 必須: Webhook URL に付ける合言葉
  CALENDAR_ID: 'CALENDAR_ID',                // 既定の登録先カレンダー（省略時は primary）
  SOURCE_CALENDAR_MAP: 'SOURCE_CALENDAR_MAP',// {"<LINEのID>":"<カレンダーID>"} の JSON
  ALLOWED_SOURCE_IDS: 'ALLOWED_SOURCE_IDS',  // 許可する LINE の ID（カンマ区切り、空なら全許可）
  GROUP_TRIGGER: 'GROUP_TRIGGER',            // 付けると確認なしで即登録するキーワード（既定: 予定）
  CONFIRM_BEFORE_CREATE: 'CONFIRM_BEFORE_CREATE', // group（既定） / always / never
  GROUP_MIN_CONFIDENCE: 'GROUP_MIN_CONFIDENCE',   // グループで拾い始める確からしさ high（既定）/ medium / low
  DEFAULT_DURATION: 'DEFAULT_DURATION_MINUTES',
  LAST_EVENTS: 'LAST_EVENTS'                 // 「取消」用に直前の登録内容を保持する内部キー
};

function getProps_() {
  return PropertiesService.getScriptProperties();
}

function getConfig_() {
  var p = getProps_();
  var duration = parseInt(p.getProperty(PROP.DEFAULT_DURATION), 10);
  return {
    accessToken: p.getProperty(PROP.ACCESS_TOKEN) || '',
    webhookToken: p.getProperty(PROP.WEBHOOK_TOKEN) || '',
    calendarId: p.getProperty(PROP.CALENDAR_ID) || 'primary',
    sourceCalendarMap: parseJsonProperty_(p.getProperty(PROP.SOURCE_CALENDAR_MAP)),
    allowedSourceIds: (p.getProperty(PROP.ALLOWED_SOURCE_IDS) || '')
      .split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; }),
    groupTrigger: p.getProperty(PROP.GROUP_TRIGGER) || '予定',
    confirmBeforeCreate: p.getProperty(PROP.CONFIRM_BEFORE_CREATE) || 'group',
    groupMinConfidence: p.getProperty(PROP.GROUP_MIN_CONFIDENCE) || 'high',
    defaultDurationMinutes: isNaN(duration) ? PARSER_CONFIG.defaultDurationMinutes : duration,
    timeZone: Session.getScriptTimeZone() || 'Asia/Tokyo'
  };
}

function parseJsonProperty_(value) {
  if (!value) return {};
  try {
    var parsed = JSON.parse(value);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    console.warn('スクリプトプロパティの JSON を解釈できませんでした: ' + err);
    return {};
  }
}

/** 設定が揃っているか確認する。GAS エディタから直接実行して確認できる。 */
function checkConfiguration() {
  var cfg = getConfig_();
  var problems = [];
  if (!cfg.accessToken) problems.push(PROP.ACCESS_TOKEN + ' が未設定です。');
  if (!cfg.webhookToken) problems.push(PROP.WEBHOOK_TOKEN + ' が未設定です。');
  try {
    resolveCalendar_(cfg.calendarId);
  } catch (err) {
    problems.push('カレンダー "' + cfg.calendarId + '" を開けません: ' + err.message);
  }
  var message = problems.length
    ? '設定に問題があります:\n - ' + problems.join('\n - ')
    : '設定は正常です。タイムゾーン: ' + cfg.timeZone + ' / 既定カレンダー: ' + cfg.calendarId;
  console.log(message);
  return message;
}

/* ================================================================== *
 * LineClient.gs
 * ================================================================== */

/**
 * LineClient.gs
 * LINE Messaging API への送信をまとめる。
 */

var LINE_API = {
  REPLY: 'https://api.line.me/v2/bot/message/reply',
  PUSH: 'https://api.line.me/v2/bot/message/push'
};

/** 返信トークンを使って応答する（1 回のみ・約30秒間有効）。 */
function lineReply_(accessToken, replyToken, messages) {
  if (!replyToken || !messages || !messages.length) return;
  return linePost_(LINE_API.REPLY, accessToken, {
    replyToken: replyToken,
    messages: toMessages_(messages)
  });
}

/** 返信トークンが使えない場面（再送・エラー通知など）で使う。 */
function linePush_(accessToken, to, messages) {
  if (!to || !messages || !messages.length) return;
  return linePost_(LINE_API.PUSH, accessToken, {
    to: to,
    messages: toMessages_(messages)
  });
}

/** 文字列はテキストメッセージに、オブジェクトはそのまま送る。1 回の送信は 5 件まで。 */
function toMessages_(messages) {
  var list = Array.isArray(messages) ? messages : [messages];
  return list.slice(0, 5).map(function (m) {
    return (m && typeof m === 'object') ? m : textMessage_(m);
  });
}

function textMessage_(text) {
  var body = String(text);
  // テキストメッセージの上限は 5000 文字
  if (body.length > 4900) body = body.substring(0, 4900) + '…';
  return { type: 'text', text: body };
}

/**
 * 「登録 / やめる」の 2 択を出す確認メッセージ。
 * confirm テンプレートの text は 240 文字まで、postback の data は 300 バイトまで。
 */
function confirmMessage_(altText, text, yesLabel, yesData, noLabel, noData) {
  var body = String(text);
  if (body.length > 240) body = body.substring(0, 239) + '…';
  return {
    type: 'template',
    altText: String(altText).substring(0, 400),
    template: {
      type: 'confirm',
      text: body,
      actions: [
        { type: 'postback', label: yesLabel, data: yesData, displayText: yesLabel },
        { type: 'postback', label: noLabel, data: noData, displayText: noLabel }
      ]
    }
  };
}

function linePost_(url, accessToken, payload) {
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('LINE API エラー ' + code + ': ' + res.getContentText());
  }
  return code;
}

/* ================================================================== *
 * CalendarService.gs
 * ================================================================== */

/**
 * CalendarService.gs
 * Google カレンダーへの登録・照会・取り消しを行う。
 */

function resolveCalendar_(calendarId) {
  var cal = (!calendarId || calendarId === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error('カレンダーが見つかりません: ' + calendarId);
  return cal;
}

/** LINE のトーク（個人／グループ）ごとに登録先カレンダーを切り替える。 */
function calendarIdForSource_(cfg, sourceId) {
  if (sourceId && cfg.sourceCalendarMap[sourceId]) return cfg.sourceCalendarMap[sourceId];
  return cfg.calendarId;
}

/**
 * 解析済みの予定をカレンダーに登録する。
 * @return {{id: string, calendarId: string}}
 */
function createEventFromSchedule_(calendarId, schedule, note) {
  var cal = resolveCalendar_(calendarId);
  var event;
  if (schedule.allDay) {
    var days = Math.round((schedule.end - schedule.start) / 86400000);
    event = (days <= 1)
      ? cal.createAllDayEvent(schedule.title, schedule.start)
      // createAllDayEvent の終了日は排他的（9/15-9/17 なら 9/18 を渡す）
      : cal.createAllDayEvent(schedule.title, schedule.start, schedule.end);
  } else {
    event = cal.createEvent(schedule.title, schedule.start, schedule.end);
  }
  if (schedule.location) event.setLocation(schedule.location);
  event.setDescription(buildDescription_(schedule, note));
  return { id: event.getId(), calendarId: cal.getId() };
}

function buildDescription_(schedule, note) {
  var lines = ['LINE から自動登録しました。'];
  if (note) lines.push(note);
  if (schedule.source) lines.push('', '--- 元のメッセージ ---', schedule.source);
  return lines.join('\n');
}

/** 指定期間の予定を取得する。 */
function listUpcomingEvents_(calendarId, from, to) {
  return resolveCalendar_(calendarId).getEvents(from, to);
}

/** 登録済みの予定を削除する。存在しない場合は false。 */
function deleteEventById_(calendarId, eventId) {
  var cal = resolveCalendar_(calendarId);
  var event = cal.getEventById(eventId);
  if (!event) return false;
  event.deleteEvent();
  return true;
}

/* ------------------------------------------------------------------ *
 * 「取消」用の直前登録の記録
 * ------------------------------------------------------------------ */

function rememberLastEvents_(sourceId, calendarId, eventIds) {
  if (!sourceId || !eventIds.length) return;
  var props = getProps_();
  var map = parseJsonProperty_(props.getProperty(PROP.LAST_EVENTS));
  map[sourceId] = { calendarId: calendarId, eventIds: eventIds, at: new Date().toISOString() };
  props.setProperty(PROP.LAST_EVENTS, JSON.stringify(trimLastEvents_(map)));
}

function takeLastEvents_(sourceId) {
  var props = getProps_();
  var map = parseJsonProperty_(props.getProperty(PROP.LAST_EVENTS));
  var entry = map[sourceId];
  if (!entry) return null;
  delete map[sourceId];
  props.setProperty(PROP.LAST_EVENTS, JSON.stringify(map));
  return entry;
}

/** スクリプトプロパティが肥大化しないよう、新しい順に 50 トークまでに保つ。 */
function trimLastEvents_(map) {
  var keys = Object.keys(map);
  if (keys.length <= 50) return map;
  keys.sort(function (a, b) { return String(map[b].at).localeCompare(String(map[a].at)); });
  var trimmed = {};
  keys.slice(0, 50).forEach(function (k) { trimmed[k] = map[k]; });
  return trimmed;
}

/* ------------------------------------------------------------------ *
 * 確認待ちの予定（ボタンを押すまで登録しない）
 * ------------------------------------------------------------------ */

var PENDING_TTL_SECONDS = 21600; // CacheService の上限（6時間）

/**
 * 解析済みの予定を一時保存し、postback に載せる短いキーを返す。
 * postback の data は 300 バイトまでなので、本体はキャッシュに置いてキーだけ渡す。
 */
function storePendingSchedules_(sourceId, schedules) {
  var key = 'pending_' + Utilities.getUuid().replace(/-/g, '').substring(0, 20);
  var payload = {
    sourceId: sourceId,
    schedules: schedules.map(function (s) {
      return {
        title: s.title, start: s.start.toISOString(), end: s.end.toISOString(),
        allDay: s.allDay, location: s.location, source: s.source
      };
    })
  };
  CacheService.getScriptCache().put(key, JSON.stringify(payload), PENDING_TTL_SECONDS);
  return key;
}

/** 一時保存した予定を取り出して消す（二重登録を防ぐため取り出しは 1 回だけ）。 */
function takePendingSchedules_(key) {
  if (!key) return null;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(key);
  if (!raw) return null;
  cache.remove(key);
  var data = JSON.parse(raw);
  data.schedules = data.schedules.map(function (s) {
    return {
      title: s.title, start: new Date(s.start), end: new Date(s.end),
      allDay: s.allDay, location: s.location, source: s.source
    };
  });
  return data;
}

/* ================================================================== *
 * Commands.gs
 * ================================================================== */

/**
 * Commands.gs
 * 受信テキストを「コマンド」か「予定登録」に振り分け、返信メッセージを組み立てる。
 *
 * 投稿の拾い方は 3 通り:
 *   1. 先頭キーワード（既定「予定」）付き … 確認なしで即登録
 *   2. 個人トーク                        … 解析できれば即登録
 *   3. グループの通常の投稿              … 日時らしきものを見つけたら確認ボタンを出す
 */

var MAX_EVENTS_PER_MESSAGE = 10;
var CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

var COMMAND_WORDS = {
  help: ['ヘルプ', 'help', 'Help', 'HELP', '使い方', '?', '？'],
  list: ['一覧', '予定一覧', '直近', '今週の予定', 'list'],
  cancel: ['取消', '取り消し', 'とりけし', 'キャンセル', 'undo', '元に戻す'],
  id: ['ID', 'id', 'Id', 'アイディー', 'トークID']
};

function matchCommand_(text) {
  var t = String(text).trim();
  for (var name in COMMAND_WORDS) {
    if (COMMAND_WORDS[name].indexOf(t) >= 0) return name;
  }
  return null;
}

/**
 * テキストメッセージ 1 件を処理する。
 * @return {Array} 返信するメッセージ（空配列なら無反応）
 */
function handleTextMessage_(cfg, ctx, text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return [];

  var command = matchCommand_(trimmed);
  if (command) return runCommand_(cfg, ctx, command);

  // 先頭キーワード付きの投稿は登録する意図が明確なので、確認を挟まない
  var trigger = cfg.groupTrigger;
  var explicit = !!trigger && trimmed.indexOf(trigger) === 0;
  var body = trimmed;
  if (explicit) {
    body = trimmed.substring(trigger.length).replace(/^[\s:：、。]+/, '');
    var nested = matchCommand_(body);
    if (nested) return runCommand_(cfg, ctx, nested);
  }

  var schedules = parseSchedules(body, new Date(), {
    defaultDurationMinutes: cfg.defaultDurationMinutes
  });

  // 会話に割り込まないよう、案内を返すのはキーワード付きか個人トークのときだけにする
  var mayAnswerPlainly = explicit || !ctx.isGroup;

  if (!schedules.length) {
    return mayAnswerPlainly ? [textMessage_(hintText_())] : [];
  }
  if (schedules.length > MAX_EVENTS_PER_MESSAGE) {
    return mayAnswerPlainly ? [textMessage_(
      '一度に登録できるのは ' + MAX_EVENTS_PER_MESSAGE + ' 件までです（' +
      schedules.length + ' 件ありました）。分けて送ってください。')] : [];
  }
  if (!passesConfidenceGate_(cfg, ctx, explicit, schedules)) return [];

  if (needsConfirmation_(cfg, ctx, explicit)) {
    return [buildConfirmMessage_(cfg, ctx, schedules)];
  }
  return registerSchedules_(cfg, ctx, schedules);
}

/** 確認ボタンの応答（postback）を処理する。 */
function handlePostback_(cfg, ctx, data) {
  var params = parsePostbackData_(data);

  if (params.action === 'dismiss') {
    takePendingSchedules_(params.key);
    return [textMessage_('登録しませんでした。')];
  }
  if (params.action !== 'create') return [];

  var pending = takePendingSchedules_(params.key);
  if (!pending) {
    return [textMessage_('この確認は期限切れです（6時間）。お手数ですがもう一度投稿してください。')];
  }
  // 確認を出したトーク以外からの応答は受け付けない
  if (pending.sourceId !== ctx.sourceId) {
    console.warn('確認の応答元が一致しません: ' + ctx.sourceId);
    return [];
  }
  return registerSchedules_(cfg, ctx, pending.schedules);
}

function parsePostbackData_(data) {
  var out = {};
  String(data || '').split('&').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i < 0) return;
    out[decodeURIComponent(pair.substring(0, i))] = decodeURIComponent(pair.substring(i + 1));
  });
  return out;
}

function runCommand_(cfg, ctx, command) {
  if (command === 'help') return [textMessage_(helpText_(cfg, ctx))];
  if (command === 'id') return [textMessage_('このトークの ID です。\n' + ctx.sourceId +
    '\n\nスクリプトプロパティの ' + PROP.SOURCE_CALENDAR_MAP + ' や ' +
    PROP.ALLOWED_SOURCE_IDS + ' に貼り付けて使います。')];
  if (command === 'list') return [textMessage_(upcomingText_(cfg, ctx))];
  if (command === 'cancel') return [textMessage_(cancelText_(cfg, ctx))];
  return [];
}

/* ------------------------------------------------------------------ *
 * 拾うかどうかの判断
 * ------------------------------------------------------------------ */

/**
 * キーワードなしでグループの投稿を拾うときだけ、確からしさで足切りする。
 * 既定は high（明示的な日付＋時刻または終日）なので、
 * 「15日分の請求書」「10時には着きます」程度では反応しない。
 */
function passesConfidenceGate_(cfg, ctx, explicit, schedules) {
  if (explicit || !ctx.isGroup) return true;
  var need = CONFIDENCE_RANK[cfg.groupMinConfidence];
  if (need === undefined) need = CONFIDENCE_RANK.high;
  for (var i = 0; i < schedules.length; i++) {
    if ((CONFIDENCE_RANK[schedules[i].confidence] || 0) >= need) return true;
  }
  return false;
}

/** 登録前に確認を挟むか。既定はグループのみ。 */
function needsConfirmation_(cfg, ctx, explicit) {
  if (explicit) return false;
  if (cfg.confirmBeforeCreate === 'never') return false;
  if (cfg.confirmBeforeCreate === 'always') return true;
  return ctx.isGroup;
}

function buildConfirmMessage_(cfg, ctx, schedules) {
  var key = storePendingSchedules_(ctx.sourceId, schedules);
  var lines = schedules.slice(0, 3).map(function (s) { return formatSchedule_(s, cfg.timeZone); });
  if (schedules.length > 3) lines.push('…ほか ' + (schedules.length - 3) + ' 件');
  return confirmMessage_(
    '予定を登録しますか？',
    'この予定を登録しますか？\n\n' + lines.join('\n\n'),
    '登録', 'action=create&key=' + key,
    'やめる', 'action=dismiss&key=' + key
  );
}

/* ------------------------------------------------------------------ *
 * 予定登録
 * ------------------------------------------------------------------ */

function registerSchedules_(cfg, ctx, schedules) {
  var calendarId = calendarIdForSource_(cfg, ctx.sourceId);
  var created = [];
  var lines = [];
  var failed = [];

  for (var i = 0; i < schedules.length; i++) {
    try {
      var ref = createEventFromSchedule_(calendarId, schedules[i], '登録元: ' + ctx.sourceId);
      created.push(ref.id);
      lines.push(formatSchedule_(schedules[i], cfg.timeZone));
    } catch (err) {
      console.error('予定の登録に失敗: ' + err);
      failed.push(schedules[i].title + '（' + err.message + '）');
    }
  }

  if (!created.length) {
    return [textMessage_('カレンダーに登録できませんでした。\n' + failed.join('\n'))];
  }

  rememberLastEvents_(ctx.sourceId, calendarId, created);

  var head = created.length === 1 ? '✅ 登録しました' : '✅ ' + created.length + '件 登録しました';
  var text = head + '\n\n' + lines.join('\n\n');
  if (failed.length) text += '\n\n⚠️ 登録できなかったもの\n' + failed.join('\n');
  text += '\n\n違っていたら「取消」と送ってください。';
  text += '\n' + calendarDayUrl_(schedules[0].start, cfg.timeZone);
  return [textMessage_(text)];
}

/* ------------------------------------------------------------------ *
 * 一覧・取消
 * ------------------------------------------------------------------ */

function upcomingText_(cfg, ctx) {
  var calendarId = calendarIdForSource_(cfg, ctx.sourceId);
  var from = new Date();
  var to = new Date(from.getTime() + 7 * 86400000);
  var events = listUpcomingEvents_(calendarId, from, to);
  if (!events.length) return 'これから 7 日間の予定はありません。';

  var lines = events.slice(0, 20).map(function (ev) {
    return formatSchedule_({
      title: ev.getTitle(),
      start: ev.getStartTime(),
      end: ev.getEndTime(),
      allDay: ev.isAllDayEvent(),
      location: ev.getLocation()
    }, cfg.timeZone);
  });
  var text = '📅 これから 7 日間の予定（' + events.length + '件）\n\n' + lines.join('\n\n');
  if (events.length > 20) text += '\n\n…ほか ' + (events.length - 20) + ' 件';
  return text;
}

function cancelText_(cfg, ctx) {
  var entry = takeLastEvents_(ctx.sourceId);
  if (!entry) return '取り消せる登録がありません。（取り消せるのは直前に登録した分だけです）';

  var removed = 0;
  for (var i = 0; i < entry.eventIds.length; i++) {
    try {
      if (deleteEventById_(entry.calendarId, entry.eventIds[i])) removed++;
    } catch (err) {
      console.error('予定の削除に失敗: ' + err);
    }
  }
  if (!removed) return '対象の予定が見つかりませんでした。すでに削除されている可能性があります。';
  return '🗑 直前に登録した ' + removed + ' 件を取り消しました。';
}

/* ------------------------------------------------------------------ *
 * 表示用の整形
 * ------------------------------------------------------------------ */

function formatSchedule_(schedule, tz) {
  var lines = [];
  if (schedule.allDay) {
    // 終日予定の終了日は排他的なので、表示は 1 日戻す
    var lastDay = new Date(schedule.end.getTime() - 86400000);
    var span = formatDateJp_(schedule.start, tz);
    if (lastDay.getTime() > schedule.start.getTime()) {
      span += ' 〜 ' + formatDateJp_(lastDay, tz);
    }
    lines.push('🗓 ' + span + ' 終日');
  } else {
    var head = '🗓 ' + formatDateJp_(schedule.start, tz) + ' ' + formatTime_(schedule.start, tz);
    head += '-' + formatTime_(schedule.end, tz);
    if (!isSameDay_(schedule.start, schedule.end, tz)) {
      head += '（' + formatDateJp_(schedule.end, tz) + '）';
    }
    lines.push(head);
  }
  lines.push('　' + (schedule.title || '予定'));
  if (schedule.location) lines.push('　📍 ' + schedule.location);
  return lines.join('\n');
}

function formatDateJp_(date, tz) {
  var y = Number(Utilities.formatDate(date, tz, 'yyyy'));
  var m = Number(Utilities.formatDate(date, tz, 'M'));
  var d = Number(Utilities.formatDate(date, tz, 'd'));
  var w = WEEKDAY_LABEL[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return m + '/' + d + '(' + w + ')';
}

function formatTime_(date, tz) {
  return Utilities.formatDate(date, tz, 'HH:mm');
}

function isSameDay_(a, b, tz) {
  return Utilities.formatDate(a, tz, 'yyyyMMdd') === Utilities.formatDate(b, tz, 'yyyyMMdd');
}

function calendarDayUrl_(date, tz) {
  return 'https://calendar.google.com/calendar/r/day/' + Utilities.formatDate(date, tz, 'yyyy/M/d');
}

function hintText_() {
  return '日付を読み取れませんでした。\n例）9/15 14:00 現場打合せ @仙台営業所\n\n「ヘルプ」で書き方を確認できます。';
}

function helpText_(cfg, ctx) {
  var lines = ['📝 予定の登録のしかた', ''];
  if (ctx.isGroup) {
    lines.push(
      'このグループの投稿から日時を見つけたら、「登録しますか？」と確認します。',
      '「登録」を押したときだけカレンダーに入ります。',
      '確認なしですぐ登録したいときは、先頭に「' + cfg.groupTrigger + '」を付けてください。');
  } else {
    lines.push('そのままメッセージを送ると登録します。');
  }
  return lines.concat([
    '',
    '【例】',
    '9/15 14:00 現場打合せ @仙台営業所',
    '9月15日(火) 10時〜12時 配筋検査',
    '明日 8時 朝礼',
    '来週金曜 終日 社内研修',
    '9/15-9/17 出張',
    '',
    '【書き方】',
    '・日付… 9/15、9月15日、明日、来週火曜、20日',
    '・時刻… 14:00、14時、14時半、10時〜12時、午後3時',
    '・場所… @のあとに書く / 場所：〇〇',
    '・終了時刻がなければ ' + cfg.defaultDurationMinutes + ' 分、時刻がなければ終日で登録します',
    '・午前/午後の指定がない 1〜' + PARSER_CONFIG.pmShiftMaxHour + '時は午後として扱います',
    '',
    '【コマンド】',
    '・一覧 … これから 7 日間の予定',
    '・取消 … 直前の登録を取り消す',
    '・ID … このトークの ID を表示（設定用）'
  ]).join('\n');
}

/* ================================================================== *
 * Webhook.gs
 * ================================================================== */

/**
 * Webhook.gs
 * LINE Messaging API の Webhook 受け口。
 *
 * 【署名検証について】
 * LINE は X-Line-Signature ヘッダで署名を送るが、Apps Script のウェブアプリは
 * doPost(e) にリクエストヘッダを渡さないため、GAS 単体では署名検証ができない。
 * 代わりに Webhook URL のクエリに合言葉（WEBHOOK_TOKEN）を付け、それを検証する。
 *   例）https://script.google.com/macros/s/xxxxx/exec?token=<WEBHOOK_TOKEN>
 * URL 自体が秘密になるので、公開リポジトリや外部には貼らないこと。
 */

function doPost(e) {
  try {
    var cfg = getConfig_();

    if (!cfg.webhookToken) {
      console.error(PROP.WEBHOOK_TOKEN + ' が未設定のため受信を拒否しました。');
      return jsonOutput_({ ok: false });
    }
    if (!e || !e.parameter || e.parameter.token !== cfg.webhookToken) {
      console.warn('合言葉が一致しないリクエストを破棄しました。');
      return jsonOutput_({ ok: false });
    }
    if (!e.postData || !e.postData.contents) {
      return jsonOutput_({ ok: true }); // Webhook 検証など本文なしのリクエスト
    }

    var body = JSON.parse(e.postData.contents);
    var events = body.events || [];
    for (var i = 0; i < events.length; i++) {
      try {
        handleWebhookEvent_(cfg, events[i]);
      } catch (err) {
        console.error('イベント処理でエラー: ' + (err && err.stack ? err.stack : err));
      }
    }
  } catch (err) {
    // LINE の再送を招かないよう、失敗してもログだけ残して 200 を返す
    console.error('Webhook 処理でエラー: ' + (err && err.stack ? err.stack : err));
  }
  return jsonOutput_({ ok: true });
}

/** 動作確認用。ブラウザで開くと状態だけ返す。 */
function doGet() {
  return jsonOutput_({ ok: true, service: 'line-calendar-bot' });
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ *
 * イベント処理
 * ------------------------------------------------------------------ */

function handleWebhookEvent_(cfg, event) {
  if (isDuplicateEvent_(event)) {
    console.log('再送イベントを無視しました: ' + event.webhookEventId);
    return;
  }

  var ctx = sourceContext_(event);

  if (event.type === 'join' || event.type === 'follow') {
    lineReply_(cfg.accessToken, event.replyToken, [helpText_(cfg, ctx)]);
    return;
  }
  var isText = event.type === 'message' && event.message && event.message.type === 'text';
  var isPostback = event.type === 'postback' && event.postback;
  if (!isText && !isPostback) return; // スタンプ・画像などは対象外

  if (!isAllowedSource_(cfg, ctx)) {
    console.warn('許可されていないトークからの受信: ' + ctx.sourceId);
    lineReply_(cfg.accessToken, event.replyToken,
      ['このトークからの登録は許可されていません。\n管理者に次の ID を伝えてください。\n' + ctx.sourceId]);
    return;
  }

  var replies = isPostback
    ? handlePostback_(cfg, ctx, event.postback.data)
    : handleTextMessage_(cfg, ctx, event.message.text);
  if (replies.length) lineReply_(cfg.accessToken, event.replyToken, replies);
}

function sourceContext_(event) {
  var src = (event && event.source) || {};
  return {
    sourceId: src.groupId || src.roomId || src.userId || '',
    userId: src.userId || '',
    isGroup: !!(src.groupId || src.roomId)
  };
}

function isAllowedSource_(cfg, ctx) {
  if (!cfg.allowedSourceIds.length) return true;
  if (cfg.allowedSourceIds.indexOf(ctx.sourceId) >= 0) return true;
  // グループ内の個人 ID で許可されている場合も通す
  return !!ctx.userId && cfg.allowedSourceIds.indexOf(ctx.userId) >= 0;
}

/**
 * LINE は配信に失敗すると同じイベントを再送する。二重登録を防ぐため
 * webhookEventId を 6 時間キャッシュして重複を弾く。
 */
function isDuplicateEvent_(event) {
  var id = event && event.webhookEventId;
  if (!id) return false;
  var cache = CacheService.getScriptCache();
  var key = 'line_evt_' + id;
  if (cache.get(key)) return true;
  cache.put(key, '1', 21600); // CacheService の上限は 6 時間
  return false;
}

/* ================================================================== *
 * Tests.gs
 * ================================================================== */

/**
 * Tests.gs
 * GAS エディタから runParserTests() を実行すると、解析ロジックの動作を確認できる。
 * （同じ内容はローカルでも `node test/run.js` で実行できる）
 */

function runParserTests() {
  var base = new Date(2026, 8, 13, 10, 0, 0); // 2026-09-13(日) 10:00
  var cases = [
    ['9/15 14:00 現場打合せ', '2026-09-15 14:00', '2026-09-15 15:00', '現場打合せ', ''],
    ['9月15日(火) 10時〜12時 配筋検査', '2026-09-15 10:00', '2026-09-15 12:00', '配筋検査', ''],
    ['明日 8時 朝礼', '2026-09-14 08:00', '2026-09-14 09:00', '朝礼', ''],
    ['来週金曜 14:00 引渡し @現場事務所', '2026-09-18 14:00', '2026-09-18 15:00', '引渡し', '現場事務所'],
    ['9/15 終日 社内研修', '2026-09-15 00:00', '2026-09-16 00:00', '社内研修', ''],
    ['9/15-9/17 出張', '2026-09-15 00:00', '2026-09-18 00:00', '出張', ''],
    ['9/15 午後3時 打合せ', '2026-09-15 15:00', '2026-09-15 16:00', '打合せ', ''],
    ['9/15 2時 打合せ', '2026-09-15 14:00', '2026-09-15 15:00', '打合せ', '']
  ];

  var pass = 0;
  var failures = [];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var r = parseSchedule(c[0], base);
    if (!r) { failures.push(c[0] + ' → 解析できませんでした'); continue; }
    var actual = [fmtForTest_(r.start), fmtForTest_(r.end), r.title, r.location].join(' | ');
    var expected = [c[1], c[2], c[3], c[4]].join(' | ');
    if (actual === expected) pass++;
    else failures.push(c[0] + '\n  期待: ' + expected + '\n  実際: ' + actual);
  }

  var summary = '成功 ' + pass + ' / ' + cases.length;
  if (failures.length) summary += '\n--- 失敗 ---\n' + failures.join('\n');
  console.log(summary);
  return summary;
}

function fmtForTest_(d) {
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 解析だけを試す（カレンダーには登録しない）。文字列を渡して結果をログで確認する。 */
function tryParse(text) {
  var cfg = getConfig_();
  var list = parseSchedules(text || '9/15 14:00 現場打合せ @仙台営業所', new Date(), {
    defaultDurationMinutes: cfg.defaultDurationMinutes
  });
  if (!list.length) { console.log('解析できませんでした。'); return '解析できませんでした。'; }
  var out = list.map(function (s) { return formatSchedule_(s, cfg.timeZone); }).join('\n\n');
  console.log(out);
  return out;
}
