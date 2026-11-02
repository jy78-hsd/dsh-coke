/**
 * 生成一个「可以直接拖进 GitHub 网页」的仓库目录，以及市场要的那份 YAML。
 *
 *   node scripts/prepare-repo.mjs --owner <你的 GitHub 用户名>
 *
 * 产出：
 *   ../dsh-coke-repo/                 ← 拖到 GitHub「upload files」里就行
 *   ../dsh-coke-repo/.github-entry.yml ← 提交到 awesome-dsh-plugin 的那份 YAML 内容
 *
 * 说明：README 里引用的截图会被复制进 docs/shots/，链接就地改写，仓库里图片不会挂。
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(PKG_ROOT, '..');
const OUT = join(WORKSPACE, 'dsh-coke-repo');
const SHOTS_SRC = join(WORKSPACE, 'petwork', 'shots');

const argv = process.argv.slice(2);
const ownerIndex = argv.indexOf('--owner');
const owner = (ownerIndex >= 0 ? argv[ownerIndex + 1] : '') || 'YOUR-GITHUB-NAME';
const repoUrl = 'https://github.com/' + owner + '/dsh-coke';

const pkg = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'));

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** README 里引用的截图 → 复制到 docs/shots/ 并改写链接 */
async function stageReadme() {
  const readme = await readFile(join(PKG_ROOT, 'README.md'), 'utf8');
  const used = new Set();
  for (const match of readme.matchAll(/\]\((petwork\/shots\/[^)\s]+)\)/g)) used.add(match[1]);
  const shots = join(OUT, 'docs', 'shots');
  await mkdir(shots, { recursive: true });
  let copied = 0;
  for (const rel of used) {
    const src = join(WORKSPACE, rel.replace(/\//g, '\\'));
    if (!(await exists(src))) {
      console.warn('缺截图（README 里引用了但没有）：' + rel);
      continue;
    }
    const name = rel.split('/').pop();
    await cp(src, join(shots, name));
    copied += 1;
  }
  const rewritten = readme
    .replace(/\(petwork\/shots\/([^)\s]+)\)/g, (_m, rest) => '(docs/shots/' + rest.split('/').pop() + ')')
    // 素材脚本只在开发工作区，不随插件发布
    .replace(/`petwork\/import_forms\.py` 可重跑/g, '素材脚本见开发工作区（未随插件发布）')
    .replace(/node petwork\\harness\\/g, 'node <素材脚本>/')
    .replace(/python petwork\\greenscreen\.py/g, 'python <素材脚本>/greenscreen.py')
    .replace(/`petwork\/harness\/desktop-bridge-test\.cjs`/g, '开发工作区里的回程测试脚本');
  await writeFile(join(OUT, 'README.md'), rewritten, 'utf8');
  return { copied, referenced: used.size };
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const item of ['lib', 'assets', 'runtime', 'scripts', 'cordis.patch.yml', 'LICENSE', 'package.json']) {
  await cp(join(PKG_ROOT, item), join(OUT, item), { recursive: true });
}
const staged = await stageReadme();

await writeFile(
  join(OUT, '.gitignore'),
  ['node_modules/', 'dist/', '*.log', '.DS_Store', ''].join('\n'),
  'utf8',
);

const entry = `url: ${repoUrl}
name: ${owner}/dsh-coke
category: fun
description:
  en: "A cat desktop pet for DeepSeek Harness: click it for one of 7 catchphrases with a springy bounce, right-click for chat (answers via your current model, optional sticker), singing with a microphone, a random 'form' card, green-screen outfit swapping, or shooting it; balance query at its feet; auto-starts with DSH."
  zh: "小猫coke：DSH 桌面上的猫桌宠。左键点它按权重抽 7 句台词并 Q 弹蹦一下；右键能「对话」（用当前模型回答，可配表情包）、「唱歌」（掏麦克风）、「形态展示」（头顶随机形态卡片）、「自定义装扮」（绿幕检测后换形象）、「枪击小猫」；脚下按钮查 DeepSeek 余额；默认随 DSH 自动启动。"
`;
await writeFile(join(WORKSPACE, 'publish', 'dsh-catalog-entry.yml'), entry, 'utf8');

const files = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) await walk(full);
    else files.push(relative(OUT, full));
  }
}
await walk(OUT);

console.log('仓库目录：' + OUT);
console.log('文件数：' + files.length + '（README 引用的截图 ' + staged.referenced + ' 张，复制成功 ' + staged.copied + ' 张）');
console.log('版本：' + pkg.name + '@' + pkg.version);
console.log('提交给市场的 YAML：' + join(OUT, '.github-entry.yml'));
