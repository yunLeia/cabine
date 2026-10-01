// Run with: npm test (node strips the types).
import assert from 'node:assert/strict';
import { inferCategory } from '../src/shared/infer.ts';

const cases: [string, string | null][] = [
  ['Wool Blend Jacket - Black | COS', 'outerwear'],
  ['Shirt Dress | ARKET', 'dress'],
  ['Relaxed Cotton T-Shirt | Uniqlo US', 'top'],
  ['Denim Jacket – Light blue', 'outerwear'],
  ['Knit Mini Skirt - Women | H&M US', 'bottom'],
  ['Straight Leg Jeans | Tops & Bottoms | Store', 'bottom'],
  ['Leather Loafers | Massimo Dutti', 'shoes'],
  ['Kitten Heel Slingback Sandals', 'shoes'],
  ['Oversized Cardigan · Zara', 'outerwear'],
  ['Silk Camisole', 'top'],
  ['Linen Trousers', 'bottom'],
  ['오버핏 데님 자켓 | 무신사', 'outerwear'],
  ['울 블렌드 니트 스웨터 - 29CM', 'top'],
  ['와이드 데님팬츠', 'bottom'],
  ['플리츠 롱 원피스', 'dress'],
  ['베스트셀러 캐시미어 니트', 'top'],
  ['Petticoat lace detail', null],
  ['www.cos.com', null],
  ['', null],
];
let failed = 0;
for (const [title, want] of cases) {
  const got = inferCategory(title);
  if (got !== want) { failed++; console.log(`✗ ${JSON.stringify(title)} → ${got}, want ${want}`); }
}
assert.equal(failed, 0, `${failed} wrong`);
console.log(`infer: all ${cases.length} passed`);

import { productName } from '../src/shared/infer.ts';
assert.equal(productName('Lace Trim Silk Camisole – Navy | COS'), 'Lace Trim Silk Camisole');
assert.equal(productName('Relaxed Cotton T-Shirt | Uniqlo US'), 'Relaxed Cotton T-Shirt');
assert.equal(productName('www.cos.com'), 'www.cos.com');
console.log('productName: ok');
