/**
 * src/*.gs をまとめて dist/Code.gs を作る。
 * GAS エディタに手で貼り付けるとき、ファイルを 1 つにしておくと 1 回で済む。
 *
 *   node tools/build-single.js
 */
const fs = require('fs');
const path = require('path');

// 読み込み順。GAS は関数宣言を巻き上げるため順序に依存しないが、読みやすさのために揃える
const ORDER = [
  'Parser.gs',
  'Config.gs',
  'LineClient.gs',
  'CalendarService.gs',
  'Commands.gs',
  'Webhook.gs',
  'Tests.gs'
];

const root = path.join(__dirname, '..');
const header = [
  '/**',
  ' * LINE → Google カレンダー 予定取込 Bot（1ファイル版）',
  ' *',
  ' * このファイルは src/*.gs を結合した自動生成物です。',
  ' * 直接編集せず、src/ を直してから `node tools/build-single.js` で作り直してください。',
  ' *',
  ' * 使い方は README.md を参照。',
  ' */',
  ''
].join('\n');

const body = ORDER.map((name) => {
  const source = fs.readFileSync(path.join(root, 'src', name), 'utf8').trimEnd();
  const rule = '/* ' + '='.repeat(66) + ' *\n * ' + name +
    '\n * ' + '='.repeat(66) + ' */';
  return rule + '\n\n' + source + '\n';
}).join('\n');

const out = path.join(root, 'dist', 'Code.gs');
fs.writeFileSync(out, header + '\n' + body);
console.log(`書き出しました: dist/Code.gs (${ORDER.length} ファイル, ${body.split('\n').length} 行)`);
