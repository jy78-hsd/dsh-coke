/**
 * 上架到插件市场的两步里，**需要你账号**的那一步（npm publish）。
 *
 *   node scripts/publish.mjs            # 只打印清单，不做任何事
 *   node scripts/publish.mjs --yes      # 真的执行 pnpm publish --access public
 *
 * 前置：`npm login`（或设置 NPM_TOKEN）已在这台机器上完成；包名 dsh-coke 在 npm 上还没被占用。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const run = process.argv.includes('--yes');

const runtimePnpm = join(
  homedir(),
  '.dsh',
  'dsh-runtimes',
  'dsh-primary-runtime',
  'dependencies',
  'pnpm',
  'bin',
  'pnpm.mjs',
);
const pnpm = process.env.DSH_PNPM || (existsSync(runtimePnpm) ? runtimePnpm : 'pnpm');

if (run) {
  console.log('发布 ' + pkg.name + '@' + pkg.version + ' 到 npm …');
  execFileSync(process.execPath, [pnpm, 'publish', '--access', 'public', '--no-git-checks'], {
    cwd: PKG_ROOT,
    stdio: 'inherit',
  });
  console.log('\n✓ 发布完成。接下来去 awesome-dsh-plugin 提 PR（见下面第 2 步）。');
  process.exit(0);
}

console.log(`
小猫coke（${pkg.name}@${pkg.version}）上架清单
==============================================

[已完成] 包本身已经按市场要求准备好了：
  · 包名 ${pkg.name}，bundle patch 里的 entry id 也是 ${pkg.name}
  · icon = ${pkg.icon}，LICENSE = MIT
  · dsh.bundle.patch / dsh.client 都声明了
  · dsh.compatibility.dshReleases 标了 0.2.0-rc.1 / rc.2 兼容
  · dist/${pkg.name}-${pkg.version}.tgz 已打好（pnpm pack）

[第 1 步] 发到 npm（要你的 npm 账号，我这边没有凭据）
  npm login                     # 或 export NPM_TOKEN=...
  node scripts/publish.mjs --yes
  # 等价于：pnpm publish --access public --no-git-checks

[第 2 步] 提 PR 到精选列表（市场就是读它）
  https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
  在它的插件列表里加一行（一般一天内站点与市场自动收录）：

  - [${pkg.name}](https://www.npmjs.com/package/${pkg.name}) — 小猫coke：会待在桌面上的猫桌宠，点一下按权重抽 7 句台词、右键能唱歌/换装/枪击，还能查 DeepSeek 余额。

[第 3 步] 上架后自检
  在 DSH 的「插件 → 插件市场」里搜 ${pkg.name}，应能看到卡片并能一键安装。

[跳过第 1、2 步也能装] 直接用打好的包本地安装：
  dsh plugin --profile desktop add ${join(PKG_ROOT, 'dist', pkg.name + '-' + pkg.version + '.tgz')}
`);
