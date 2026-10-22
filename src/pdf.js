// Küçük PDF yazıcı (bağımlılıksız). Türkçe karakterler için DejaVu Sans alt kümesi gömülür
// (Type0 / CIDFontType2, Identity-H; metin aranabilir / kopyalanabilir olsun diye ToUnicode eklenir).

import { FONTLAR } from "./pdf-font.js";

const A4 = [595.28, 841.89];
const b64Bayt = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex4 = (n) => n.toString(16).padStart(4, "0").toUpperCase();
const sayi = (n) => (Math.round(n * 100) / 100).toString();

export class Pdf {
  constructor() {
    this.sayfalar = [];
    this.kullanilan = { normal: new Map(), kalin: new Map() }; // gid → [unicode, genişlik]
    this.yeniSayfa();
  }

  yeniSayfa() {
    this.ops = [];
    this.sayfalar.push(this.ops);
    return this;
  }

  get genislik() { return A4[0]; }
  get yukseklik() { return A4[1]; }

  glif(f, ch) {
    const c = FONTLAR[f].cmap;
    return c[ch.codePointAt(0)] || c[63]; // bilinmeyen karakter → "?"
  }

  olc(metin, boyut = 10, kalin = false) {
    const f = kalin ? "kalin" : "normal";
    let w = 0;
    for (const ch of String(metin ?? "")) w += this.glif(f, ch)[1];
    return (w * boyut) / 1000;
  }

  /** Genişliğe sığmayan metni "…" ile kısaltır */
  sigdir(metin, en, boyut = 10, kalin = false) {
    let s = String(metin ?? "");
    if (this.olc(s, boyut, kalin) <= en) return s;
    while (s.length > 1 && this.olc(s + "…", boyut, kalin) > en) s = s.slice(0, -1);
    return s + "…";
  }

  /** y: taban çizgisi (üstten aşağı ölçülür) */
  yazi(x, y, metin, { boyut = 10, kalin = false, renk = [0.06, 0.13, 0.18], hiza = "sol", en = null } = {}) {
    const f = kalin ? "kalin" : "normal";
    let s = String(metin ?? "");
    if (en) s = this.sigdir(s, en, boyut, kalin);
    let hex = "";
    for (const ch of s) {
      const [g, w] = this.glif(f, ch);
      hex += hex4(g);
      if (!this.kullanilan[f].has(g)) this.kullanilan[f].set(g, [ch.codePointAt(0), w]);
    }
    const w = this.olc(s, boyut, kalin);
    const gx = hiza === "sag" ? x - w : hiza === "orta" ? x - w / 2 : x;
    this.ops.push(`BT ${renk.map(sayi).join(" ")} rg /${f === "kalin" ? "F2" : "F1"} ${boyut} Tf ${sayi(gx)} ${sayi(A4[1] - y)} Td <${hex}> Tj ET`);
    return w;
  }

  cizgi(x1, y1, x2, y2, { kalinlik = 0.5, renk = [0.75, 0.79, 0.83] } = {}) {
    this.ops.push(`${renk.map(sayi).join(" ")} RG ${kalinlik} w ${sayi(x1)} ${sayi(A4[1] - y1)} m ${sayi(x2)} ${sayi(A4[1] - y2)} l S`);
  }

  /** Dolu dikdörtgen; y: üst kenar */
  kutu(x, y, en, boy, renk = [0.94, 0.96, 0.98]) {
    this.ops.push(`${renk.map(sayi).join(" ")} rg ${sayi(x)} ${sayi(A4[1] - y - boy)} ${sayi(en)} ${sayi(boy)} re f`);
  }

  /** PDF dosyası (Uint8Array) */
  bayt() {
    const enc = new TextEncoder();
    const parcalar = [];
    const ofsetler = [];
    let uzunluk = 0;
    const ekle = (b) => { const u = typeof b === "string" ? enc.encode(b) : b; parcalar.push(u); uzunluk += u.length; };
    const nesneler = []; // [no, içerik: string | {sozluk, akis: Uint8Array}]
    let sayac = 0;
    const yeniNo = () => ++sayac;

    const katalog = yeniNo(), sayfalarNo = yeniNo();
    const fontNo = {};
    for (const [f, ad] of [["normal", "F1"], ["kalin", "F2"]]) {
      const F = FONTLAR[f];
      const kul = [...this.kullanilan[f].entries()].sort((a, b) => a[0] - b[0]);
      if (!kul.length) kul.push([FONTLAR[f].cmap[32][0], [32, FONTLAR[f].cmap[32][1]]]);
      const tip0 = yeniNo(), cid = yeniNo(), tanim = yeniNo(), dosya = yeniNo(), uni = yeniNo();
      fontNo[ad] = tip0;
      const taban = `AYSUAA+${F.ad}`;
      nesneler.push([tip0, `<< /Type /Font /Subtype /Type0 /BaseFont /${taban} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${uni} 0 R >>`]);
      nesneler.push([cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${taban} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${tanim} 0 R /DW 1000 /W [${kul.map(([g, [, w]]) => `${g} [${w}]`).join(" ")}] /CIDToGIDMap /Identity >>`]);
      nesneler.push([tanim, `<< /Type /FontDescriptor /FontName /${taban} /Flags 32 /FontBBox [${F.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${F.ascent} /Descent ${F.descent} /CapHeight 729 /StemV ${f === "kalin" ? 120 : 80} /FontFile2 ${dosya} 0 R >>`]);
      const fb = b64Bayt(F.b64);
      nesneler.push([dosya, { sozluk: `/Length1 ${fb.length}`, akis: fb }]);
      const bf = [];
      for (let i = 0; i < kul.length; i += 100) {
        const p = kul.slice(i, i + 100);
        bf.push(`${p.length} beginbfchar\n${p.map(([g, [u]]) => `<${hex4(g)}> <${hex4(u)}>`).join("\n")}\nendbfchar`);
      }
      const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${bf.join("\n")}\nendcmap CMapName currentdict /CMap defineresource pop end end`;
      nesneler.push([uni, { sozluk: "", akis: enc.encode(cmap) }]);
    }
    const sayfaNolari = [];
    for (const ops of this.sayfalar) {
      const s = yeniNo(), ic = yeniNo();
      sayfaNolari.push(s);
      nesneler.push([s, `<< /Type /Page /Parent ${sayfalarNo} 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /Font << /F1 ${fontNo.F1} 0 R /F2 ${fontNo.F2} 0 R >> >> /Contents ${ic} 0 R >>`]);
      nesneler.push([ic, { sozluk: "", akis: enc.encode(ops.join("\n")) }]);
    }
    nesneler.push([katalog, `<< /Type /Catalog /Pages ${sayfalarNo} 0 R >>`]);
    nesneler.push([sayfalarNo, `<< /Type /Pages /Kids [${sayfaNolari.map((n) => `${n} 0 R`).join(" ")}] /Count ${sayfaNolari.length} >>`]);
    nesneler.sort((a, b) => a[0] - b[0]);

    ekle("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    for (const [no, icerik] of nesneler) {
      ofsetler[no] = uzunluk;
      if (typeof icerik === "string") ekle(`${no} 0 obj\n${icerik}\nendobj\n`);
      else {
        ekle(`${no} 0 obj\n<< /Length ${icerik.akis.length} ${icerik.sozluk} >>\nstream\n`);
        ekle(icerik.akis);
        ekle("\nendstream\nendobj\n");
      }
    }
    const xref = uzunluk;
    let x = `xref\n0 ${sayac + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= sayac; i++) x += `${String(ofsetler[i]).padStart(10, "0")} 00000 n \n`;
    ekle(`${x}trailer\n<< /Size ${sayac + 1} /Root ${katalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const sonuc = new Uint8Array(uzunluk);
    let o = 0;
    for (const p of parcalar) { sonuc.set(p, o); o += p.length; }
    return sonuc;
  }
}
