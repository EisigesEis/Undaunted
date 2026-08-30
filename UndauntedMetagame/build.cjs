const path = require("path");
const { build } = require("esbuild");

build({
  entryPoints: [path.join(__dirname, "src", "server.ts")],
  bundle: true,
  platform: "node",
  target: "es2022",
  format: "cjs",
  packages: "external",
  minify: true,
  legalComments: "none",
  outfile: path.join(__dirname, "dist", "server.js"),
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
