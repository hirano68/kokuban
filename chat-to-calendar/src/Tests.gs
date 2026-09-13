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
      name: '時刻だけなら当日扱い',
      text: 'ミーティングは9:30から',
      expect: [{ when: '2026-09-13 09:30..2026-09-13 10:30', title: 'ミーティング' }]
    },
    { name: '予定でない雑談は無視', text: 'お疲れ様です。了解しました。', expectEmpty: true },
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
