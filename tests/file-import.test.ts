import test from 'node:test';
import assert from 'node:assert/strict';
import type { Customer, Product } from '../lib/types.ts';
import {
  decodeXml, findColumn, keywordsFor, parseDelimited, parseDocxXml, parseSharedStrings, parseSheetXml,
  documentToTopics, documentToCustomers, documentToProducts, type ParsedDocument,
} from '../lib/file-import.ts';

const doc = (over: Partial<ParsedDocument> = {}): ParsedDocument => ({ fileName: 'demo.xlsx', paragraphs: [], rows: [], warnings: [], ...over });
let counter = 0;
const makeId = () => `id-${++counter}`;

test('CSV 支持引号、逗号与 TSV', () => {
  const rows = parseDelimited('姓名,备注,电话\n林女士,"奶粉, 2段",13800000000\n');
  assert.deepEqual(rows[0], ['姓名', '备注', '电话']);
  assert.deepEqual(rows[1], ['林女士', '奶粉, 2段', '13800000000']);
  assert.deepEqual(parseDelimited('a\tb\n1\t2')[1], ['1', '2']);
});

test('XML 实体只解码为纯文本', () => {
  assert.equal(decodeXml('DHA &amp; 鱼油 &lt;3段&gt;'), 'DHA & 鱼油 <3段>');
});

test('Word 段落按 w:p 抽取', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>DHA和鱼油有什么区别</w:t></w:r></w:p><w:p><w:r><w:t>DHA 主要来自藻油，鱼油来自深海鱼。</w:t></w:r></w:p></w:body></w:document>';
  assert.deepEqual(parseDocxXml(xml), ['DHA和鱼油有什么区别', 'DHA 主要来自藻油，鱼油来自深海鱼。']);
});

test('Excel 共享字符串与工作表按列号还原', () => {
  const shared = parseSharedStrings('<sst><si><t>问题</t></si><si><t>解答</t></si><si><t>DHA和鱼油有什么区别</t></si></sst>');
  assert.deepEqual(shared, ['问题', '解答', 'DHA和鱼油有什么区别']);
  const sheet = '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>DHA来自藻油。</t></is></c></row></sheetData>';
  const rows = parseSheetXml(sheet, shared);
  assert.deepEqual(rows[0], ['问题', '解答']);
  assert.equal(rows[1][0], 'DHA和鱼油有什么区别');
  assert.equal(rows[1][2], 'DHA来自藻油。');
});

test('表头自主识别与关键词派生', () => {
  assert.equal(findColumn(['姓名', '电话', '会员卡号'], 'phone'), 1);
  assert.equal(findColumn(['名称', '价格', '库存'], 'price'), 1);
  assert.ok(keywordsFor('DHA 和鱼油有什么区别').includes('DHA'));
});

test('表格识别为知识库段落', () => {
  const topics = documentToTopics([doc({ rows: [['问题', '解答'], ['拆封了能退吗', '拆封后不退款，请店员核对。']] })], makeId);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, '拆封了能退吗');
  assert.equal(topics[0].answer, '拆封后不退款，请店员核对。');
  assert.ok(topics[0].keywords.length > 0);
});

test('Word 正文按短标题分段', () => {
  const paragraphs = ['6个月换段', '宝宝满 6 个月，可以核对辅食添加与 2 段奶粉，按包装说明与儿科医生建议确认。'];
  const topics = documentToTopics([doc({ paragraphs })], makeId);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, '6个月换段');
  assert.ok(topics[0].answer.includes('2 段奶粉'));
});

test('知识库已满时不再生成段落', () => {
  assert.deepEqual(documentToTopics([doc({ paragraphs: ['标题', '正文内容很长。'] })], makeId, 0), []);
});

test('客户表识别宝宝月龄、跳过重复且不臆造空档案', () => {
  const existing = [{ name: '林女士', phone: '13800000000' }] as unknown as Customer[];
  const rows = [
    ['姓名', '电话', '会员卡号', '宝宝月龄', '宝宝小名', '过敏'],
    ['林女士', '13800000000', 'A1', '6', '', '无'],
    ['王女士', '13900000000', 'A2', '6', '豆豆', '牛奶蛋白'],
    ['陈女士', '13700000000', 'A3', '', '', ''],
  ];
  const { customers, skipped } = documentToCustomers([doc({ rows })], existing, makeId, () => '2026-11-12');
  assert.equal(skipped, 1);
  assert.equal(customers.length, 2);
  assert.equal(customers[0].name, '王女士');
  assert.equal(customers[0].baby?.ageMonths, 6);
  assert.equal(customers[0].baby?.name, '豆豆');
  assert.equal(customers[0].baby?.allergies, '牛奶蛋白');
  assert.equal(customers[1].baby, undefined);
  assert.equal(customers[1].source, 'manual');
  assert.equal(customers[1].createdAt, '2026-11-12');
});

test('商品表识别价格与类型，非法价格留空', () => {
  const existing = [{ name: '1段奶粉' }] as unknown as Product[];
  const rows = [
    ['名称', '价格', '库存', '类型', '说明'],
    ['1段奶粉', '268', '10', '商品', '适合 0-6 个月'],
    ['2段奶粉', '298', '', '商品', '适合 6-12 个月'],
    ['儿保咨询', '', '', '服务', '按预约'],
    ['纸尿裤', 'abc', '5', '商品', '无效价格'],
  ];
  const { products, skipped } = documentToProducts([doc({ rows })], existing, makeId);
  assert.equal(skipped, 1);
  assert.equal(products.length, 3);
  assert.equal(products[0].price, 298);
  assert.equal(products[0].stock, undefined);
  assert.equal(products[1].type, 'service');
  assert.equal(products[1].price, null);
  assert.equal(products[2].price, null);
  assert.deepEqual(products[0].faq, []);
});
