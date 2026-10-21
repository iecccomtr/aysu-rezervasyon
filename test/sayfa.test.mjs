// Sayfalardaki satır içi <script> kodlarının sözdizimi hatası içermediğini denetler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

for (const sayfa of ["public/index.html", "public/rezervasyon/index.html", "public/panel/index.html", "public/kvkk.html"]) {
  test(`Sayfa betikleri derlenir: ${sayfa}`, () => {
    const html = readFileSync(new URL("../" + sayfa, import.meta.url), "utf8");
    for (const [, kod] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new vm.Script(kod), sayfa);
    }
  });
}
