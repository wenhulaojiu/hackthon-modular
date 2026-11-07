import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public', 'kexu-local.zip');
const folders = ['app', 'components', 'db', 'drizzle', 'hooks', 'lib', 'scripts', 'vendor', 'worker', 'public', 'docs', 'tests'];
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'next.config.ts', 'postcss.config.mjs', 'eslint.config.mjs', 'components.json', 'drizzle.config.ts', 'cloudflare-env.d.ts', 'README.md', 'README.zh-CN.md', 'AGENTS.md', '.gitignore', '.npmrc', '.env.example', '启动客序.cmd', '安装微信提取组件.cmd'];
const forbidden = new Set(['node_modules', '.git', '.openai', '.local-wechat', '.wrangler', '.sites-runtime', '.vinext', '.next', 'dist', 'work', 'outputs', 'private', 'coverage', '.agents', '.codex', '__pycache__']);

function allowed(relative) {
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => forbidden.has(part))) return false;
  const name = parts.at(-1);
  if (name === '.env.example') return true;
  if (/^\.env|^\.dev\.vars|\.pem$|\.pfx$|\.p12$|\.key$|\.log$|\.tsbuildinfo$|\.zip$/i.test(name)) return false;
  return true;
}

const selected = [];
async function visit(relative) {
  if (!allowed(relative)) return;
  const absolute = path.join(root, relative);
  let info;
  try { info = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // 不跟随符号链接，避免把项目外资料放入下载包。
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    const names = (await readdir(absolute)).sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) await visit(path.join(relative, name));
    return;
  }
  if (!info.isFile()) return;
  if (info.size > 25_000_000) throw new Error(`源文件超过打包预期，请人工检查：${relative}`);
  const data = await readFile(absolute);
  if (relative === '.npmrc' && /_authToken|_password|\bpassword\s*=|\busername\s*=/i.test(data.toString('utf8'))) return;
  selected.push({ relative: relative.replaceAll('\\', '/'), data, date: info.mtime });
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  crcTable[index] = value >>> 0;
}
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

function zip(records) {
  const bodies = [];
  const central = [];
  let offset = 0;
  for (const record of records) {
    const name = Buffer.from(`客序本地版/${record.relative}`, 'utf8');
    const data = deflateRawSync(record.data, { level: 9 });
    const checksum = crc32(record.data);
    const year = Math.max(1980, Math.min(2107, record.date.getFullYear()));
    const dosDate = (year - 1980) << 9 | (record.date.getMonth() + 1) << 5 | record.date.getDate();
    const dosTime = record.date.getHours() << 11 | record.date.getMinutes() << 5 | Math.floor(record.date.getSeconds() / 2);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(record.data.length, 22); header.writeUInt16LE(name.length, 26);
    bodies.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(dosTime, 12); directory.writeUInt16LE(dosDate, 14); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(record.data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  if (records.length > 65535 || offset > 0xffffffff) throw new Error('下载包超过普通ZIP容量，请缩小源文件范围。');
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, directory, end]);
}

for (const directory of folders) await visit(directory);
for (const filename of files) await visit(filename);
// 本地构建需要绑定声明，但不复制在线站点标识或其他托管资料。
selected.push({ relative: '.openai/hosting.json', data: Buffer.from(JSON.stringify({ d1: 'DB', r2: null }, null, 2) + '\n', 'utf8'), date: new Date() });
for (const required of ['package.json', 'package-lock.json', '启动客序.cmd', '安装微信提取组件.cmd', 'scripts/local-wechat/launch.mjs', 'scripts/local-wechat/setup.mjs']) {
  if (!selected.some(record => record.relative === required)) throw new Error(`本地包缺少必要入口：${required}`);
}
const archive = zip(selected);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, archive);
console.log(`已生成 public/kexu-local.zip：${selected.length} 个源码文件，${archive.length.toLocaleString('zh-CN')} 字节。`);
console.log('已排除本机数据库、环境变量、密钥、依赖、Git信息和运行日志。');
