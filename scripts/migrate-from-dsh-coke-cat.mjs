/**
 * 从旧的 dsh-coke-cat 迁到新的 dsh-coke：
 *  1. 清掉 profile 里旧的依赖 / bundles 条目，删掉 node_modules/dsh-coke-cat
 *  2. 把用户数据（state.json / config.json / 自定义形象 / 窗口位置）搬到 ~/.dsh/dsh-coke
 *
 * 用法：node scripts/migrate-from-dsh-coke-cat.mjs [--print]
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const printOnly = process.argv.includes('--print');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const MANIFEST = join(PROFILE_DIR, 'package.json');
const OLD = 'dsh-coke-cat';
const NEW = 'dsh-coke';
const HOME = join(homedir(), '.dsh');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---- 1. profile 清单 ----
const raw = await readFile(MANIFEST, 'utf8');
const manifest = JSON.parse(raw);
let changed = false;
if (manifest.dependencies && Object.hasOwn(manifest.dependencies, OLD)) {
  delete manifest.dependencies[OLD];
  changed = true;
}
const bundles = manifest.dsh?.profile?.bundles;
if (Array.isArray(bundles) && bundles.includes(OLD)) {
  manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== OLD);
  changed = true;
}
console.log('profile:', PROFILE_DIR);
console.log('旧条目需要清理:', changed ? '是' : '否（本来就没有）');

if (!printOnly) {
  if (changed) {
    const backup = MANIFEST + '.bak-rename-' + new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(backup, raw, 'utf8');
    await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('已备份并改写:', backup);
  }
  const oldPkgDir = join(PROFILE_DIR, 'node_modules', OLD);
  if (await exists(oldPkgDir)) {
    await rm(oldPkgDir, { recursive: true, force: true });
    console.log('已删除旧安装目录:', oldPkgDir);
  }
}

// ---- 2. 用户数据 ----
const oldUser = join(HOME, OLD);
const newUser = join(HOME, NEW);
if (await exists(oldUser)) {
  const files = await readdir(oldUser);
  console.log('旧用户目录里有:', files.join(', '));
  if (!printOnly) {
    await mkdir(newUser, { recursive: true });
    for (const name of files) {
      await cp(join(oldUser, name), join(newUser, name), { force: true });
    }
    console.log('已迁移到:', newUser);
    await rm(oldUser, { recursive: true, force: true });
  }
} else {
  console.log('没有旧用户目录（干净安装）');
}
