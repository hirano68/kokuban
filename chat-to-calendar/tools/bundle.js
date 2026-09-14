#!/usr/bin/env node
/**
 * src/*.gs を 1 つの Code.gs にまとめる。
 *   node chat-to-calendar/tools/bundle.js
 *
 * Apps Script はファイル分割が必須ではなく、すべてのファイルが同じグローバルスコープを
 * 共有する。まとめておけばエディタへの貼り付けが 1 回で済む。
 * 設定をすぐ直せるよう Config を先頭に置く。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ORDER = ['Config.gs', 'Parser.gs', 'Store.gs', 'ChatSource.gs', 'CalendarSync.gs', 'Main.gs', 'Tests.gs'];
const srcDir = path.join(__dirname, '..', 'src');
const outFile = path.join(__dirname, '..', 'dist', 'Code.gs');

const header = [
  '/**',
  ' * chat-to-calendar — Google チャットの予定を Google カレンダーに自動登録する',
  ' *',
  ' * ★このファイルは src/*.gs を 1 つにまとめた自動生成ファイルです。',
  ' *   中身を直すときは src/ 側を直して `node chat-to-calendar/tools/bundle.js` を実行してください。',
  ' *',
  ' * 【最初に直すのはここだけ】',
  ' *   すぐ下の CONFIG_BASE の calendarId / spaces / dryRun',
  ' *',
  ' * 【エディタから実行する関数】',
  ' *   checkSetup      … 設定と接続をまとめて点検する（最初にこれ）',
  ' *   listMySpaces    … 参加中のチャットスペース一覧を出す',
  ' *   previewOnly     … 登録せずに「何が拾われるか」だけ見る',
  ' *   installTriggers … 15分ごとの自動実行を開始する',
  ' *   removeTriggers  … 自動実行を止める',
  ' *   resetState      … 読み込み位置をリセットする',
  ' */',
  ''
].join('\n');

const parts = ORDER.map((name) => {
  const body = fs.readFileSync(path.join(srcDir, name), 'utf8').trimEnd();
  const bar = '// '.padEnd(3, ' ') + '='.repeat(74);
  return [bar, `// ${name}`, bar, '', body, ''].join('\n');
});

const bundle = header + '\n' + parts.join('\n') + '\n';

/** 生成後の中身を返す（テストで「dist が古くないか」を確かめるのに使う）。 */
module.exports = { build: () => bundle, outFile, ORDER };

if (require.main === module) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bundle, 'utf8');
  const kb = (Buffer.byteLength(bundle, 'utf8') / 1024).toFixed(1);
  console.log(`生成: ${path.relative(process.cwd(), outFile)} (${ORDER.length} ファイル / ${kb} KB)`);
}
