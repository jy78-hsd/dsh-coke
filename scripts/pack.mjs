/**
 * 打发布包（npm tarball）：`node scripts/pack.mjs`
 *
 * 产物在 dist/dsh-coke-<version>.tgz，内容按 package.json 的 files 白名单收敛。
 * 这个 tarball 既能 `pnpm add <file>` 本地安装，也是 `npm publish` 的对象。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const DIST = join(PKG_ROOT, 'dist');

/** 找 pnpm：环境变量 → PATH 上的 pnpm → DSH 运行时里自带的那份。 */
function findPnpm() {
  if (process.env.DSH_PNPM && existsSync(process.env.DSH_PNPM)) {
    return { cmd: process.execPath, args: [process.env.DSH_PNPM] };
  }
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
  if (existsSync(runtimePnpm)) return { cmd: process.execPath, args: [runtimePnpm] };
  return { cmd: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] };
}

const { cmd, args } = findPnpm();
mkdirSync(DIST, { recursive: true });

console.log('打包', pkg.name + '@' + pkg.version, '→', DIST);
execFileSync(cmd, [...args, 'pack', '--pack-destination', DIST], {
  cwd: PKG_ROOT,
  stdio: 'inherit',
});

const tarballs = readdirSync(DIST).filter((name) => name.endsWith('.tgz'));
const latest = tarballs
  .map((name) => ({ name, at: statSync(join(DIST, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at)[0];
if (!latest) {
  console.error('没找到产出的 tgz');
  process.exit(1);
}
const size = statSync(join(DIST, latest.name)).size;
console.log('\n✓ 产物：' + join(DIST, latest.name) + '  (' + (size / 1024 / 1024).toFixed(2) + ' MB)');
console.log('  本地装：dsh plugin --profile desktop add ' + join(DIST, latest.name));
console.log('  发 npm：npm publish ' + join(DIST, latest.name) + ' --access public');
