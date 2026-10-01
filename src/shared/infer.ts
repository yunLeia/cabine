import type { Category } from './types';

// Guess a store item's category from its page title, so capture never stops to
// ask (D26). The guess is shown as "Top · Edit"; when nothing matches, the
// panel asks once.
//
// Product names put the garment noun last ("Wool Blend Jacket", "Shirt Dress",
// "오버핏 데님 자켓"), and titles end with store noise ("| COS", "- Women").
// So: look in the product-name part first and take the LAST garment word there;
// only if it has none, fall back to the first garment word anywhere.

const WORDS: [Category, string[]][] = [
  ['dress', ['dress', 'dresses', 'gown', 'jumpsuit', 'playsuit', 'romper', 'pinafore', '원피스', '드레스', '점프수트']],
  [
    'shoes',
    ['shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'boot', 'boots', 'loafer', 'loafers', 'sandal', 'sandals', 'heel', 'heels',
      'mule', 'mules', 'pump', 'pumps', 'flats', 'slingback', 'slingbacks', 'clog', 'clogs', 'espadrille', 'espadrilles', 'oxford', 'derby', 'brogue', 'brogues',
      '신발', '스니커즈', '운동화', '부츠', '로퍼', '샌들', '힐', '뮬', '펌프스', '슬링백', '구두'],
  ],
  [
    'outerwear',
    ['jacket', 'jackets', 'coat', 'coats', 'blazer', 'blazers', 'parka', 'parkas', 'trench', 'anorak', 'gilet', 'vest', 'waistcoat', 'puffer', 'bomber',
      'overshirt', 'shacket', 'cape', 'poncho', 'windbreaker', 'cardigan', 'cardigans',
      '자켓', '재킷', '코트', '블레이저', '패딩', '파카', '점퍼', '야상', '조끼', '트렌치', '가디건', '카디건', '아우터', '바람막이'],
  ],
  [
    'bottom',
    ['jeans', 'trousers', 'pants', 'skirt', 'skirts', 'shorts', 'leggings', 'chinos', 'joggers', 'culottes', 'slacks', 'sweatpants', 'cargos',
      '바지', '팬츠', '청바지', '슬랙스', '스커트', '치마', '반바지', '쇼츠', '레깅스', '조거', '데님팬츠'],
  ],
  [
    'top',
    ['top', 'tops', 'shirt', 'shirts', 't-shirt', 't-shirts', 'tshirt', 'tee', 'tees', 'blouse', 'blouses', 'sweater', 'sweaters', 'jumper', 'jumpers',
      'knit', 'knitwear', 'pullover', 'hoodie', 'hoodies', 'sweatshirt', 'sweatshirts', 'polo', 'tank', 'camisole', 'cami', 'bodysuit', 'turtleneck', 'henley', 'bustier',
      '티셔츠', '셔츠', '블라우스', '니트', '스웨터', '맨투맨', '후드', '후디', '탑', '나시', '슬리브리스', '반팔', '긴팔', '폴로', '터틀넥'],
  ],
];

// Hangul words are matched as substrings (they attach to other words: "데님자켓");
// Latin words need word boundaries ("coat" is not in "petticoat").
const HANGUL = /[ㄱ-힝]/;
const patterns = WORDS.flatMap(([category, words]) =>
  words.map((w) => ({ category, re: new RegExp(HANGUL.test(w) ? w : `(?<![\\p{L}])${w.replace('-', '[- ]?')}(?![\\p{L}])`, 'giu') })),
);

function matches(text: string): { category: Category; index: number }[] {
  return patterns.flatMap(({ category, re }) => [...text.matchAll(re)].map((m) => ({ category, index: m.index ?? 0 })));
}

// The product name is the first part of a page title: "Name | Store",
// "Name - Store", "Name – Category · Store".
export const productName = (title: string) => title.split(/\s[|–—·:]\s|\s-\s|\|/)[0].trim() || title;

export function inferCategory(title?: string): Category | null {
  if (!title) return null;
  const name = productName(title);
  const inName = matches(name);
  if (inName.length) return inName.reduce((a, b) => (b.index >= a.index ? b : a)).category;
  const anywhere = matches(title);
  return anywhere.length ? anywhere.reduce((a, b) => (b.index < a.index ? b : a)).category : null;
}
