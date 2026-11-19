const validId = (id: string) => id.length === 32 && /^[0-9a-f]{32}$/.test(id);
export type VaultIds = { vault: string; object: string };
type VaultRoute =
  | { kind: "workspace" }
  | { kind: "picker" }
  | { kind: "embed"; ids?: VaultIds };

export function parseVaultRoute(path: string): VaultRoute {
  if (path === "/pick") return { kind: "picker" };
  if (path !== "/embed" && !path.startsWith("/embed/"))
    return { kind: "workspace" };
  const [, , vault, object, extra] = path.split("/");
  return vault && object && validId(vault) && validId(object) && extra === undefined
    ? { kind: "embed", ids: { vault, object } }
    : { kind: "embed" };
}

export function decodeId(id: string) {
  if (!validId(id)) throw Error("InvalidId");
  return Uint8Array.from(id.match(/../g)!, (value) => parseInt(value, 16));
}
export function encodeId(id: ArrayLike<number>) {
  return Array.from(id, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type WikiOpener = { source: Window; origin: string };
export function connectWikiPicker(
  origin: string,
  accept: (connection: WikiOpener) => void,
) {
  const source = window.opener as Window | null;
  if (!source || source.closed || window.top !== window) return () => {};
  const listen = (message: MessageEvent) => {
    const data = message.data;
    if (
      message.source !== source ||
      message.origin !== origin ||
      !data ||
      typeof data !== "object" ||
      Object.keys(data).length !== 1 ||
      data.type !== "kinic-vault-picker-connect"
    )
      return;
    if (window.opener !== source || source.closed) return;
    close();
    accept({ source, origin });
  };
  const close = () => window.removeEventListener("message", listen);
  window.addEventListener("message", listen);
  try {
    source.postMessage({ type: "kinic-vault-picker-ready" }, origin);
  } catch {
    close();
  }
  return close;
}

export function sendVaultSelection(connection: WikiOpener, ids: VaultIds) {
  const { source, origin } = connection;
  const { vault, object } = ids;
  if (
    window.opener !== source ||
    source.closed ||
    !validId(vault) ||
    !validId(object)
  )
    return false;
  try {
    source.postMessage(
      { type: "kinic-vault-selection", vault, object },
      origin,
    );
    return true;
  } catch {
    return false;
  }
}
