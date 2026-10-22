// Google Analytics 4 (G-961PZQR67Y) + KVKK çerez izni (Consent Mode v2).
// İzin verilene kadar çerez yazılmaz (analytics_storage: denied); ziyaretçi seçimini bu cihazda hatırlarız.
(() => {
  const OLCUM = "G-961PZQR67Y";
  const ANAHTAR = "aysu-cerez-izni";
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  let secim = null;
  try { secim = localStorage.getItem(ANAHTAR); } catch {}
  gtag("consent", "default", {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
    analytics_storage: secim === "evet" ? "granted" : "denied",
  });
  gtag("js", new Date());
  gtag("config", OLCUM, { anonymize_ip: true });
  const s = document.createElement("script");
  s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${OLCUM}`;
  document.head.appendChild(s);

  /** Sayfadan olay göndermek için: aysuOlay("rezervasyon_olusturuldu", { saat: "21:00" }) */
  window.aysuOlay = (ad, veri = {}) => { try { gtag("event", ad, veri); } catch {} };

  if (secim) return;
  // Çerez izni şeridi
  const goster = () => {
    const d = document.createElement("div");
    d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Çerez izni");
    d.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:560px;margin:0 auto;background:#062a45;color:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.3);font:15px/1.45 system-ui,sans-serif";
    d.innerHTML = `<p style="margin:0 0 10px">Sitemizi geliştirmek için ziyaret istatistiği (Google Analytics çerezleri) kullanıyoruz. <a href="/kvkk.html" style="color:#ffd27a">Ayrıntılar</a></p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" data-c="hayir" style="background:transparent;color:#fff;border:1px solid #5d84a3;border-radius:999px;padding:9px 16px;font:600 15px system-ui;cursor:pointer">Reddet</button>
        <button type="button" data-c="evet" style="background:#ef7f1a;color:#062a45;border:0;border-radius:999px;padding:9px 18px;font:700 15px system-ui;cursor:pointer">Kabul et</button>
      </div>`;
    d.addEventListener("click", (e) => {
      const c = e.target.closest("[data-c]")?.dataset.c; if (!c) return;
      try { localStorage.setItem(ANAHTAR, c); } catch {}
      if (c === "evet") gtag("consent", "update", { analytics_storage: "granted" });
      d.remove();
    });
    document.body.appendChild(d);
    // Şerit sayfanın altındaki düğmeleri (ör. Dekontu yükle) örtmesin: sayfanın altına şerit kadar boşluk
    const bosluk = () => { document.body.style.paddingBottom = d.isConnected ? `${d.offsetHeight + 24}px` : ""; };
    bosluk(); window.addEventListener("resize", bosluk);
    d.addEventListener("click", () => setTimeout(bosluk, 0));
  };
  if (document.body) goster(); else document.addEventListener("DOMContentLoaded", goster);
})();
