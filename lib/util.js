export function findPlaystakeUrl(text) {
  const m = /(https?:\/\/)?playstake\.club\/bonus\?[^>\s]+/i.exec(text);
  return m ? (m[0].startsWith('http') ? m[0] : `https://${m[0]}`) : null;
}
