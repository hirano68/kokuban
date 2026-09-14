#!/usr/bin/env node
/**
 * Parser のテストを Node.js で実行する。
 *   node chat-to-calendar/test/run.js
 *
 * Apps Script の .gs は普通の JavaScript なので、vm でそのまま読み込める。
 */
'use strict';

process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcDir = path.join(__dirname, '..', 'src');
const sandbox = {
  console,
  Logger: { log: (...args) => console.log(...args) }
};
vm.createContext(sandbox);

for (const file of ['Parser.gs', 'Tests.gs']) {
  const code = fs.readFileSync(path.join(srcDir, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const result = sandbox.Tests.run();
console.log(result.text);
if (result.failures.length) {
  process.exitCode = 1;
}

// dist/Code.gs（貼り付け用の 1 ファイル版）が src と食い違っていないか
const bundler = require('../tools/bundle.js');
const current = fs.existsSync(bundler.outFile) ? fs.readFileSync(bundler.outFile, 'utf8') : '';
if (current !== bundler.build()) {
  console.log('\n❌ dist/Code.gs が src と一致していません。');
  console.log('   node chat-to-calendar/tools/bundle.js を実行してください。');
  process.exitCode = 1;
} else {
  console.log('✅ dist/Code.gs は src と一致しています');
}
