/**
 * Render `lib/user-data.sh` + `lib/per-boot.sh` with literal placeholders so you can
 * inspect the exact shell that would run on first boot (without synthesizing the stack).
 *
 * Usage:
 *   npm run render-user-data
 *   npm run render-user-data -- --print per-boot
 *   npm run render-user-data -- --json ./placeholders.json --out /tmp/user-data.rendered.sh
 */
import * as fs from "fs";
import * as path from "path";
import {
  buildUserDataBundle,
  EXAMPLE_USER_DATA_PLACEHOLDERS,
  USER_DATA_PLACEHOLDER_KEYS,
  type UserDataPlaceholders,
} from "../lib/build-user-data";

const REPO_LIB = path.join(__dirname, "..", "lib");

function usage(): string {
  return `render-user-data — expand lib/user-data.sh and lib/per-boot.sh

Options:
  --lib DIR          Template directory (default: ${REPO_LIB})
  --print TARGET     user-data | per-boot | b64 | all   (default: user-data)
  --out FILE         Write selected output to FILE instead of stdout
  --json FILE        Merge JSON object over example placeholders

Per-field overrides (override example / JSON):
  --bucket NAME
  --hosted-zone-id ID
  --fqdn HOST
  --port PORT
  --volume-id VOL

  --help             Show this text
`;
}

function parseArgs(argv: string[]): {
  libDir: string;
  print: "user-data" | "per-boot" | "b64" | "all";
  out?: string;
  placeholders: UserDataPlaceholders;
} {
  let libDir = REPO_LIB;
  let print: "user-data" | "per-boot" | "b64" | "all" = "user-data";
  let out: string | undefined;
  const placeholders: UserDataPlaceholders = {
    ...EXAMPLE_USER_DATA_PLACEHOLDERS,
  };

  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--help" || a === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (a === "--lib") {
      libDir = requireValue(args, "--lib");
      continue;
    }
    if (a === "--print") {
      const v = requireValue(args, "--print");
      if (!["user-data", "per-boot", "b64", "all"].includes(v)) {
        throw new Error(`--print must be user-data|per-boot|b64|all, got: ${v}`);
      }
      print = v as typeof print;
      continue;
    }
    if (a === "--out") {
      out = requireValue(args, "--out");
      continue;
    }
    if (a === "--json") {
      const p = requireValue(args, "--json");
      const raw = fs.readFileSync(p, "utf-8");
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const key of USER_DATA_PLACEHOLDER_KEYS) {
        if (obj[key] !== undefined && obj[key] !== null) {
          placeholders[key] = String(obj[key]);
        }
      }
      continue;
    }
    if (a === "--bucket") {
      placeholders.BUCKET_NAME = requireValue(args, "--bucket");
      continue;
    }
    if (a === "--hosted-zone-id") {
      placeholders.HOSTED_ZONE_ID = requireValue(args, "--hosted-zone-id");
      continue;
    }
    if (a === "--fqdn") {
      placeholders.FQDN = requireValue(args, "--fqdn");
      continue;
    }
    if (a === "--port") {
      placeholders.MINECRAFT_PORT = requireValue(args, "--port");
      continue;
    }
    if (a === "--volume-id") {
      placeholders.VOLUME_ID = requireValue(args, "--volume-id");
      continue;
    }
    throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }

  return { libDir, print, out, placeholders };
}

function requireValue(args: string[], flag: string): string {
  const v = args.shift();
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return v;
}

function main(): void {
  const { libDir, print, out, placeholders } = parseArgs(process.argv.slice(2));

  for (const name of [path.join(libDir, "per-boot.sh"), path.join(libDir, "user-data.sh")]) {
    if (!fs.existsSync(name)) {
      throw new Error(`Missing template file: ${name}`);
    }
  }

  const bundle = buildUserDataBundle({
    templatesDir: libDir,
    placeholders,
  });

  const sections: Record<string, string> = {
    "user-data": bundle.userDataScript,
    "per-boot": bundle.perBootScript,
    b64: bundle.perBootBase64 + "\n",
  };

  let text: string;
  if (print === "all") {
    text = [
      "########## user-data.sh (rendered) ##########",
      bundle.userDataScript,
      "",
      "########## per-boot.sh (rendered) ##########",
      bundle.perBootScript,
      "",
      "########## per-boot base64 ##########",
      bundle.perBootBase64,
      "",
    ].join("\n");
  } else {
    text = sections[print];
  }

  if (out) {
    fs.writeFileSync(out, text, "utf-8");
    process.stderr.write(`Wrote ${print} (${text.length} bytes) -> ${out}\n`);
  } else {
    process.stdout.write(text);
  }
}

main();
