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
  var list = parseSchedules(text || '9/15 14:00 現場打合せ @現場事務所', new Date(), {
    defaultDurationMinutes: cfg.defaultDurationMinutes
  });
  if (!list.length) { console.log('解析できませんでした。'); return '解析できませんでした。'; }
  var out = list.map(function (s) { return formatSchedule_(s, cfg.timeZone); }).join('\n\n');
  console.log(out);
  return out;
}
