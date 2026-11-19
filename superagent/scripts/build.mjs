import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true })

const typescript = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const declarations = spawnSync(process.execPath, [typescript, '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist'], { stdio: 'inherit' })
if (declarations.error) throw declarations.error
if (declarations.status !== 0) process.exit(declarations.status ?? 1)

const entryPoints = ['index', 'storage', 'commands', 'postgres-storage', 'sqlite-worker', 'cli', 'session-persistence', 'session-persistence-postgres', 'remote-device', 'client-access', 'client-gateway', 'profile', 'session-reader', 'watchdog', 'watchdog-process', 'watchdog-cli', 'product-watchdog', 'browser-host', 'credential-import-host', 'supervisor', 'supervisor-session', 'config-instructions', 'worker-mcp-tool', 'worker-mcp-calls', 'product-memory', 'product-usage'].map(name => `src/${name}.ts`).filter(existsSync)
if (entryPoints.length) await build({ entryPoints, outdir: 'dist', platform: 'node', target: 'node22', format: 'esm', bundle: true, splitting: true, packages: 'external' })
