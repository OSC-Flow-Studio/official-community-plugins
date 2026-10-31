// Signs the current build of one plugin with the key in .env, for a release made by hand.
// `npm run release` does this itself.
//
//   npm run sign -- livepix
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readPlugin, root } from "./plugins.mjs";
import { loadSigningKey, signPluginDir } from "./signing.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const id = process.argv[2];
    if (!id) throw new Error("Name the plugin: npm run sign -- <plugin-id>");
    const signing = loadSigningKey();
    if (!signing) throw new Error("There is no signing key. Run npm run keygen, or copy .env.example to .env and fill it in.");
    const { path, packed } = signPluginDir(readPlugin(id), signing);
    console.log(`Signed ${packed.name} with ${signing.keyId}.
Commit ${relative(root, path).split(sep).join("/")} with the version, then push the tag.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
