/**
 * Render `lib/user-data.sh` + `lib/per-boot.sh` so you can inspect the exact
 * shell that would run on first boot (without synthesizing the stack).
 *
 * Usage:
 *   npm run render-user-data
 *   npm run render-user-data -- --print per-boot
 *   npm run render-user-data -- --out /tmp/user-data.rendered.sh
 */
import * as fs from "fs";
import * as path from "path";
import { buildUserDataBundle } from "../lib/build-user-data";

const REPO_LIB = path.join(__dirname, "..", "lib");

function usage(): string {
  return `render-user-data — expand lib/user-data.sh and lib/per-boot.sh

Options:
  --lib DIR          Template directory (default: ${REPO_LIB})
  --print TARGET     user-data | per-boot | b64 | all   (default: user-data)
  --out FILE         Write selected output to FILE instead of stdout
  --help             Show this text
`;
}

function parseArgs(argv: string[]): {
  libDir: string;
  print: "user-data" | "per-boot" | "b64" | "all";
  out?: string;
} {
  let libDir = REPO_LIB;
  let print: "user-data" | "per-boot" | "b64" | "all" = "user-data";
  let out: string | undefined;

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
    throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }

  return { libDir, print, out };
}

function requireValue(args: string[], flag: string): string {
  const v = args.shift();
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return v;
}

function main(): void {
  const { libDir, print, out } = parseArgs(process.argv.slice(2));

  for (const name of [
    path.join(libDir, "per-boot.sh"),
    path.join(libDir, "user-data.sh"),
  ]) {
    if (!fs.existsSync(name)) {
      throw new Error(`Missing template file: ${name}`);
    }
  }

  const { userDataScript } = buildUserDataBundle({ templatesDir: libDir });
  const perBootScript = fs.readFileSync(
    path.join(libDir, "per-boot.sh"),
    "utf-8"
  );
  const perBootBase64 = Buffer.from(perBootScript).toString("base64");

  let text: string;
  if (print === "all") {
    text = [
      "########## user-data.sh (rendered) ##########",
      userDataScript,
      "",
      "########## per-boot.sh ##########",
      perBootScript,
      "",
      "########## per-boot base64 ##########",
      perBootBase64,
      "",
    ].join("\n");
  } else if (print === "per-boot") {
    text = perBootScript;
  } else if (print === "b64") {
    text = perBootBase64 + "\n";
  } else {
    text = userDataScript;
  }

  if (out) {
    fs.writeFileSync(out, text, "utf-8");
    process.stderr.write(`Wrote ${print} (${text.length} bytes) -> ${out}\n`);
  } else {
    process.stdout.write(text);
  }
}

main();
