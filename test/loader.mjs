export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: new URL("./cf-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "cloudflare:sockets") {
    return { url: new URL("./cf-sockets-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
