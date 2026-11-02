/**
 * 把 dsh-coke 装进 DSH 的 profile（默认 desktop），可以反复执行。
 *
 * 两种来源：
 *   node scripts/install.mjs                    # 开发用：link 到本目录（改代码立刻生效）
 *   node scripts/install.mjs --from <tgz>       # 模拟市场安装：解开 dist 里打好的包，依赖写成 file:<tgz>
 *
 * 都做这三件事：
 *   1. 把包装到 ~/.dsh/profiles/<profile>/node_modules/dsh-coke
 *   2. package.json 的 dependencies 里写 dsh-coke 的来源
 *   3. dsh.profile.bundles 里追加 dsh-coke
 */
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const profileIndex = argv.indexOf('--profile');
const profile = profileIndex >= 0 ? argv[profileIndex + 1] : 'desktop';
if (!profile) throw new Error('--profile 后面要跟 profile 名，例如 desktop');
const fromIndex = argv.indexOf('--from');
const fromTarball = fromIndex >= 0 ? resolve(argv[fromIndex + 1] ?? '') : null;
if (fromIndex >= 0 && !fromTarball) throw new Error('--from 后面要跟 .tgz 路径');

const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', profile);
const MANIFEST = join(PROFILE_DIR, 'package.json');
const DEST = join(PROFILE_DIR, 'node_modules', 'dsh-coke');
const NAME = 'dsh-coke';

function fail(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(PROFILE_DIR))) fail('找不到 profile 目录：' + PROFILE_DIR);
  if (!(await exists(MANIFEST))) fail('找不到 ' + MANIFEST);
  if (fromTarball && !(await exists(fromTarball))) fail('找不到安装包：' + fromTarball);

  const original = await readFile(MANIFEST, 'utf8');
  const manifest = JSON.parse(original);

  manifest.dependencies = manifest.dependencies ?? {};
  // link: 是开发态（指向源码目录）；file:<tgz> 更接近市场安装的样子
  manifest.dependencies[NAME] = fromTarball ? 'file:' + fromTarball.replace(/\\/g, '/') : 'link:' + PKG_ROOT.replace(/\\/g, '/');

  const dsh = (manifest.dsh = manifest.dsh ?? {});
  const prof = (dsh.profile = dsh.profile ?? {});
  prof.bundles = Array.isArray(prof.bundles) ? prof.bundles : [];
  const added = !prof.bundles.includes(NAME);
  if (added) prof.bundles.push(NAME);

  console.log('profile    :', PROFILE_DIR);
  console.log('来源       :', manifest.dependencies[NAME]);
  console.log('安装到     :', DEST);
  console.log('bundles    :', added ? '追加 ' + NAME : '已存在 ' + NAME);

  if (printOnly) {
    console.log('\n(--print：没有写入任何文件)');
    return;
  }

  const backup = MANIFEST + '.bak-coke-' + new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(backup, original, 'utf8');

  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });

  if (fromTarball) {
    // 解开 tgz，取出里面的 package/ 目录（npm tarball 的标准布局）
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-coke-install-'));
    try {
      execFileSync('tar', ['-xzf', fromTarball, '-C', scratch], { stdio: 'ignore' });
      await cp(join(scratch, 'package'), DEST, { recursive: true });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    for (const item of ['lib', 'assets', 'runtime', 'scripts', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
      if (await exists(join(PKG_ROOT, item))) {
        await cp(join(PKG_ROOT, item), join(DEST, item), { recursive: true });
      }
    }
  }

  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('\n✓ 装好了。备份：' + backup);
  console.log('  重启 DSH 后，桌面右下角会自动出现这只猫（默认桌面窗口模式）。');
  console.log('  想换位置/模式/卸载：设置 → 小猫coke');
  console.log('  命令行卸载：node scripts/uninstall.mjs');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
