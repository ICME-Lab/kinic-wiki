import next from "eslint-config-next";

const config = [...next];

config.push({
  ignores: [".open-next/**", ".wrangler/**", "out/**"]
});

export default config;
