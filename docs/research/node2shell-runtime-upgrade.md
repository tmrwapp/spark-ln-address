# Node2Shell runtime upgrade

## Decision

Target **Node.js 24.22.1** for production and declare the supported project range as `>=24.22.1 <25`.

Node 24 is preferable to the smaller Node 22 jump because both patched releases are available now, but Node 24 remains supported until **2028-04-30** while Node 22 ends support on **2027-04-30**. Node 20 reached end of life on **2026-04-30** and must not remain the production target.

## Security basis

Node.js classifies **CVE-2026-111497** as a high-severity out-of-bounds write in its bundled Brotli decoder. Malformed Brotli input processed through `node:zlib` can corrupt memory and may permit remote code execution.

The October 21, 2026 Node.js security release provides these fixed builds:

- Node.js 22.23.4
- Node.js 24.22.1
- Node.js 26.12.1

The advisory explicitly states that end-of-life release lines should be treated as affected. Updating npm packages alone cannot remediate a flaw in the runtime's bundled native Brotli decoder.

## Compatibility evidence

The repository currently uses:

| Component | Installed version | Declared Node requirement | Node 24 assessment |
| --- | ---: | --- | --- |
| NestJS core | 10.4.20 | No engine constraint in the package | Must be verified by build and tests |
| NestJS CLI | 10.4.9 | `>=16.14` | Permitted |
| Prisma CLI | 6.18.0 | `>=18.18` | Permitted |
| Prisma Client | 6.18.0 | `>=18.18` | Permitted |
| Jest | 29.7.0 | `^14.15.0 || ^16.10.0 || >=18.0.0` | Permitted |
| TypeScript | 5.9.3 | `>=14.17` | Permitted |
| PM2 | 7.x operator installation | `>=18.0.0` | Permitted; deployment must verify the interpreter |

Engine ranges are admission checks, not proof of behavioral compatibility. Approval therefore requires a clean install, Prisma generation, build, unit tests, and the production ESM/crypto smoke test on exactly Node 24.22.1.

## Repository implications

- Change `package.json` engines from Node 20 to `>=24.22.1 <25`.
- Pin the development and operator baseline in `.nvmrc`.
- Align `@types/node` with Node 24 and regenerate only the explainable lockfile entries.
- Update installation and README prerequisites to name the exact patched baseline.
- Make the offline production-loader test comment runtime-neutral.
- Keep historical verification notes unchanged when they accurately describe the runtime used at that time.
- PM2 has `watch: false`; deployment requires an explicit restart after rebuilding.
- Because PM2 does not declare an interpreter in `ecosystem.config.cjs`, operators must start or restart it from the intended Node 24 environment and verify the application interpreter.

## Primary sources

1. [Node.js: October 21, 2026 security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) — CVE description, affected lines, fixed releases, and EOL guidance.
2. [Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) — Node 20, 22, and 24 lifecycle dates.
3. [Node.js releases](https://nodejs.org/en/about/previous-releases) — current status and latest releases for each line.
4. [Prisma Client 6.18.0 package metadata](https://github.com/prisma/prisma/blob/6.18.0/packages/client/package.json) — `node >=18.18` engine requirement.
5. Repository-installed package metadata — exact resolved versions and engine declarations used in the compatibility table.

## Verification status

Security and declared-engine compatibility are established. Behavioral verification on Node 24.22.1 is tracked separately and must pass before the upgrade is considered complete.
