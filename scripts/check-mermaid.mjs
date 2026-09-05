#!/usr/bin/env node
/**
 * 校验 docs/ 下所有 markdown 中的 mermaid 代码块能否渲染。
 *
 * 起因：v0.4 的 §3.2 架构图因 `subgraph 引擎适配（可替换）` 未加引号而无法渲染
 * （全角括号需要引号包裹的 subgraph 标题）。肉眼评审抓不住这类问题，用渲染器抓。
 *
 * 用法：node scripts/check-mermaid.mjs
 * 依赖通过 npx 临时获取，不进 package.json；需要本机有 Chromium。
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = globSync('docs/**/*.md');
const tmp = mkdtempSync(join(tmpdir(), 'mmd-'));
writeFileSync(join(tmp, 'pptr.json'), JSON.stringify({ args: ['--no-sandbox', '--disable-setuid-sandbox'] }));

// 复用本机已有的 Chromium（远程执行环境预装于 /opt/pw-browsers）
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  for (const p of globSync('/opt/pw-browsers/chromium*/chrome-linux/chrome')) {
    if (existsSync(p)) { process.env.PUPPETEER_EXECUTABLE_PATH = p; break; }
  }
}

let blocks = 0;
let failed = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8').split('\n');
  let start = -1;
  for (let i = 0; i < src.length; i++) {
    if (start === -1 && src[i].trim() === '```mermaid') { start = i; continue; }
    if (start !== -1 && src[i].trim() === '```') {
      blocks++;
      const body = src.slice(start + 1, i).join('\n');
      const input = join(tmp, `b${blocks}.mmd`);
      writeFileSync(input, body);
      try {
        execFileSync('npx', ['-y', '@mermaid-js/mermaid-cli', '-i', input,
                             '-o', join(tmp, `b${blocks}.svg`), '-p', join(tmp, 'pptr.json')],
                     { stdio: 'pipe' });
        console.log(`ok   ${file}:${start + 1}`);
      } catch (err) {
        failed++;
        console.error(`FAIL ${file}:${start + 1}\n${err.stderr?.toString() ?? err.message}`);
      }
      start = -1;
    }
  }
}
console.log(`\n${blocks} block(s), ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
