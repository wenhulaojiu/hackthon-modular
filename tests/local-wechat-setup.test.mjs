import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { archiveExtractionCode, isPythonAlias } from '../scripts/local-wechat/setup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = path.join(root, 'work', 'setup-regression');
const expected = 'wechat-chat-export-synthetic';
const python = (() => {
  const candidates = process.env.KEXU_TEST_PYTHON ? [[process.env.KEXU_TEST_PYTHON, []]] : process.platform === 'win32' ? [['py.exe', ['-3']], ['python.exe', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys; print(int(sys.version_info >= (3,11)))'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (probe.status === 0 && probe.stdout.trim() === '1') return { command, prefix };
  }
  return null;
})();

const makeZip = `import json,sys,zipfile
archive=sys.argv[1]
serialized=sys.stdin.read()
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as result:
 for item in json.loads(serialized):
  info=zipfile.ZipInfo(item['name'])
  info.create_system=3
  if item.get('symlink'): info.external_attr=(0o120777<<16)
  result.writestr(info,item.get('text','').encode('utf-8'))`;

function pythonRun(code, args, input) {
  return spawnSync(python.command, [...python.prefix, '-c', code, ...args], { windowsHide: true, shell: false, encoding: 'utf8', input, timeout: 15000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
}

async function fixture(entries, work) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, 'case-'));
  const archive = path.join(directory, 'synthetic.zip');
  const destination = path.join(directory, 'destination');
  await mkdir(destination);
  try {
    const created = pythonRun(makeZip, [archive], JSON.stringify(entries));
    assert.equal(created.status, 0, '合成ZIP创建失败');
    await work({ directory, archive, destination, extract: () => pythonRun(archiveExtractionCode(), [archive, destination, expected]) });
  } finally {
    // 删除前严格核对生成目录位于本测试专用空间，且不是该空间根目录。
    const relative = path.relative(scratch, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  }
}

test('安装器只排除商店占位Python，放行已验证的真实包内解释器', () => {
  assert.equal(isPythonAlias('C:/Users/example/AppData/Local/Microsoft/WindowsApps/python.exe'), true);
  assert.equal(isPythonAlias('C:/Users/example/AppData/Local/Microsoft/WindowsApps/python3.exe'), true);
  assert.equal(isPythonAlias('C:/Users/example/AppData/Local/Microsoft/WindowsApps/PythonSoftwareFoundation.Python.3.11_example/python.exe'), false);
  assert.equal(isPythonAlias('C:/Python311/python.exe'), false);
});

test('安全解包还原合成UTF-8源码并去掉已核对的固定仓库根目录', { skip: !python }, async () => {
  await fixture([{ name: `${expected}/scripts/export_wechat.py`, text: '# 合成源码，不执行\n' }, { name: `${expected}/README.md`, text: '中文合成说明' }], async ({ destination, extract }) => {
    const result = extract();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { source_files: 2, safe_unpack: true });
    assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), '中文合成说明');
  });
});

test('安全解包拒绝绝对路径、跨目录、错误根和Windows特殊名称', { skip: !python }, async () => {
  for (const name of ['/absolute.txt', `${expected}/../../escape.txt`, `${expected}/folder\\..\\escape.txt`, 'other-root/file.txt', `${expected}/C:/escape.txt`, `${expected}/NUL.txt`, `${expected}/trailing.`, `${expected}/file.txt:stream`]) {
    await fixture([{ name, text: '合成数据' }], async ({ extract }) => assert.notEqual(extract().status, 0, `不应接受 ${name}`));
  }
});

test('安全解包拒绝符号链接、大小写冲突和已有文件覆盖', { skip: !python }, async () => {
  await fixture([{ name: `${expected}/shortcut`, text: '../outside', symlink: true }], async ({ extract }) => assert.notEqual(extract().status, 0));
  await fixture([{ name: `${expected}/README.md`, text: '第一份' }, { name: `${expected}/readme.md`, text: '冲突版本' }], async ({ extract }) => assert.notEqual(extract().status, 0));
  await fixture([{ name: `${expected}/existing.txt`, text: '替换内容' }], async ({ destination, extract }) => {
    await writeFile(path.join(destination, 'existing.txt'), '保留原文件', 'utf8');
    assert.notEqual(extract().status, 0);
    assert.equal(await readFile(path.join(destination, 'existing.txt'), 'utf8'), '保留原文件');
  });
});

test('安全解包限制条目数量和声明的单文件解压尺寸', { skip: !python }, async () => {
  await fixture(Array.from({ length: 2001 }, (_, index) => ({ name: `${expected}/item-${index}.txt` })), async ({ extract }) => assert.notEqual(extract().status, 0));
  await fixture([{ name: `${expected}/large.txt` }], async ({ archive, extract }) => {
    const bytes = await readFile(archive);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(central >= 0);
    bytes.writeUInt32LE(20_000_001, central + 24);
    await writeFile(archive, bytes);
    const result = extract();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Archive entry is too large/);
  });
});
