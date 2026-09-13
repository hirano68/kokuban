/**
 * Parser.gs のテスト。`node test/run.js` で実行する。
 * GAS のエディタからは Tests.gs の runParserTests() で同等の確認ができる。
 */
process.env.TZ = 'Asia/Tokyo';

const path = require('path');
const { parseSchedule, parseSchedules } = require(path.join(__dirname, '..', 'src', 'Parser.gs'));

// 2026-09-13(日) 10:00 を基準時刻として固定
const BASE = new Date(2026, 8, 13, 10, 0, 0);

let pass = 0;
const failures = [];

function fmt(d) {
  if (!d) return String(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function check(label, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    failures.push(`${label}\n    expected: ${expected}\n    actual:   ${actual}`);
  }
}

/**
 * @param {string} text 入力
 * @param {object} want {start, end, title, location, allDay}
 */
function t(text, want) {
  const r = parseSchedule(text, BASE);
  if (!r) {
    if (want === null) { pass++; return; }
    failures.push(`「${text}」\n    expected: ${JSON.stringify(want)}\n    actual:   null (解析できず)`);
    return;
  }
  if (want === null) {
    failures.push(`「${text}」\n    expected: null\n    actual:   ${fmt(r.start)}〜${fmt(r.end)} "${r.title}"`);
    return;
  }
  if (want.start !== undefined) check(`「${text}」 start`, fmt(r.start), want.start);
  if (want.end !== undefined) check(`「${text}」 end`, fmt(r.end), want.end);
  if (want.title !== undefined) check(`「${text}」 title`, r.title, want.title);
  if (want.location !== undefined) check(`「${text}」 location`, r.location, want.location);
  if (want.allDay !== undefined) check(`「${text}」 allDay`, r.allDay, want.allDay);
}

console.log(`基準日時: ${fmt(BASE)} (${['日','月','火','水','木','金','土'][BASE.getDay()]})\n`);

/* ---------- 日付表記 ---------- */
t('9/15 14:00 現場打合せ', { start: '2026-09-15 14:00', end: '2026-09-15 15:00', title: '現場打合せ', allDay: false });
t('9月15日 14時 現場打合せ', { start: '2026-09-15 14:00', title: '現場打合せ' });
t('9月15日(火) 10:00 定例会議', { start: '2026-09-15 10:00', title: '定例会議' });
t('2026/9/15 10:00 着工', { start: '2026-09-15 10:00', title: '着工' });
t('2026年9月15日 10:00 着工', { start: '2026-09-15 10:00', title: '着工' });
t('2026-09-15 10:00 着工', { start: '2026-09-15 10:00', title: '着工' });

/* 年またぎ：基準が9月なので1/10は翌年 */
t('1/10 10:00 新年挨拶', { start: '2027-01-10 10:00', title: '新年挨拶' });
/* 直近の過去（60日以内）は今年のまま */
t('8/20 10:00 完了検査', { start: '2026-08-20 10:00', title: '完了検査' });

/* 日のみ：今月、過ぎていれば翌月 */
t('20日 13:30 検査', { start: '2026-09-20 13:30', title: '検査' });
t('5日 13:30 検査', { start: '2026-10-05 13:30', title: '検査' });

/* ---------- 相対日付 ---------- */
t('今日 15時 打合せ', { start: '2026-09-13 15:00', title: '打合せ' });
t('明日 10時 朝礼', { start: '2026-09-14 10:00', title: '朝礼' });
t('あさって 9時 資材搬入', { start: '2026-09-15 09:00', title: '資材搬入' });

/* 曜日：基準は日曜。月曜単独は翌日(9/14) */
t('月曜 9:00 朝礼', { start: '2026-09-14 09:00', title: '朝礼' });
t('日曜 9:00 点検', { start: '2026-09-13 09:00', title: '点検' });
/* 今週の週は 9/7(月)〜9/13(日)。来週火曜は 9/15 */
t('来週火曜 14:00 打合せ', { start: '2026-09-15 14:00', title: '打合せ' });
t('来週の金曜日 14:00 引渡し', { start: '2026-09-18 14:00', title: '引渡し' });
t('再来週水曜 14:00 検査', { start: '2026-09-23 14:00', title: '検査' });

/* ---------- 時刻表記 ---------- */
t('9/15 14:30-16:00 定例会議', { start: '2026-09-15 14:30', end: '2026-09-15 16:00' });
t('9/15 14時30分から16時まで 定例会議', { start: '2026-09-15 14:30', end: '2026-09-15 16:00', title: '定例会議' });
t('9/15 10時〜12時 安全パトロール', { start: '2026-09-15 10:00', end: '2026-09-15 12:00', title: '安全パトロール' });
t('9/15 14時半 打合せ', { start: '2026-09-15 14:30', end: '2026-09-15 15:30' });
t('9/15 午前10時 打合せ', { start: '2026-09-15 10:00' });
t('9/15 午後3時 打合せ', { start: '2026-09-15 15:00' });
t('9/15 午後1時-3時 打合せ', { start: '2026-09-15 13:00', end: '2026-09-15 15:00' });
/* 午前/午後の指定がない 1〜6時は午後とみなす */
t('9/15 2時 打合せ', { start: '2026-09-15 14:00' });
/* 8時は朝礼とみなしてそのまま */
t('9/15 8時 朝礼', { start: '2026-09-15 08:00' });

/* ---------- 終日・複数日 ---------- */
t('9/15 終日 社内研修', { start: '2026-09-15 00:00', end: '2026-09-16 00:00', allDay: true, title: '社内研修' });
t('9/15 夏季休暇', { start: '2026-09-15 00:00', end: '2026-09-16 00:00', allDay: true, title: '夏季休暇' });
t('9/15-9/17 出張', { start: '2026-09-15 00:00', end: '2026-09-18 00:00', allDay: true, title: '出張' });

/* ---------- 場所 ---------- */
t('9/15 14:00 現場打合せ @仙台営業所', { start: '2026-09-15 14:00', title: '現場打合せ', location: '仙台営業所' });
t('9/15 14:00 現場打合せ 場所：本社3階会議室', { title: '現場打合せ', location: '本社3階会議室' });

/* ---------- 全角入力 ---------- */
t('９／１５　１４：００　現場打合せ　＠仙台', { start: '2026-09-15 14:00', title: '現場打合せ', location: '仙台' });

/* ---------- 件名に数字が混ざるケース ---------- */
t('9/15 10:00 A棟2階 配筋検査', { start: '2026-09-15 10:00', title: 'A棟2階 配筋検査' });
t('9/15 10:00 15号棟 内装打合せ', { start: '2026-09-15 10:00', title: '15号棟 内装打合せ' });

/* ---------- 日付省略（時刻のみ） ---------- */
t('15時 打合せ', { start: '2026-09-13 15:00', title: '打合せ' });
/* 基準は10:00なので 9時 は過ぎている → 翌日 */
t('9時 朝礼', { start: '2026-09-14 09:00', title: '朝礼' });

/* ---------- 件名なし ---------- */
t('9/15 14:00', { title: '予定' });

/* ---------- 解析できないもの ---------- */
t('了解しました', null);
t('お疲れ様です！', null);

/* ---------- 境界的なケース ---------- */
/* 日をまたぐ時間帯 */
t('9/15 23:00-1:00 夜間作業', { start: '2026-09-15 23:00', end: '2026-09-16 01:00', title: '夜間作業' });
/* 年末（年の推定が今年のまま） */
t('12/31 23:00 年越し', { start: '2026-12-31 23:00', end: '2027-01-01 00:00', title: '年越し' });
/* 「3日間」は日付として拾わない */
t('3日間の工程確認', null);
t('9/15 10:00 3日間の工程確認', { start: '2026-09-15 10:00', title: '3日間の工程確認' });
/* 件名は入力どおりの表記を保つ（全角括弧はそのまま） */
t('9/15 10:00 打合せ（仮）', { start: '2026-09-15 10:00', title: '打合せ（仮）' });
/* 助詞が混ざる文章 */
t('会議は9/15の14時から', { start: '2026-09-15 14:00', end: '2026-09-15 15:00', title: '会議' });
t('9/15に打合せ', { start: '2026-09-15 00:00', title: '打合せ', allDay: true });
t('9/15の現場確認 10:00', { start: '2026-09-15 10:00', title: '現場確認' });
/* 助詞に見えても語の一部なら残す */
t('9/15 13:00 はつり工事', { start: '2026-09-15 13:00', title: 'はつり工事' });
t('9/15 のぞみ工務店 打合せ 10:00', { start: '2026-09-15 10:00', title: 'のぞみ工務店 打合せ' });
/* 30分刻み・所要時間の指定なし */
t('9/15 9:30 定例', { start: '2026-09-15 09:30', end: '2026-09-15 10:30', title: '定例' });
/* 24時表記 */
t('9/15 24:00 締切', { start: '2026-09-16 00:00', title: '締切' });
/* 曜日付きの日付表記で曜日が件名に残らない */
t('2026/9/15(火) 10:00 着工', { start: '2026-09-15 10:00', title: '着工' });

/* ---------- 複数件 ---------- */
(function () {
  const list = parseSchedules('9/15 10:00 配筋検査\n9/16 13:00 コンクリート打設', BASE);
  check('複数行 件数', list.length, 2);
  if (list.length === 2) {
    check('複数行 1件目', `${fmt(list[0].start)} ${list[0].title}`, '2026-09-15 10:00 配筋検査');
    check('複数行 2件目', `${fmt(list[1].start)} ${list[1].title}`, '2026-09-16 13:00 コンクリート打設');
  }
})();

(function () {
  // 1件の予定が複数行に分かれている場合は 1 件にまとめる
  const list = parseSchedules('9/15 14:00-16:00\n現場定例会議\n@現場事務所', BASE);
  check('折返し 件数', list.length, 1);
  if (list.length === 1) {
    check('折返し 内容', `${fmt(list[0].start)} ${list[0].title} / ${list[0].location}`,
      '2026-09-15 14:00 現場定例会議 / 現場事務所');
  }
})();

/* ---------- 結果 ---------- */
console.log(`成功: ${pass}  失敗: ${failures.length}`);
if (failures.length) {
  console.log('\n--- 失敗した項目 ---');
  failures.forEach((f) => console.log('  ' + f));
  process.exit(1);
}
console.log('すべて成功しました。');
