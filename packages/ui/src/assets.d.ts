/** Vite/Metro turn image imports into URLs (web) or asset ids (native). */
declare module '*.webp' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
