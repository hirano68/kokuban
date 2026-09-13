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

  var dates = [{ date: picked[0].resolve(base), start: picked[0].start, end: picked[0].end }];
  markConsumed_(consumed, picked[0].start, picked[0].end);

  if (picked.length > 1) {
    var gap = norm.substring(picked[0].end, picked[1].start);
    if (/^\s*(?:-|から|より)\s*$/.test(gap)) {
      dates.push({ date: picked[1].resolve(base), start: picked[1].start, end: picked[1].end });
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
    source: raw.trim()
  };
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
