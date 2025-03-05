import { parseArgs } from "jsr:@std/cli/parse-args";
import { parse } from "jsr:@std/toml";
import * as path from "jsr:@std/path";
import { ConfigSchema, SubsonicUserSchema } from "./zod.ts";
import { SERVER_VERSION } from "./util.ts";
import { scanMediaDirectories } from "./MediaScanner.ts";
let configFile = "./config.json";

if (Deno.args.length) {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version"],
    string: ["config"],
    alias: { help: "h", version: "v", config: "c" },
    unknown: (arg) => {
      console.error(
        `Unknown option "${arg}". try running "denosonic -h" for help.`,
      );
      Deno.exit(127);
    },
  });

  if (args.config) configFile = Deno.args[1];
  if (args.help) {
    console.log(`Usage: dinosonic [OPTIONS...]`);
    console.log("\nOptional flags:");
    console.log("  -h, --help                Display this help and exit");
    console.log(
      "  -v, --version             Display the current version of Dinosonic",
    );
    console.log(
      '  -c, --config              Set the config file location. Default will be "./config.json"',
    );
    Deno.exit(0);
  }

  if (args.version) {
    console.log(SERVER_VERSION);
    Deno.exit(0);
  }
}

console.log(`Config file: ${configFile}`);
const configText = await Deno.readTextFile(configFile);
const configParse = ConfigSchema.safeParse(parse(configText));
if (!configParse.success) {
  console.error(
    configParse.error.issues.map((issue) => {
      return `Config Error in ${issue.path.join(".")}: ${issue.message}`;
    }).join("\n"),
  );
  Deno.exit(1);
}
const config = configParse.data;
const database = await Deno.openKv(
  path.join(config.data_folder as string, "dinosonic.db"),
);

if (!(await database.get(["users", "admin"])).value) {
  // TODO: add Logging.
  await database.set(["users", "admin"], {
    backend: {
      username: "admin",
      password: config.default_admin_password,
    },
    subsonic: SubsonicUserSchema.parse({
      username: "admin",
      adminRole: true,
      scrobblingEnabled: true,
      settingsRole: true,
      downloadRole: true,
      playlistRole: true,
      streamRole: true,
    }),
  });
}

if (config.scan_on_start) {
  console.log("Starting media scan...");
  scanMediaDirectories(database, config.music_folders, config);
}

// for await (const item of database.list({ prefix: ["tracks"] })) {
//   console.log(item)
// }

console.log("🚀 Starting Dinosonic server...");
// await startServer(database, config)
