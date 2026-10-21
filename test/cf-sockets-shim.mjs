// Testler için "cloudflare:sockets" taklidi: gerçek bağlantı kurulmaz (testler kendi bağlantısını verir).
export function connect() { throw new Error("Testte gerçek SMTP bağlantısı yok"); }
