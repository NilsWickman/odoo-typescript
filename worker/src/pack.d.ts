// gen/out/**/models.pack: a Data module (wrangler.jsonc `rules`), an ArrayBuffer (src/gen_models.ts)
declare module "*.pack" {
  const data: ArrayBuffer;
  export default data;
}
