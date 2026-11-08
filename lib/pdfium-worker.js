// PDFium（Chrome と同じPDF描画エンジン）で、図面の一部分（タイル）を描くワーカー。
// 画面側から複数起動して、並行して描かせる。ネットには一切アクセスしない（wasm は同梱のものを渡される）。
import { init } from './pdfium/index.browser.js';

const FPDF_ANNOT = 0x01, FPDF_REVERSE_BYTE_ORDER = 0x10;
let P = null;                 // PDFium の関数
const docs = new Map();       // key → { doc, ptr, pages: Map(index → page) }
const MAX_PAGES = 6;          // 開いたままにしておくページの数（ワーカーごと）

function getPage(d, index) {
  let pg = d.pages.get(index);
  if (pg) { d.pages.delete(index); d.pages.set(index, pg); return pg; }   // 最近使った順に並べ直す
  pg = P.FPDF_LoadPage(d.doc, index);
  if (!pg) throw new Error('ページを開けませんでした');
  d.pages.set(index, pg);
  while (d.pages.size > MAX_PAGES) { const [k, old] = d.pages.entries().next().value; P.FPDF_ClosePage(old); d.pages.delete(k); }
  return pg;
}
// ---- PDFに埋め込まれていない日本語フォント（MSゴシック・ヒラギノ等の名前だけのもの）----
// PDFium（wasm）はパソコンのフォントを直接読めないので、本体から受け取ったフォントを渡す
// fonts = { gothic: ArrayBuffer(TTF), mincho: ArrayBuffer(TTF) }
let fontInfoPtr = 0;
function setFonts(fonts) {
  const M = P.pdfium, files = { 1: fonts.gothic, 2: fonts.mincho || fonts.gothic };
  const JP = /gothic|mincho|ming|kaku|maru|ゴシック|明朝|heisei|kozuka|koz(min|go)|ryumin|midashi|futo|hiragino|ヒラギノ|meiryo|メイリオ|yu ?(go|min)|游|osaka|ipa|takao|noto ?(sans|serif) ?(cjk|jp)|source han|biz ?ud|ud ?デジタル/i;
  const isMincho = face => /mincho|ming|明朝|ryumin|kozmin|serif|hgs?m/i.test(face);
  const nameOf = h => h === 2 ? 'Mincho' : 'Gothic';
  const add = (fn, sig) => M.addFunction(fn, sig);
  const mapFont = add((_t, _weight, _italic, charset, _pitch, facePtr, exactPtr) => {
    const face = facePtr ? M.UTF8ToString(facePtr) : '';
    // 日本語の文字セット（128＝Shift_JIS）か、日本語フォントの名前のときだけ引き受ける（英字フォントは PDFium の内蔵で）
    if (charset !== 128 && !JP.test(face)) return 0;
    if (exactPtr) M.setValue(exactPtr, 0, 'i32');
    return isMincho(face) && files[2] ? 2 : 1;
  }, 'iiiiiiii');
  const getFont = add((_t, facePtr) => { const face = facePtr ? M.UTF8ToString(facePtr) : ''; return JP.test(face) ? (isMincho(face) ? 2 : 1) : 0; }, 'iii');
  const getFontData = add((_t, h, table, buf, size) => {
    const f = files[h];
    if (!f || table !== 0) return 0;   // 0＝フォントファイル全体（ttc ではなく取り出した ttf を渡すので 'ttcf' は無し）
    if (buf && size >= f.byteLength) M.HEAPU8.set(new Uint8Array(f), buf);
    return f.byteLength;
  }, 'iiiiii');
  const getFaceName = add((_t, h, buf, size) => {
    const s = nameOf(h), n = new TextEncoder().encode(s).length + 1;
    if (buf && size >= n) M.stringToUTF8(s, buf, n);
    return n;
  }, 'iiiii');
  const getCharset = add(() => 128, 'iii');
  const noop2 = add(() => {}, 'vii');
  const noop1 = add(() => {}, 'vi');
  // FPDF_SYSFONTINFO（version 1）：9個の4バイトの値
  fontInfoPtr = M.wasmExports.malloc(36);
  [1, noop1, noop2, mapFont, getFont, getFontData, getFaceName, getCharset, noop2].forEach((v, i) => M.setValue(fontInfoPtr + i * 4, v, 'i32'));
  P.FPDF_SetSystemFontInfo(fontInfoPtr);
}
function closeDoc(key) {
  const d = docs.get(key);
  if (!d) return;
  for (const pg of d.pages.values()) P.FPDF_ClosePage(pg);
  P.FPDF_CloseDocument(d.doc);
  P.pdfium.wasmExports.free(d.ptr);
  docs.delete(key);
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      P = await init({ wasmBinary: m.wasm });
      P.PDFiumExt_Init();
      if (m.fonts) setFonts(m.fonts);
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'open') {
      if (docs.has(m.key)) return;
      const bytes = new Uint8Array(m.bytes);
      const ptr = P.pdfium.wasmExports.malloc(bytes.length);
      P.pdfium.HEAPU8.set(bytes, ptr);
      const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, '');
      if (!doc) { P.pdfium.wasmExports.free(ptr); throw new Error('PDFを開けませんでした（' + P.FPDF_GetLastError() + '）'); }
      docs.set(m.key, { doc, ptr, pages: new Map() });
    } else if (m.type === 'close') {
      closeDoc(m.key);
    } else if (m.type === 'render') {
      // ページ全体を fullW×fullH（画素）で描いたときの、(x, y) から w×h の部分だけを描く
      const d = docs.get(m.key);
      if (!d) throw new Error('PDFが開かれていません');
      const page = getPage(d, m.index);
      const bmp = P.FPDFBitmap_CreateEx(m.w, m.h, 4, 0, 0);
      P.FPDFBitmap_FillRect(bmp, 0, 0, m.w, m.h, 0xFFFFFFFF);
      P.FPDF_RenderPageBitmap(bmp, page, -m.x, -m.y, m.fullW, m.fullH, m.rot, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
      const buf = P.FPDFBitmap_GetBuffer(bmp), stride = P.FPDFBitmap_GetStride(bmp);
      const heap = P.pdfium.HEAPU8;
      let out;
      if (stride === m.w * 4) out = heap.slice(buf, buf + stride * m.h);
      else { out = new Uint8Array(m.w * m.h * 4); for (let r = 0; r < m.h; r++) out.set(heap.subarray(buf + r * stride, buf + r * stride + m.w * 4), r * m.w * 4); }
      P.FPDFBitmap_Destroy(bmp);
      self.postMessage({ type: 'done', id: m.id, w: m.w, h: m.h, data: out.buffer }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
