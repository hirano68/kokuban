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
