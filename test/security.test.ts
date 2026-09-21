import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What this repository and its package will never do.
 *
 * crawlmeter runs inside other people's servers, and a package that reaches
 * that far is worth attacking. These tests fix the promises in SECURITY.md so
 * that a change breaking one of them fails CI instead of shipping: no code
 * evaluation, no child processes, no undeclared network or filesystem access,
 * no install scripts, no secrets in the tree, and a CI that cannot be turned
 * against the repository.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".test-build", ".git", "coverage"]);

function files(dir: string, skip = SKIP): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skip.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, skip) : [path];
  });
}

const name = (path: string): string => relative(ROOT, path).split("\\").join("/");

/** Source and build: what runs on a user's server. */
const SHIPPED = [...files(join(ROOT, "src")), ...files(join(ROOT, "dist"), new Set())]
  .filter((path) => /\.(ts|js)$/.test(path) && !path.endsWith(".d.ts"))
  .map((path) => ({ name: name(path), text: readFileSync(path, "utf8") }));

/** Code only: comments may describe what the code must never do. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the code that ships", () => {
  it("finds both the source and the build", () => {
    expect(SHIPPED.some((file) => file.name === "src/index.ts")).toBe(true);
    expect(SHIPPED.some((file) => file.name === "dist/index.js")).toBe(true);
  });

  it("never evaluates code or starts processes", () => {
    const forbidden: Array<[string, RegExp]> = [
      ["eval", /\beval\s*\(/],
      ["new Function", /\bnew\s+Function\s*\(/],
      ["node:vm", /["'](node:)?vm["']/],
      ["child_process", /["'](node:)?child_process["']/],
      ["worker_threads", /["'](node:)?worker_threads["']/],
      ["process.binding", /\bprocess\.(binding|dlopen)\b/],
      ["require", /\brequire\s*\(/],
    ];
    const hits = SHIPPED.flatMap((file) =>
      forbidden.filter(([, pattern]) => pattern.test(code(file.text))).map(([label]) => `${label} in ${file.name}`),
    );
    expect(hits).toEqual([]);
  });

  it("never writes, deletes or renames files itself", () => {
    // The SQLite store writes through node:sqlite, at the path the site owner
    // chose. Nothing else touches the disk.
    const writes = /\b(writeFile|appendFile|createWriteStream|unlink|rmSync|rmdir|rename|chmod|chown|symlink|copyFile|mkdir)\w*\s*\(/;
    expect(SHIPPED.filter((file) => writes.test(code(file.text))).map((file) => file.name)).toEqual([]);
  });

  it("opens network connections only where the README says it does", () => {
    // fetch: the operator-published IP lists. node:dns: reverse DNS. The x402
    // facilitator is reached through @x402/core, loaded only in enforce mode.
    const allowed: Record<string, RegExp> = {
      fetch: /^(src\/detect\/ipRanges\.ts|dist\/detect\/ipRanges\.js)$/,
      dns: /^(src\/detect\/rdns\.ts|dist\/detect\/rdns\.js)$/,
    };
    // Matched as a module specifier: "http" is also just a protocol name.
    const raw = /(\bfrom\s*|\bimport\s*\(\s*)["'](node:)?(net|tls|http|https|http2|dgram)["']|\bXMLHttpRequest\b|\bWebSocket\b/;

    const hits: string[] = [];
    for (const file of SHIPPED) {
      const text = code(file.text);
      if (/\bfetch\s*\(|globalThis\.fetch\b/.test(text) && !allowed.fetch!.test(file.name)) hits.push(`fetch in ${file.name}`);
      if (/["'](node:)?dns(\/promises)?["']/.test(text) && !allowed.dns!.test(file.name)) hits.push(`dns in ${file.name}`);
      if (raw.test(text)) hits.push(`raw socket in ${file.name}`);
    }
    expect(hits).toEqual([]);
  });

  it("imports modules by variable only in the files that must", () => {
    // A variable specifier hides a dependency from review and from bundlers.
    // Each of these is an optional peer or a Node builtin, named in the file.
    const allowed = new Set([
      "src/payment/x402.ts",
      "src/store/postgres.ts",
      "src/store/sqlite.ts",
      "dist/payment/x402.js",
      "dist/store/postgres.js",
      "dist/store/sqlite.js",
    ]);
    const dynamic = /\bimport\s*\(\s*[^"'`\s)]/;
    expect(
      SHIPPED.filter((file) => dynamic.test(code(file.text)) && !allowed.has(file.name)).map((file) => file.name),
    ).toEqual([]);
  });
});

describe("the package", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    bundleDependencies?: unknown;
    bundledDependencies?: unknown;
  };

  it("runs nothing when it is installed", () => {
    // Install scripts are how most npm malware runs. A user installing
    // crawlmeter gets files, and nothing executes until they import it.
    const lifecycle = ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare", "prepublish"];
    expect(Object.keys(pkg.scripts ?? {}).filter((script) => lifecycle.includes(script))).toEqual([]);
  });

  it("bundles no third-party code", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.bundleDependencies ?? pkg.bundledDependencies).toBeUndefined();
  });

  it("locks every dev dependency to the public npm registry", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { resolved?: string; integrity?: string; link?: boolean }>;
    };
    const suspicious = Object.entries(lock.packages)
      .filter(([path, entry]) => path !== "" && !entry.link)
      .filter(([, entry]) => !entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity)
      .map(([path]) => path);
    expect(suspicious).toEqual([]);
  });
});

describe("the repository", () => {
  const TRACKED = files(ROOT)
    .filter((path) => statSync(path).size < 2_000_000)
    .map((path) => ({ name: name(path), text: readFileSync(path, "utf8") }));

  it("contains no credentials", () => {
    const patterns: Array<[string, RegExp]> = [
      ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ["hex private key", /\b0x[0-9a-fA-F]{64}\b/],
      ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
      ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
      ["npm token", /\bnpm_[A-Za-z0-9]{30,}/],
      ["Slack token", /\bxox[abpors]-[A-Za-z0-9-]{10,}/],
      ["Stripe live key", /\b(sk|rk)_live_[A-Za-z0-9]{10,}/],
      ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
      ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ];
    const hits = TRACKED.flatMap((file) =>
      patterns.filter(([, pattern]) => pattern.test(file.text)).map(([label]) => `${label} in ${file.name}`),
    );
    expect(hits).toEqual([]);
  });

  it("puts passwords in URLs only for hosts that do not exist", () => {
    // Test fixtures use connection strings to prove the password is redacted.
    // They must point at hosts that can never be real.
    const urls = TRACKED.flatMap((file) =>
      [...file.text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:[^\s@"'`]+@([^\s/:"'`]+)/gi)].map(
        (match) => ({ file: file.name, host: match[1]! }),
      ),
    );
    const fake = /^(localhost|127\.0\.0\.1|host|db\.example\.com|[\w.-]+\.(example|test|invalid))$/;
    expect(urls.filter((url) => !fake.test(url.host)).map((url) => `${url.host} in ${url.file}`)).toEqual([]);
  });

  it("contains no personal email address", () => {
    // Contact goes through GitHub. Placeholder domains and the bot address in
    // commit trailers are fine.
    const allowed = /@([\w.-]+\.)?(example\.(com|org)|users\.noreply\.github\.com|anthropic\.com)$|^git@github\.com$/i;
    const hits = TRACKED.flatMap((file) =>
      [...file.text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g)]
        .map((match) => match[0])
        .filter((address) => !allowed.test(address))
        .map((address) => `${address} in ${file.name}`),
    );
    expect(hits).toEqual([]);
  });

  it("ignores the files that must never be committed", () => {
    const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
    for (const pattern of [".env", ".env.*", "*.db", "*.db-wal", "*.db-shm", "*.sqlite", "*.tgz", ".npmrc", "*.pem", "*.key"]) {
      expect(ignored, pattern).toContain(pattern);
    }
    const present = TRACKED.map((file) => file.name).filter((file) =>
      /(^|\/)(\.env(\..*)?|\.npmrc)$|\.(db|db-wal|db-shm|sqlite3?|tgz|pem|key|p12|pfx)$/.test(file) &&
      !file.endsWith(".env.example"),
    );
    expect(present).toEqual([]);
  });
});

describe("continuous integration", () => {
  const workflows = files(join(ROOT, ".github", "workflows")).map((path) => ({
    name: name(path),
    text: readFileSync(path, "utf8"),
  }));

  it("finds the workflows", () => {
    expect(workflows.map((each) => each.name)).toContain(".github/workflows/ci.yml");
  });

  it("pins every action to a full commit, not a tag that can be moved", () => {
    const uses = workflows.flatMap((each) => [...each.text.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]!));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((action) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(action))).toEqual([]);
  });

  it("gives every workflow a read-only token", () => {
    for (const each of workflows) {
      expect(each.text, each.name).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
      expect(each.text, each.name).not.toMatch(/:\s*write\b|write-all/);
    }
  });

  it("never runs untrusted pull request code with repository secrets", () => {
    for (const each of workflows) {
      expect(each.text, each.name).not.toMatch(/pull_request_target|workflow_run/);
      expect(each.text, each.name).not.toMatch(/\$\{\{\s*secrets\./);
    }
  });

  it("installs without running dependency scripts, and leaves no token on disk", () => {
    for (const each of workflows) {
      const installs = [...each.text.matchAll(/run:\s*(npm (ci|install|i)\b.*)/g)].map((match) => match[1]!);
      for (const install of installs) expect(install, each.name).toContain("--ignore-scripts");
      if (each.text.includes("actions/checkout@")) expect(each.text, each.name).toMatch(/persist-credentials:\s*false/);
    }
  });
});
