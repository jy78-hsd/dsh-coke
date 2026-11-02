/**
 * 卸载 dsh-coke：从 profile 的 dependencies / dsh.profile.bundles 摘掉，并删除已复制的包。
 *
 * 用法：
 *   node scripts/uninstall.mjs
 *   node scripts/uninstall.mjs --profile web
 *   node scripts/uninstall.mjs --print
 */
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const profileIndex = argv.indexOf('--profile');
const profile = profileIndex >= 0 ? argv[profileIndex + 1] : 'desktop';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', profile);
const MANIFEST = join(PROFILE_DIR, 'package.json');
const DEST = join(PROFILE_DIR, 'node_modules', 'dsh-coke');
const NAME = 'dsh-coke';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(MANIFEST))) {
    console.error('✗ 找不到 ' + MANIFEST);
    process.exit(1);
  }
  const original = await readFile(MANIFEST, 'utf8');
  const manifest = JSON.parse(original);

  const hadDep = manifest.dependencies && Object.hasOwn(manifest.dependencies, NAME);
  if (hadDep) delete manifest.dependencies[NAME];
  const bundles = manifest.dsh?.profile?.bundles;
  const hadBundle = Array.isArray(bundles) && bundles.includes(NAME);
  if (hadBundle) manifest.dsh.profile.bundles = bundles.filter((n) => n !== NAME);

  console.log('profile:', PROFILE_DIR);
  console.log('dependencies 里的 ' + NAME + '：' + (hadDep ? '删除' : '本来就没有'));
  console.log('bundles 里的 ' + NAME + '：' + (hadBundle ? '删除' : '本来就没有'));
  console.log('删除目录：' + DEST);

  if (printOnly) {
    console.log('\n(--print：没有写入任何文件)');
    return;
  }

  if (hadDep || hadBundle) {
    const backup = MANIFEST + '.bak-coke-' + new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(backup, original, 'utf8');
    await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('已备份原 package.json：' + backup);
  }
  await rm(DEST, { recursive: true, force: true });
  console.log('\n✓ 卸载完成，重启 DSH 生效。');
}

main().catch((error) => {
  console.error('✗ ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
